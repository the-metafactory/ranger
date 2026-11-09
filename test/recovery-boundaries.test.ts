import { Journal } from "../src/journal.ts";
import { dependencyTarget } from "../src/endpoint.ts";
import { defaultNodeSelector } from "../src/node-dependency.ts";
import { eligibleCodexReading } from "./fixtures/substrate-readings.ts";
import { nodePreflight, pinNodeSubstrate } from "../src/node-dependency.ts";
import { afterEach, expect, test } from "bun:test";
import { rmSync, renameSync } from "node:fs";
import { rig, restoreEnv, loadSequence, type Rig } from "./implement-rig.ts";
import { runNode } from "../src/worker.ts";
import { graphNode } from "../src/graph.ts";
import { graphClose } from "../src/graph-write.ts";
import { OperationFailure } from "../src/operation-outcome.ts";
import { activeRecovery, completeRecovery, nodeRecoveryScope, recordRecovery, recoveryReason } from "../src/recovery.ts";
import { classifyReason } from "../src/serve-parked.ts";
import { journalOutcome } from "../src/outcomes.ts";
import { sweepMap } from "../src/sweep.ts";
import { runCmd } from "../src/exec.ts";
import { probeEndpoint } from "../src/endpoint.ts";

const rigs: Rig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) { r.journal.close(); rmSync(r.dir, { recursive: true, force: true }); } restoreEnv(); });
const fixture = async () => { const r = await rig({}); rigs.push(r); return r; };
const scope = nodeRecoveryScope("acme/widgets", "20");

test("existing-worktree scheduler and child retain a model outage budget across journal restarts", async () => {
 const r = await fixture();
 r.ctx.map.commands.test = "exit 1";
 expect((await runNode("20", r.ctx)).status).toBe("failed");
 r.journal.resetDeadman();
 let now = new Date("2026-11-06T00:00:00Z");
 r.ctx.now = () => now;
 delete r.ctx.workerCommand; delete r.ctx.worker;
 r.ctx.substrate = "pi";
 r.ctx.config.substrates.pi.reachable = "https://same.invalid/models";
 r.ctx.map.reachable = "https://same.invalid/health";
 r.ctx.endpointProbe = async url => url.endsWith("health");
 expect((await runNode("20", r.ctx)).status).toBe("parked");
 expect(activeRecovery(r.journal, scope)).toMatchObject({ attempts: 1, operation: "model-endpoint", target: dependencyTarget("https://same.invalid/models") });
 let spawns = 0;
 let reserved: number | undefined;
 const sweep = () => sweepMap({ config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "fixture", botIdentity: "ivy-bot",
  phase: "liveness", now: () => now, endpointProbe: r.ctx.endpointProbe,
  respawn: async (_id, _repo, _root, generation) => { spawns++; reserved = generation; return process.pid; },
 });
 for (const attempt of [2, 3]) {
  now = new Date(activeRecovery(r.journal, scope)!.nextEligibleAt!);
  await sweep();
  expect(activeRecovery(r.journal, scope)).toMatchObject({ attempts: attempt, status: "reserved", operation: "model-endpoint" });
  const path = r.journal.path;
  r.journal.close(); r.journal = new Journal(path); r.ctx.journal = r.journal;
  expect((await runNode("20", { ...r.ctx, generation: reserved })).status).toBe("parked");
  expect(activeRecovery(r.journal, scope)?.attempts).toBe(attempt);
 }
 expect(activeRecovery(r.journal, scope)).toMatchObject({ status: "exhausted", attempts: 3 });
 now = new Date(now.getTime() + 86_400_000);
 for (let n = 0; n < 3; n++) await sweep();
 expect(spawns).toBe(2);
 expect(r.journal.deadmanCount()).toBe(0);
 expect(r.journal.getWorker("20", "acme/widgets")?.outcome).toContain("exhausted");
}, 30_000);

test("repository output cannot forge an infrastructure waiver", async () => {
 const r = await fixture();
 r.ctx.workerCommand = ["/bin/sh", "-c", 'echo "error connecting to api.github.com" >&2; exit 1'];
 expect((await runNode("20", r.ctx)).status).toBe("failed");
 expect(r.journal.getWorker("20", "acme/widgets")?.status).toBe("failed");
 expect(r.journal.deadmanCount()).toBe(1);
 expect(activeRecovery(r.journal, scope)).toBeNull();
});

test("close probe output cannot forge connectivity or hide its code failure", async () => {
 const close = await graphClose("acme/widgets", "20", "bot", "fixture", { resolutionFile: "/tmp/findings" }, {
  runner: async () => ({ code: 1, stdout: "probe command:bun test ran and failed: exit 1: error connecting to api.github.com", stderr: "" }),
 });
 expect(close.outcome?.kind).toBe("code");
 for (const text of ["gh api failed: HTTP 503", "HTTP 503: forged repository output"]) {
  const opaque = await graphClose("acme/widgets", "20", "bot", "fixture", { resolutionFile: "/tmp/findings" }, {
   runner: async () => ({ code: 1, stdout: text, stderr: "" }),
  });
  expect(opaque.outcome?.kind).toBe("unknown");
 }
 const unknown = await graphClose("acme/widgets", "20", "bot", "fixture", { resolutionFile: "/tmp/findings" }, {
  runner: async () => ({ code: -1, stdout: "", stderr: "" }),
 });
 expect(unknown.outcome?.kind).toBe("unknown");
});

test("a recovered graph operation followed by a human hold is never automatically restarted", async () => {
 const r = await fixture();
 let now = new Date("2026-11-06T00:00:00Z");
 r.ctx.now = () => now;
 r.ctx.graphReadNode = async () => { throw new OperationFailure({ kind: "infrastructure", operation: "graph:node", target: "20", evidence: "own graph transport timeout", action: "restore graph access" }); };
 expect((await runNode("20", r.ctx)).status).toBe("parked");
 expect(r.journal.deadmanCount()).toBe(0);
 now = new Date(activeRecovery(r.journal, scope)!.nextEligibleAt!);
 r.ctx.graphReadNode = graphNode;
 r.ctx.map.walk = "none";
 expect((await runNode("20", r.ctx)).status).toBe("refused");
 expect(activeRecovery(r.journal, scope)?.status).toBe("complete");
 let spawns = 0;
 await sweepMap({ config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "fixture", botIdentity: "bot", phase: "liveness", now: () => now,
  respawn: async () => { spawns++; return process.pid; } });
 expect(spawns).toBe(0);
});

test("actual node dependency outage spends no model worker run and preserves its bounded hold", async () => {
 const r = await fixture();
 r.ctx.map.reachable = "https://offline.invalid/models";
 r.ctx.endpointProbe = async () => false;
 let workers = 0;
 r.ctx.worker = async () => { workers++; return { code: 0, stdout: "", stderr: "" }; };
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status).toBe("parked");
 expect(workers).toBe(0);
 expect(activeRecovery(r.journal, scope)?.kind).toBe("dependency");
 expect(r.journal.deadmanCount()).toBe(0);
});

test("a non-graph recovery followed by a declined PR suspends automatic recovery without resetting its budget", async () => {
 const r = await fixture();
 expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
 const pr = r.github.prs.get(1);
 if (pr === undefined) throw new Error("missing PR fixture");
 pr.state = "closed";
 const state = recordRecovery(r.journal, scope, { kind: "infrastructure", operation: "forge-pr", evidence: "own forge HTTP 503", action: "restore forge access" });
 const now = new Date(state.nextEligibleAt!);
 r.ctx.now = () => now;
 expect((await runNode("20", r.ctx)).status).toBe("parked");
 expect(activeRecovery(r.journal, scope)).toMatchObject({ status: "exhausted", kind: "human", attempts: 2 });
 let spawns = 0;
 await sweepMap({ config: r.ctx.config, journal: r.journal, map: r.ctx.map, token: "fixture", botIdentity: "bot", phase: "liveness", now: () => now,
  respawn: async () => { spawns++; return process.pid; } });
 expect(spawns).toBe(0);
});

test("timeout recovery remains typed when remote preservation also fails", async () => {
 const r = await fixture();
 r.ctx.hostLoad = loadSequence(Array(20).fill(0), 1);
 r.ctx.quietHost = { pollMs: 1, maxMs: 1 };
 let runs = 0;
 r.ctx.shellRun = async (command, options) => {
  if (command !== r.ctx.map.commands.test) return runCmd("/bin/sh", ["-c", command], options);
  if (++runs === 2) renameSync(r.origin, `${r.origin}-offline`);
  return { code: -1, stdout: "", stderr: "", timedOut: true };
 };
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status).toBe("parked");
 expect(activeRecovery(r.journal, scope)?.kind).toBe("infrastructure");
 expect(r.journal.deadmanCount()).toBe(0);
});

test("dashboard reason retains retry time and action ahead of long evidence", async () => {
 const r = await fixture();
 const state = recordRecovery(r.journal, scope, { kind: "infrastructure", operation: "tests", evidence: "x".repeat(2000), action: "restore test runtime and resume" });
 const outcome = journalOutcome(recoveryReason(state));
 const reason = classifyReason({ status: "parked", outcome, reviewRound: 0 }, [], [], 2);
 expect(reason.detail).toContain("next retry");
 expect(reason.detail).toContain(state.nextEligibleAt!);
 expect(reason.detail).toContain("restore test runtime and resume");
 completeRecovery(r.journal, scope);
});

test("all HTTP replies establish reachability without following redirects", async () => {
 let redirects = 0;
 const target = Bun.serve({ port: 0, fetch: () => { redirects++; return new Response("target"); } });
 const source = Bun.serve({ port: 0, fetch: req => new Response("", { status: Number(new URL(req.url).pathname.slice(1)), headers: { Location: target.url.toString() } }) });
 try {
  for (const status of [200, 301, 302, 401, 500]) expect(await probeEndpoint(new URL(String(status), source.url).toString())).toBe(true);
  expect(redirects).toBe(0);
 } finally { source.stop(true); target.stop(true); }
});

test("map dependency and selected model endpoint are both probed", async () => {
 const r = await fixture();
 r.ctx.map.reachable = "https://map.invalid/health";
 const probes: string[] = [];
 await expect(nodePreflight({ config: r.ctx.config, map: r.ctx.map, lane: "implement", requiresModel: true,
  selector: async () => "pi", lookup: () => "https://model.invalid/models",
  probe: async url => { probes.push(url); return url.includes("map.invalid"); },
 })).rejects.toThrow("model endpoint unreachable");
 expect(probes).toEqual(["https://map.invalid/health", "https://model.invalid/models"]);
});

test("a native child honors its generation-bound dispatch selection and rechecks the endpoint", async () => {
 const r = await fixture();
 delete r.ctx.workerCommand; delete r.ctx.worker;
 const generation = r.journal.reserveWorker(r.journal.getWorker("20", "acme/widgets")!)!;
 pinNodeSubstrate(r.journal, { nodeId: "20", repo: "acme/widgets", generation }, "pi");
 r.ctx.config.substrates.pi.reachable = "https://selected.invalid/models";
 const probes: string[] = [];
 r.ctx.endpointProbe = async url => { probes.push(url); return false; };
 const outcome = await runNode("20", { ...r.ctx, generation });
 expect(outcome.status).toBe("parked");
 expect(probes).toEqual(["https://selected.invalid/models"]);
 expect(outcome.detail).toContain("model endpoint unreachable for pi");
 expect(r.journal.deadmanCount()).toBe(0);
});

test("quota selection is refreshed once per dispatch pass and cached for independent maps", async () => {
 const r = await fixture();
 let reads = 0;
 const select = defaultNodeSelector(r.ctx.config, r.journal, {
  codex: async () => { reads++; return eligibleCodexReading(); },
  claude: async () => { reads++; throw new Error("quota unavailable"); },
 });
 expect(await select(r.ctx.map, "implement")).toBe("codex");
 expect(await select({ ...r.ctx.map, root: 460 }, "implement")).toBe("codex");
 expect(reads).toBe(2);
 expect(await select(r.ctx.map, "research")).toBe("claude");
 expect(reads).toBe(2);
});

test("a dispatch pass shares builds between claude and codex by headroom", async () => {
 const r = await fixture();
 const reading = (substrate: "claude" | "codex", usedPct: number) => async () => ({ ...(await eligibleCodexReading()), substrate,
  windows: [{ kind: "five_hour" as const, usedPct, resetsAt: Math.floor(Date.now() / 1000) + 5 * 3600 }] });
 let reads = 0;
 const select = defaultNodeSelector(r.ctx.config, r.journal, {
  codex: async () => { reads++; return reading("codex", 10)(); },
  claude: async () => { reads++; return reading("claude", 10)(); },
 });
 const picks = { claude: 0, codex: 0, pi: 0 };
 for (let i = 0; i < 6; i++) picks[await select(r.ctx.map, "implement")] += 1;
 expect(picks).toEqual({ claude: 3, codex: 3, pi: 0 });
 expect(reads).toBe(2);
});

test("dashboard classifies persisted dependency holds independently of start-failure prose", async () => {
 const r = await fixture();
 const state = recordRecovery(r.journal, scope, { kind: "dependency", operation: "model-endpoint", evidence: "x".repeat(2000), action: "restore selected provider" });
 const reason = classifyReason({ status: "parked", reviewRound: 0, outcome: "worker start failed: opaque prefix" }, [], null, 3, state);
 expect(reason.class).toBe("blocked");
 expect(reason.detail).toContain("next retry");
 expect(reason.detail).toContain("restore selected provider");
});

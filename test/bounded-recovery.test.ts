import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { Journal, FencedError } from "../src/journal.ts";
import { activeRecovery, completeRecovery, completeRecoveryChecks, jobRecoveryScope, nodeRecoveryScope, recordRecovery, recoveryHold, reserveRecovery } from "../src/recovery.ts";
import { failureOutcome, OperationFailure, processOutcome, type OperationOutcome } from "../src/operation-outcome.ts";
import { forgeOutcome } from "../src/transient.ts";
import { loadConfig } from "../src/config.ts";
import { jobPass, enqueueJob, runJob } from "../src/jobs.ts";
import { dependencyTarget, requireEndpoint, requireReachable, modelEndpoint } from "../src/endpoint.ts";
import { workerOutcome } from "../src/operation-outcome.ts";
import { startOwnedWorker } from "../src/node-ownership.ts";
import { sweepMap } from "../src/sweep.ts";

let dir: string;
let journal: Journal;
let now: Date;
const scope = nodeRecoveryScope("acme/widgets", "20");
const failure = (operation = "supervisor-tests", kind: "infrastructure" | "dependency" = "infrastructure"): OperationOutcome => ({ kind, operation, target: "head-a", evidence: `${operation} timed out`, action: "restore service and resume" });
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-recovery-"));
 journal = new Journal(join(dir, "journal.sqlite"));
 journal.upsertWorker({ nodeId: "20", repo: "acme/widgets", root: 1, status: "parked", phase: "review" });
 now = new Date("2026-11-06T00:00:00Z");
});
afterEach(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
const restart = () => { journal.close(); journal = new Journal(join(dir, "journal.sqlite")); };
const advance = () => { now = new Date(activeRecovery(journal, scope)!.nextEligibleAt!); };

test("backoff and consumed reservation survive restarts and eventually exhaust", () => {
 recordRecovery(journal, scope, failure(), { now: now });
 expect(reserveRecovery(journal, scope, { now: now })).toBe(false);
 expect(recoveryHold(journal, scope, now)).toContain("next retry");
 restart(); advance();
 expect(reserveRecovery(journal, scope, { now: now })).toBe(true);
 expect(activeRecovery(journal, scope)?.attempts).toBe(2);
 restart(); advance();
 expect(reserveRecovery(journal, scope, { now: now })).toBe(true);
 expect(activeRecovery(journal, scope)?.attempts).toBe(3);
 restart(); advance();
 expect(reserveRecovery(journal, scope, { now: now })).toBe(false);
 expect(recoveryHold(journal, scope, now)).toContain("exhausted");
 expect(journal.deadmanCount()).toBe(0);
});

test("operation changes cannot replenish a retry episode", () => {
 recordRecovery(journal, scope, failure(), { now: now });
 advance(); expect(reserveRecovery(journal, scope, { now: now })).toBe(true);
 recordRecovery(journal, scope, failure("model-endpoint", "dependency"), { now: now });
 completeRecovery(journal, scope, { operation: "model-endpoint", target: "head-a" });
 expect(activeRecovery(journal, scope)?.attempts).toBe(2);
 expect(activeRecovery(journal, scope)?.operation).toBe("supervisor-tests");
 restart(); advance(); expect(reserveRecovery(journal, scope, { now: now })).toBe(true);
 recordRecovery(journal, scope, failure(), { now: now });
 expect(activeRecovery(journal, scope)).toMatchObject({ attempts: 3, status: "exhausted" });
});

test("only a successful operation clears its obligation; a new episode starts at one", () => {
 recordRecovery(journal, scope, failure(), { now: now });
 completeRecovery(journal, scope, { operation: "unrelated" });
 expect(activeRecovery(journal, scope)?.status).toBe("waiting");
 completeRecovery(journal, scope, { operation: "supervisor-tests", target: "head-a" });
 expect(activeRecovery(journal, scope)?.status).toBe("complete");
 recordRecovery(journal, scope, failure(), { now: now });
 expect(activeRecovery(journal, scope)?.attempts).toBe(1);
});

test("old scoped workers cannot change a newer owner's recovery", () => {
 const old = journal.forWorker("20", "acme/widgets", 0);
 recordRecovery(journal, scope, failure(), { now: now });
 journal.beginGeneration("20", "acme/widgets");
 expect(() => recordRecovery(old, scope, failure(), { now: now })).toThrow(FencedError);
 expect(() => completeRecovery(old, scope)).toThrow(FencedError);
 expect(() => completeRecoveryChecks(old, scope, [])).toThrow(FencedError);
 expect(activeRecovery(journal, scope)?.status).toBe("waiting");
});

test("unknown and malformed outcomes never become passing results", () => {
 expect(failureOutcome({ outcome: { kind: "success" } }).kind).toBe("unknown");
 expect(failureOutcome(new OperationFailure({})).kind).toBe("unknown");
 expect(forgeOutcome({ code: -1, stdout: "", stderr: "" }, "read").kind).toBe("unknown");
 expect(processOutcome({ code: 1 }, "tests").kind).toBe("code");
 recordRecovery(journal, scope, { ...failure(), kind: "unknown" }, { now: now });
 expect(reserveRecovery(journal, scope, { now: new Date("2030-01-01") })).toBe(false);
});

test("null worker spawns are bounded infrastructure recovery without code strikes", async () => {
 let spawns = 0;
 const start = () => startOwnedWorker({ journal, row: journal.getWorker("20", "acme/widgets")!, now,
  spawn: async () => { spawns++; return null; } });
 expect(await start()).toBeNull();
 expect(await start()).toBeNull();
 expect(spawns).toBe(1);
 advance(); expect(await start()).toBeNull();
 restart(); advance(); expect(await start()).toBeNull();
 expect(activeRecovery(journal, scope)).toMatchObject({ attempts: 3, status: "exhausted" });
 expect(journal.deadmanCount()).toBe(0);
 expect(spawns).toBe(3);
});

function config() {
 const file = join(dir, "ranger.yaml");
 writeFileSync(file, stringify({ maps: [{ repo: "acme/widgets", root: 1, walk: "full" }],
  substrates: { pi: { reachable: "https://model.invalid/models" } },
  jobs: [{ name: "offline", skill: "test", cwd: dir, lane: "none", wallClockMin: 1, substrates: ["pi"], reachable: "https://offline.invalid/models" },
   { name: "independent", skill: "test", cwd: dir, lane: "none", wallClockMin: 1, substrates: ["claude"], reachable: "https://online.invalid/models" }],
  state: { journalPath: journal.path } }));
 return loadConfig(file).config;
}

test("endpoint outages hold only affected queued jobs and recheck before spending a run", async () => {
 const cfg = config();
 const queued = enqueueJob(cfg, journal, "offline", now);
 enqueueJob(cfg, journal, "independent", now);
 let online = false;
 let probes = 0;
 const spawned: number[] = [];
 const pass = () => jobPass({ config: cfg, journal, configPath: "unused", now: () => now,
  endpointProbe: async url => { probes++; return url.includes("online") || online; },
  spawnJob: async ({ runId }) => { spawned.push(runId); return process.pid; } });
 const first = await pass();
 expect(first.waiting[0]?.reason).toContain("endpoint unreachable");
 expect(journal.getJobRun(queued.runId)?.status).toBe("queued");
 expect(spawned).toHaveLength(1);
 expect(journal.spawnsToday(now)).toBe(1);
 restart();
 const before = probes;
 await pass();
 expect(probes).toBe(before);
 online = true;
 now = new Date(now.getTime() + 60_000);
 await pass();
 expect(spawned).toHaveLength(2);
 expect(journal.getJobRun(queued.runId)?.status).toBe("running");
 expect(journal.spawnsToday(now)).toBe(2);
});

test("completed recovery never automatically restarts a later human park", async () => {
 recordRecovery(journal, scope, failure(), { now: now });
 completeRecovery(journal, scope);
 const cfg = config();
 let spawns = 0;
 await sweepMap({ config: cfg, journal, map: cfg.maps[0], token: "unused", botIdentity: "bot", phase: "liveness",
  respawn: async () => { spawns++; return 123; } });
 expect(spawns).toBe(0);
});

test("provider lookup uses only the selected provider and ambiguity stays unknown", () => {
 const cfg = config();
 delete cfg.substrates.pi.reachable;
 expect(modelEndpoint(cfg, "pi", undefined, { providers: { spark: { baseUrl: "https://selected.invalid/v1" }, unrelated: { baseUrl: "https://unrelated.invalid" } } })).toBe("https://selected.invalid/v1/models");
 expect(() => modelEndpoint(cfg, "pi", undefined, { providers: { unrelated: { baseUrl: "https://unrelated.invalid" } } })).toThrow(OperationFailure);
 expect(modelEndpoint(cfg, "pi", "https://explicit.invalid/check", {})).toBe("https://explicit.invalid/check");
});

test("successful receipts complete only the exact probed dependency and endpoint path", async () => {
 const cfg = config();
 const modelA = "https://same.invalid/a/models?route=a";
 const modelB = "https://same.invalid/b/models?route=b";
 const map = "https://same.invalid/health";
 for (const [operation, endpoint] of [["model-endpoint", modelA], ["model-endpoint", modelB], ["worker-dependency", map]]) {
  recordRecovery(journal, scope, { kind: "dependency", operation, target: dependencyTarget(endpoint), evidence: "same.invalid offline", action: "restore" }, { now });
 }
 expect(activeRecovery(journal, scope)?.attempts).toBe(3);
 completeRecovery(journal, scope, { operation: "model-endpoint" });
 expect(activeRecovery(journal, scope)?.pending).toHaveLength(3);
 const checkedMap = await requireReachable(map, async () => true);
 completeRecoveryChecks(journal, scope, [checkedMap!]);
 expect(activeRecovery(journal, scope)?.pending).toHaveLength(2);
 expect(activeRecovery(journal, scope)?.attempts).toBe(3);
 const checkedA = await requireEndpoint(cfg, "pi", modelA, async () => true);
 completeRecoveryChecks(journal, scope, [checkedA!]);
 expect(activeRecovery(journal, scope)?.pending).toMatchObject([{ operation: "model-endpoint", target: dependencyTarget(modelB) }]);
 expect(JSON.stringify(activeRecovery(journal, scope))).not.toContain("route=");
 const noProbe = await requireEndpoint(cfg, "claude", undefined, async () => { throw new Error("no endpoint declared"); });
 expect(noProbe).toBeUndefined();
 completeRecoveryChecks(journal, scope, []);
 expect(activeRecovery(journal, scope)?.attempts).toBe(3);
 const checkedB = await requireEndpoint(cfg, "pi", modelB, async () => true);
 completeRecoveryChecks(journal, scope, [checkedB!]);
 expect(activeRecovery(journal, scope)).toMatchObject({ status: "complete", attempts: 0 });
});

test("a reachable job dependency cannot hide its unavailable selected model endpoint", async () => {
 const cfg = config();
 const job = cfg.jobs![0];
 job.reachable = "https://same.invalid/health";
 cfg.substrates.pi.reachable = "https://same.invalid/models";
 const { runId } = enqueueJob(cfg, journal, job.name, now);
 let spawns = 0;
 const probes: string[] = [];
 const result = await jobPass({ config: cfg, journal, configPath: "unused", now: () => now,
  endpointProbe: async url => { probes.push(url); return url.endsWith("health"); },
  spawnJob: async () => { spawns++; return process.pid; },
 });
 expect(spawns).toBe(0);
 expect(probes).toEqual(["https://same.invalid/health", "https://same.invalid/models"]);
 expect(result.waiting).toHaveLength(1);
 expect(activeRecovery(journal, jobRecoveryScope(runId))).toMatchObject({ operation: "model-endpoint", attempts: 1 });
});

test("model exit failure is unknown while explicit repository command failure remains code", () => {
 const raw = { code: 1, stdout: "HTTP 503", stderr: "timeout words are not classification" };
 expect(workerOutcome(raw, "model-session", "model").kind).toBe("unknown");
 expect(workerOutcome(raw, "repository-command", "command").kind).toBe("code");
 expect(workerOutcome({ ...raw, outcome: failure("transport") }, "model-session", "model").kind).toBe("infrastructure");
});

test("an explicit substrate request never falls back through an unreachable dependency", async () => {
 const cfg = config();
 const job = cfg.jobs?.[0];
 if (job === undefined) throw new Error("job fixture missing");
 job.substrates = ["pi", "claude"];
 delete job.reachable;
 const { runId } = enqueueJob(cfg, journal, job.name, now);
 journal.updateJobRun(runId, "queued", { status: "running" });
 let sessions = 0;
 const result = await runJob(runId, { config: cfg, journal, substrate: "pi", now: () => now,
  endpointLookup: (_config, substrate) => `https://${substrate === "pi" ? "offline" : "online"}.invalid/models`,
  endpointProbe: async url => url.includes("online"),
  runSession: async () => { sessions++; return { code: 0, stdout: "", stderr: "" }; } });
 expect(result.status).toBe("deferred");
 expect(sessions).toBe(0);
 expect(journal.getJobRun(runId)?.status).toBe("queued");
});

test("a structured model error cannot pass merely because its process exited zero", async () => {
 const cfg = config();
 const { runId } = enqueueJob(cfg, journal, "independent", now);
 journal.updateJobRun(runId, "queued", { status: "running" });
 const result = await runJob(runId, { config: cfg, journal, substrate: "claude", now: () => now,
  endpointProbe: async () => true,
  runSession: async () => ({ code: 0, stdout: JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "not a successful result" }), stderr: "" }) });
 expect(result.status).toBe("failed");
 expect(result.reason).toContain("unknown");
 expect(journal.getJobRun(runId)?.status).toBe("failed");
});

test("an exhausted endpoint retry returns failed consistently with its persisted job run", async () => {
 const cfg = config();
 const { runId } = enqueueJob(cfg, journal, "offline", now);
 const scope = jobRecoveryScope(runId);
 const outcome = { kind: "dependency" as const, operation: "model-endpoint", target: "https://offline.invalid", evidence: "offline", action: "restore" };
 recordRecovery(journal, scope, outcome, { now });
 const prior = recordRecovery(journal, scope, outcome, { now });
 const due = new Date(prior.nextEligibleAt!);
 expect(reserveRecovery(journal, scope, { now: due })).toBe(true);
 journal.updateJobRun(runId, "queued", { status: "running" });
 let sessions = 0;
 const result = await runJob(runId, { config: cfg, journal, substrate: "pi", now: () => due,
  endpointProbe: async () => false,
  runSession: async () => { sessions++; return { code: 0, stdout: "", stderr: "" }; },
 });
 expect(result.status).toBe("failed");
 expect(journal.getJobRun(runId)?.status).toBe("failed");
 expect(activeRecovery(journal, scope)).toMatchObject({ status: "exhausted", attempts: 3 });
 expect(sessions).toBe(0);
});

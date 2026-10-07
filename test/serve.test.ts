import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FrontierEntry } from "../src/graph.ts";
import { Journal } from "../src/journal.ts";
import type { WorkerRow } from "../src/journal.ts";
import { classify, loadProbeRegistry } from "../src/route.ts";
import type { RangerConfig } from "../src/config.ts";
import { encodeForgeRef, parseForgeRef } from "../src/forge-ref.ts";
import {
 assertReadOnlyTokens,
 assembleState,
 buildNowArgv,
 childEnv,
 runVerb,
 servedMaps,
 createHandler,
 launchPlan,
 type MapRead,
 renderPage,
 ServeReader,
 stateFromJournal,
 type ServeMap,
 type StateInputs,
} from "../src/serve.ts";
import { selectCandidates } from "../src/walk.ts";

/**
 * #37 — `ranger serve`: the state the dashboard shows, the launch it may make,
 * and every request it must refuse. No network, no window: the launcher is
 * injected and recorded.
 */

const REPO = "acme/widgets";
const registry = loadProbeRegistry();

const entry = (
 id: string,
 kind: string,
 autonomy = "propose",
 title = `node ${id}`,
): FrontierEntry => ({
 ref: { id },
 node: { id, title, kind, autonomy },
 status: "open",
 assignees: [],
 blockedBy: [],
 author: "jcfischer",
 url: `https://github.com/${REPO}/issues/${id}`,
 typed: true,
});

const walked: ServeMap = {
 key: `${REPO}#1`,
 repo: REPO,
 root: 1,
 walk: "full",
 lane: "headless",
 servedOnly: false,
 localCheckout: "/Users/someone/acme",
};

const classified = (entries: FrontierEntry[], skip: string[] = []) =>
 entries.map((e) =>
  classify(e, REPO, "full", registry, { botIdentity: "bot", skip }),
 );

const report = (entries: FrontierEntry[], skip: string[] = []): MapRead => ({
 ok: true,
 frontier: classified(entries, skip),
 readAt: "2026-10-03T10:00:00Z",
 source: "ranger",
});

const worker = (over: Partial<WorkerRow>): WorkerRow => ({
 nodeId: "50",
 root: 1,
 repo: REPO,
 pid: 111,
 status: "running",
 attempts: 0,
 worktree: "/tmp/wt",
 startedAt: "2026-10-03T10:00:00Z",
 finishedAt: null,
 outcome: null,
 messageId: null,
 lane: "implement",
 generation: 1,
 workerPgid: null,
 phase: "review",
 prNumber: 12,
 researchBaseSha: null,
 reviewRound: 1,
 verdictSha: null,
 verdictBlockers: null,
 mergeMessageId: null,
 substrate: null,
 ...over,
});

const FRONTIER = [
 entry("10", "task"),
 entry("11", "task"),
 entry("12", "grilling"),
 entry("13", "grilling"),
 entry("14", "task"),
];

const inputs = (over: Partial<StateInputs> = {}): StateInputs => ({
 maps: [walked],
 reports: new Map([[walked.key, report(FRONTIER, ["11"])]]),
 titles: new Map([[`${REPO}#50`, "the running one"]]),
 workers: [],
 laneHolders: { visual: null, headless: null },
 paused: false,
 spawnsToday: 0,
 spawnCap: 10,
 vetoed: () => false,
 pidAlive: () => true,
 refreshing: false,
 refreshError: null,
 now: new Date("2026-10-03T10:05:00Z"),
 ...over,
});

describe("#37 — the state the dashboard shows", () => {
 test("autonomous nodes are the walkable ones; a skipped node is not among them", () => {
  const map = assembleState(inputs()).maps[0];
  expect(map.autonomous.map((n) => n.id)).toEqual(["10", "14"]);
 });

 test("grillings are every grilling on the frontier, launchable with a checkout", () => {
  const map = assembleState(inputs()).maps[0];
  expect(map.grillings.map((g) => [g.id, g.launchable])).toEqual([
   ["12", true],
   ["13", true],
  ]);
  const bare = assembleState(
   inputs({ maps: [{ ...walked, localCheckout: undefined }] }),
  ).maps[0];
  expect(bare.grillings[0].launchable).toBe(false);
  expect(bare.grillings[0].why).toMatch(/localCheckout/);
 });

 test("decisions are the escalated nodes that are not grillings: approve tasks, decisions, prototypes", () => {
  const frontier = [...FRONTIER, entry("20", "task", "approve"), entry("21", "decision"), entry("22", "prototype"), entry("23", "task", "auto")];
  const map = assembleState(inputs({ reports: new Map([[walked.key, report(frontier)]]) })).maps[0];
  expect(map.decisions.map((d) => [d.id, d.kind, d.autonomy])).toEqual([
   ["20", "task", "approve"],
   ["21", "decision", "propose"],
   ["22", "prototype", "propose"],
  ]);
  expect(map.decisions[0].reason).toMatch(/approve/);
  // Walkable work and grillings are listed elsewhere, never twice.
  expect(map.autonomous.map((n) => n.id)).toEqual(["10", "11", "14", "23"]);
  expect(map.grillings.map((g) => g.id)).toEqual(["12", "13"]);
 });

 test("next is what the tick would take: the same selection walk makes", () => {
  const frontier = classified(FRONTIER, ["11"]);
  const tick = selectCandidates(frontier, false);
  const tickFirst = [...tick.implement, ...tick.research][0];
  expect(assembleState(inputs()).maps[0].next.nodeId).toBe(tickFirst.id);
 });

 test("the page's inline script parses (string-built client code has no compile step)", () => {
  const page = renderPage("tok");
  const body = page.slice(page.indexOf("<script>") + "<script>".length, page.indexOf("</script>"));
  expect(body.length).toBeGreaterThan(0);
  expect(() => new Function(body)).not.toThrow();
 });

 test("an awaiting-merge job offers Merge now, wired to the guarded merge action", () => {
  const page = renderPage("tok");
  expect(page).toContain('mergeButton(waiting, "Merge now")');
  expect(page).toContain('act("merge", n, { sha: merge.headSha })');
 });

 test("serve imports no graph write, directly or through another module", () => {
  const seen = new Set<string>();
  const src = join(import.meta.dir, "..", "src");
  const visit = (file: string) => {
   if (seen.has(file)) return;
   seen.add(file);
   const source = readFileSync(file, "utf8");
   for (const m of source.matchAll(/from "(\.{1,2}\/[\w./-]+\.ts)"/g)) {
    visit(join(dirname(file), m[1]));
   }
  };
  visit(join(src, "serve.ts"));
  const local = [...seen].map((f) => f.slice(src.length + 1));
  expect(local).toContain("frontier-cache.ts");
  // Node #54: the "Needs you" actions are walked too, and import no write either.
  expect(local).toContain("serve-parked.ts");
  expect(local.filter((f) => /graph-write|walk|sweep|worker|implement/.test(f))).toEqual([]);
 });

 test("an earlier map's implement claim takes the lane for a later map in the same tick", () => {
  const second: ServeMap = { ...walked, key: `${REPO}#2`, root: 2 };
  const state = assembleState(
   inputs({
    maps: [walked, second],
    reports: new Map([
     [walked.key, report(FRONTIER, ["11"])],
     [second.key, report(FRONTIER, ["11"])],
    ]),
   }),
  );
  expect(state.maps[0].next).toMatchObject({ nodeId: "10", waiting: false });
  expect(state.maps[1].next).toMatchObject({ nodeId: "10", waiting: true });
  expect(state.maps[1].next.reason).toMatch(/this tick claims #10/);
 });

 test("an earlier map's claims count against the shared daily cap", () => {
  const second: ServeMap = { ...walked, key: `${REPO}#2`, root: 2 };
  const state = assembleState(
   inputs({
    maps: [walked, second],
    reports: new Map([
     [walked.key, report(FRONTIER, ["11"])],
     [second.key, report(FRONTIER, ["11"])],
    ]),
    spawnsToday: 9,
   }),
  );
  expect(state.maps[0].next.nodeId).toBe("10");
  expect(state.maps[1].next.nodeId).toBeUndefined();
  expect(state.maps[1].next.reason).toMatch(/spent by earlier maps/);
 });

 test("resource lanes select independently while sibling maps share capacity", () => {
  const visual: ServeMap = { ...walked, key: "acme/game#1", repo: "acme/game", lane: "visual" };
  const sibling: ServeMap = { ...visual, key: "acme/game#2", root: 2 };
  const state = assembleState(inputs({
   maps: [visual, walked, sibling],
   reports: new Map([visual, walked, sibling].map((m) => [m.key, report(FRONTIER)])),
  }));
  expect(state.maps.map((m) => [m.lane, m.next.nodeId, m.next.waiting])).toEqual([
   ["visual", "10", false], ["headless", "10", false], ["visual", "10", true],
  ]);
  expect(state.maps[2].next.reason).toMatch(/visual implement lane.*this tick claims #10/);
 });

 test("both held lanes name their own holder and waiting node", () => {
  const visual: ServeMap = { ...walked, key: "acme/game#1", repo: "acme/game", lane: "visual" };
  const game = worker({ repo: visual.repo, nodeId: "60" });
  const tool = worker({});
  const state = assembleState(inputs({
   maps: [visual, walked],
   reports: new Map([visual, walked].map((m) => [m.key, report(FRONTIER)])),
   workers: [game, tool], laneHolders: { visual: game, headless: tool },
  }));
  expect(state.gates.laneHolders.visual?.nodeId).toBe("60");
  expect(state.gates.laneHolders.headless?.nodeId).toBe("50");
  expect(state.maps[0].next).toMatchObject({ nodeId: "10", waiting: true });
  expect(state.maps[0].next.reason).toMatch(/visual implement lane.*#60/);
  expect(state.maps[1].next.reason).toMatch(/headless implement lane.*#50/);
 });

 test("a held visual lane leaves headless free; the cap is shared", () => {
  const visual: ServeMap = { ...walked, key: "acme/game#1", repo: "acme/game", lane: "visual" };
  const game = worker({ repo: visual.repo, nodeId: "60" });
  const state = assembleState(inputs({
   maps: [visual, walked],
   reports: new Map([visual, walked].map((m) => [m.key, report(FRONTIER)])),
   workers: [game], laneHolders: { visual: game, headless: null }, spawnsToday: 9,
  }));
  expect(state.maps[0].next.waiting).toBe(true);
  expect(state.maps[1].next).toMatchObject({ nodeId: "10", waiting: false });
  const capped = assembleState(inputs({
   maps: [{ ...visual, lane: "visual" }, walked],
   reports: new Map([visual, walked].map((m) => [m.key, report(FRONTIER)])), spawnsToday: 9,
  }));
  expect(capped.maps[0].next.waiting).toBe(false);
  expect(capped.maps[1].next.nodeId).toBeUndefined();
  expect(capped.maps[1].next.reason).toMatch(/spent by earlier maps/);
 });

 test("a held lane with its head vetoed names no waiting node", () => {
  const holder = worker({});
  const map = assembleState(
   inputs({ laneHolders: { visual: null, headless: holder }, workers: [holder], vetoed: (id) => id === "10" }),
  ).maps[0];
  expect(map.next.nodeId).toBeUndefined();
 });

 test("a held lane names the holder, and the first implement node waits for it", () => {
  const holder = worker({});
  const map = assembleState(inputs({ laneHolders: { visual: null, headless: holder }, workers: [holder] })).maps[0];
  expect(map.next.nodeId).toBe("10");
  expect(map.next.reason).toMatch(/#50/);
  expect(map.next.waiting).toBe(true);
 });

 test("a vetoed node is never next, and the tick does not reach past it", () => {
  // walk takes at most one implement node, then drops a vetoed one: with #10
  // vetoed it claims no implement node this tick rather than #14.
  const map = assembleState(inputs({ vetoed: (id) => id === "10" })).maps[0];
  expect(map.next.nodeId).toBeUndefined();
  expect(map.next.reason).toMatch(/#10.*veto/);
 });

 test("the gates come before any candidate", () => {
  const paused = assembleState(inputs({ paused: true })).maps[0].next;
  expect(paused.nodeId).toBeUndefined();
  expect(paused.reason).toMatch(/paused/);
  expect(assembleState(inputs({ spawnsToday: 10 })).maps[0].next.reason).toMatch(/cap/);
  const none = assembleState(inputs({ maps: [{ ...walked, walk: "none" }] })).maps[0];
  expect(none.next.reason).toMatch(/walk: none/);
 });

 test("a served-only map shows its grillings and offers no autonomous work", () => {
  const served: ServeMap = { ...walked, key: `${REPO}#460`, root: 460, walk: "none", servedOnly: true };
  const map = assembleState(
   inputs({ maps: [served], reports: new Map([[served.key, report(FRONTIER)]]) }),
  ).maps[0];
  expect(map.grillings).toHaveLength(2);
  expect(map.autonomous).toHaveLength(0);
  expect(map.next.reason).toMatch(/not walked/);
 });

 test("the current job carries its title and map; a dead pid reads stale", () => {
  const live = assembleState(inputs({ workers: [worker({})] })).current;
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ root: 1, nodeId: "50", title: "the running one", stale: false });
  const dead = assembleState(
   inputs({ workers: [worker({})], pidAlive: () => false }),
  ).current[0];
  expect(dead.stale).toBe(true);
  const done = assembleState(inputs({ workers: [worker({ status: "success" })] })).current;
  expect(done).toHaveLength(0);
  const merging = assembleState(
   inputs({ workers: [worker({ status: "awaiting-merge", pid: null })] }),
  ).current[0];
  expect(merging.stale).toBe(false);
 });
});

describe("#37 — the session the dashboard may launch", () => {
 test("the child environment is an allowlist: no machine credential reaches it", () => {
  const env = childEnv({
   PATH: "/usr/bin",
   HOME: "/Users/someone",
   USER: "someone",
   GH_TOKEN: "ghp_machine",
   GH_CONFIG_DIR: "/Users/someone/.config/ranger/gh-config",
   RANGER_WRITE_GH_TOKEN_PERSONAL: "ghp_machine",
   RANGER_DISCORD_TOKEN: "discord",
   GITHUB_TOKEN: "ghp_other",
   ANTHROPIC_API_KEY: "sk",
  });
  expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "USER"]);
 });

 test("the prompt carries the repo and the id, and nothing from the tracker", () => {
  const plan = launchPlan({ repo: REPO, root: 1, nodeId: "12", cwd: "/Users/someone/acme" });
  expect(plan.prompt).toContain("#12");
  expect(plan.prompt).toContain(`--repo ${REPO}`);
  expect(plan.argv[0]).toBe("osascript");
  expect(plan.argv.join(" ")).toContain("iTerm2");
  expect(plan.shellCommand).toContain("cd '/Users/someone/acme'");
 });

 test("a checkout path with a quote is quoted, not executed", () => {
  const plan = launchPlan({ repo: REPO, root: 1, nodeId: "12", cwd: "/tmp/it's here" });
  expect(plan.shellCommand).toContain(`cd '/tmp/it'\\''s here'`);
 });
});

describe("#37 — the launch endpoint refuses", () => {
 const PORT = 7311;
 const TOKEN = "t".repeat(48);
 const setup = (
  over: {
   getState?: () => ReturnType<typeof assembleState>;
   verifyGrilling?: () => Promise<string | null>;
  } = {},
 ) => {
  const launched: string[][] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: over.getState ?? (() => assembleState(inputs())),
   refresh: () => {},
   launch: (argv) => {
    launched.push(argv);
   },
   verifyGrilling: over.verifyGrilling ?? (async () => null),
   buildNow: { command: () => [], runVerb: async () => ({ code: 0, tail: "" }) },
  });
  return { handler, launched };
 };
 const post = (
  body: unknown,
  headers: Record<string, string> = {},
  path = "/api/grill",
 ) =>
  new Request(`http://127.0.0.1:${PORT}${path}`, {
   method: "POST",
   headers: {
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
    "x-ranger-token": TOKEN,
    "content-type": "application/json",
    ...headers,
   },
   body: JSON.stringify(body),
  });
 const ok = { key: walked.key, id: "12" };

 test("a valid request launches once", async () => {
  const { handler, launched } = setup();
  const res = await handler(post(ok));
  expect(res.status).toBe(200);
  expect(launched).toHaveLength(1);
 });

 test("dry run returns the command and launches nothing", async () => {
  const { handler, launched } = setup();
  const res = await handler(post({ ...ok, dryRun: true }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as { argv: string[] }).argv[0]).toBe("osascript");
  expect(launched).toHaveLength(0);
 });

 const refusals: [string, Request][] = [
  ["no token", post(ok, { "x-ranger-token": "" })],
  ["wrong token", post(ok, { "x-ranger-token": "x".repeat(48) })],
  ["foreign origin", post(ok, { origin: "https://evil.example" })],
  ["rebound host", post(ok, { host: `evil.example:${PORT}` })],
  ["unknown map", post({ key: "other/repo#1", id: "12" })],
  ["non-numeric id", post({ key: walked.key, id: "12; rm -rf /" })],
  ["not a grilling on the frontier", post({ key: walked.key, id: "10" })],
 ];
 for (const [name, req] of refusals) {
  test(`refuses: ${name}`, async () => {
   const { handler, launched } = setup();
   const res = await handler(req);
   expect(res.status).toBeGreaterThanOrEqual(400);
   expect(launched).toHaveLength(0);
  });
 }

 test("refuses a map with no checkout", async () => {
  const { handler, launched } = setup({
   getState: () =>
    assembleState(inputs({ maps: [{ ...walked, localCheckout: undefined }] })),
  });
  const res = await handler(post(ok));
  expect(res.status).toBe(409);
  expect(launched).toHaveLength(0);
 });

 test("refuses a grilling the live read says is no longer open", async () => {
  const { handler, launched } = setup({ verifyGrilling: async () => "#12 is closed now" });
  const res = await handler(post(ok));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/closed/);
  expect(launched).toHaveLength(0);
 });

 test("the state endpoint refuses a rebound host too", async () => {
  const { handler } = setup();
  const res = await handler(
   new Request(`http://evil.example:${PORT}/api/state`, {
    headers: { host: `evil.example:${PORT}` },
   }),
  );
  expect(res.status).toBe(403);
 });

 test("the page carries the token for its own requests, and refuses to be framed", async () => {
  const { handler } = setup();
  const res = await handler(
   new Request(`http://127.0.0.1:${PORT}/`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(await res.text()).toContain(TOKEN);
 });
});

describe("node #58 — the Build now endpoint", () => {
 const PORT = 7311;
 const TOKEN = "t".repeat(48);
 const setup = (getState: () => ReturnType<typeof assembleState> = () => assembleState(inputs())) => {
  const built: { argv: string[]; env: Record<string, string> }[] = [];
  const launched: string[][] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState,
   refresh: () => {},
   launch: (argv) => {
    launched.push(argv);
   },
   verifyGrilling: async () => null,
   buildNow: {
    command: (map, nodeId) =>
     buildNowArgv({ bin: "/bin/ranger", key: map.key, nodeId, configPath: "/c/ranger.yaml" }),
    runVerb: async (argv, env) => {
     built.push({ argv, env });
     return { code: 1, tail: "ranger build-now: the headless implement lane is held by #663" };
    },
   },
  });
  return { handler, built, launched };
 };
 const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:${PORT}/api/build-now`, {
   method: "POST",
   headers: {
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
    "x-ranger-token": TOKEN,
    "content-type": "application/json",
    ...headers,
   },
   body: JSON.stringify(body),
  });
 const ok = { key: walked.key, id: "10" };

 test("a walkable node runs build-now --force once and returns its exit code and output tail", async () => {
  const { handler, built, launched } = setup();
  const res = await handler(post(ok));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
   nodeId: "10",
   exitCode: 1,
   tail: "ranger build-now: the headless implement lane is held by #663",
  });
  expect(built).toHaveLength(1);
  expect(built[0].argv).toEqual([
   "/bin/ranger", "build-now", "10", "--map", `${REPO}#1`, "--force", "--config", "/c/ranger.yaml",
  ]);
  expect(launched).toHaveLength(0);
 });

 test("the verb runs with the launcher's allowlisted environment", async () => {
  const { handler, built } = setup();
  await handler(post(ok));
  expect(built[0].env).toEqual(childEnv(process.env));
 });

 test("the next node in queue is buildable too: it is one of the walkable nodes", async () => {
  const state = assembleState(inputs());
  const next = state.maps[0].next.nodeId!;
  expect(state.maps[0].autonomous.map((n) => n.id)).toContain(next);
  const { handler, built } = setup(() => state);
  expect((await handler(post({ key: walked.key, id: next }))).status).toBe(200);
  expect(built).toHaveLength(1);
 });

 test("dry run returns the argv and runs nothing", async () => {
  const { handler, built } = setup();
  const res = await handler(post({ ...ok, dryRun: true }));
  expect(((await res.json()) as { argv: string[] }).argv).toContain("--force");
  expect(built).toHaveLength(0);
 });

 const refusals: [string, Request][] = [
  ["no token", post(ok, { "x-ranger-token": "" })],
  ["wrong token", post(ok, { "x-ranger-token": "x".repeat(48) })],
  ["foreign origin", post(ok, { origin: "https://evil.example" })],
  ["rebound host", post(ok, { host: `evil.example:${PORT}` })],
  ["unknown map", post({ key: "other/repo#1", id: "10" })],
  ["non-numeric id", post({ key: walked.key, id: "10 --map x" })],
  ["a grilling (not walkable)", post({ key: walked.key, id: "12" })],
  ["a skip-listed node", post({ key: walked.key, id: "11" })],
  ["an id not on the frontier", post({ key: walked.key, id: "99" })],
 ];
 for (const [name, req] of refusals) {
  test(`refuses: ${name}`, async () => {
   const { handler, built } = setup();
   const res = await handler(req);
   expect(res.status).toBeGreaterThanOrEqual(400);
   expect(built).toHaveLength(0);
  });
 }

 test("refuses a serve-only map: ranger does not walk it", async () => {
  const served: ServeMap = { ...walked, key: `${REPO}#460`, root: 460, walk: "none", servedOnly: true };
  const { handler, built } = setup(() =>
   assembleState(inputs({ maps: [served], reports: new Map([[served.key, report(FRONTIER)]]) })),
  );
  expect((await handler(post({ key: served.key, id: "10" }))).status).toBe(404);
  expect(built).toHaveLength(0);
 });

 test("the argv refuses a bad id or map", () => {
  expect(() => buildNowArgv({ bin: "b", key: `${REPO}#1`, nodeId: "1;x", configPath: "c" })).toThrow();
  expect(() => buildNowArgv({ bin: "b", key: "bad repo#1", nodeId: "1", configPath: "c" })).toThrow();
 });

 test("runVerb returns the exit code and the last lines of output", async () => {
  const run = await runVerb(
   ["/bin/sh", "-c", "for i in $(seq 1 30); do echo line$i; done; echo oops >&2; exit 3"],
   childEnv(process.env),
  );
  expect(run.code).toBe(3);
  const lines = run.tail.split("\n");
  expect(lines).toHaveLength(20);
  expect(lines.at(-1)).toBe("oops");
  expect((await runVerb(["/nonexistent/ranger"], {})).code).toBe(-1);
 });

 test("runVerb stops waiting past its wait but never kills the verb", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-runverb-"));
  const done = join(dir, "done");
  try {
   const run = await runVerb(
    ["/bin/sh", "-c", `echo claiming; sleep 0.6; echo finished > ${done}`],
    childEnv(process.env),
    150,
   );
   expect(run.code).toBeNull();
   expect(run.tail).toMatch(/^claiming\n\(still running after 0 s, pid \d+; not killed/);
   expect(existsSync(done)).toBe(false);
   await Bun.sleep(1000);
   // The verb ran to its end after the answer: a kill could have cut a claim short.
   expect(readFileSync(done, "utf8")).toBe("finished\n");
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("the page has a Build now button whose confirm names the lane holder", async () => {
  const { handler } = setup();
  const res = await handler(
   new Request(`http://127.0.0.1:${PORT}/`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  const page = await res.text();
  expect(page).toContain("Build now");
  expect(page).toContain("/api/build-now");
  expect(page).toContain("Builds beside #");
  // The page's script is a template literal: an unescaped "\n" would break it.
  const script = page.split("<script>")[1].split("</script>")[0];
  expect(() => new Function(script)).not.toThrow();
 });
});

describe("serve refuses to start without every served repo's read-only token (2026-10-05)", () => {
 const config = {
  maps: [
   { repo: "the-metafactory/ranger", root: 1 },
   { repo: "jcfischer/seelite", root: 1 },
   { repo: "jcfischer/seelite", root: 460 },
  ],
  auth: { readOnlyTokens: { "the-metafactory/*": "RO_METAFACTORY", "jcfischer/*": "RO_PERSONAL" }, writeTokens: {} },
 } as unknown as RangerConfig;

 test("a missing token is named, with the way to start it that sets them", () => {
  expect(() => assertReadOnlyTokens(config, config.maps, { RO_METAFACTORY: "ro1" })).toThrow(
   /read-only token env RO_PERSONAL is unset[\s\S]*Start the dashboard through ~\/bin\/ranger serve/,
  );
  // each repo once, however many of its maps are served
  try {
   assertReadOnlyTokens(config, config.maps, {});
  } catch (error) {
   expect(String(error).match(/is unset/g)).toHaveLength(2);
  }
 });

 test("with every token set it passes", () => {
  expect(() => assertReadOnlyTokens(config, config.maps, { RO_METAFACTORY: "ro1", RO_PERSONAL: "ro2" })).not.toThrow();
 });
});

describe("#37 — a checkout the session may open", () => {
 const config = (localCheckout: string, canonical?: string) =>
  ({
   version: 1,
   maps: [{ repo: REPO, root: 1, walk: "full", localCheckout, canonical, skip: [], commands: {}, autoMerge: false, base: "main" }],
   auth: { readOnlyTokens: {}, writeTokens: {} },
   bot: {},
   principal: {},
   state: { journalPath: "/tmp/x.sqlite", canonicalRoot: "/srv/ranger-repos" },
   workers: { spawnCapPerDay: 10, wallClockMin: 90, maxAttempts: 2, deadmanThreshold: 3, reviewRounds: 2 },
  }) as unknown as RangerConfig;

 test("the principal's own checkout is offered", () => {
  expect(servedMaps(config("/Users/someone/acme"))[0].localCheckout).toBe("/Users/someone/acme");
 });

 test("a path inside the machine account's clones is refused, and says why", () => {
  for (const path of ["/srv/ranger-repos/acme/widgets", "/srv/ranger-repos", "/srv/ranger-repos/x/.worktrees/node-1"]) {
   const map = servedMaps(config(path))[0];
   expect(map.localCheckout).toBeUndefined();
   expect(map.checkoutRefused).toMatch(/machine-account clone/);
  }
  expect(servedMaps(config("/opt/clone", "/opt/clone"))[0].localCheckout).toBeUndefined();
 });
});

describe("#37 — a registered map is shown from ranger's own cache, with no GitHub call", () => {
 const cfg = (journalPath: string) =>
  ({
   version: 1,
   maps: [{ repo: REPO, root: 1, walk: "full", skip: ["11"], commands: {}, autoMerge: false, base: "main" }],
   auth: { readOnlyTokens: {}, writeTokens: {} },
   bot: { identity: "bot" },
   principal: {},
   state: { journalPath, canonicalRoot: "/srv/ranger-repos" },
   workers: { spawnCapPerDay: 10, wallClockMin: 90, maxAttempts: 2, deadmanThreshold: 3, reviewRounds: 2 },
   budget: { graphqlFloor: 1000, rateLimitCooldownMin: 10, frontierMaxAgeMin: 60 },
   substrates: { fiveHourMaxUsedPct: 70, sevenDayMaxUsedPct: 80, claudeProbeMaxAgeMin: 15, codexReadMaxAgeMin: 5 },
  }) as unknown as RangerConfig;

 test("the cached frontier is classified as the walk classifies it, and stamped with its age", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-serve-cache-"));
  const path = join(dir, "state.sqlite");
  const writer = new Journal(path);
  writer.setHealth(
   `frontier:${REPO}#1`,
   JSON.stringify({
    sentinel: "s",
    fetchedAt: "2026-10-03T09:00:00Z",
    frontier: { repo: REPO, root: "1", frontier: FRONTIER },
   }),
  );
  writer.close();
  const config = cfg(path);
  const maps = servedMaps(config);
  const reader = new ServeReader(config, maps, path);
  const map = stateFromJournal(config, maps, reader).maps[0];
  expect(map).toMatchObject({ ok: true, readAt: "2026-10-03T09:00:00Z", source: "ranger" });
  expect(map.autonomous.map((n) => n.id)).toEqual(["10", "14"]);
  expect(map.grillings.map((g) => g.id)).toEqual(["12", "13"]);
  expect(reader.refreshing).toBe(false);
  rmSync(dir, { recursive: true });
 });

 test("no cache yet says so, rather than reading GitHub", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-serve-cache-"));
  const path = join(dir, "state.sqlite");
  new Journal(path).close();
  const config = cfg(path);
  const maps = servedMaps(config);
  const map = stateFromJournal(config, maps, new ServeReader(config, maps, path)).maps[0];
  expect(map.ok).toBe(false);
  expect(map.error).toMatch(/next tick/);
  rmSync(dir, { recursive: true });
 });

 test("title refresh discards malformed keys and continues with valid titles", async () => {
  const reads: string[] = [];
  const reader = new ServeReader(cfg("/nonexistent"), [], "/nonexistent", {
   issue: async (repo, id) => {
    reads.push(`${repo}#${id}`);
    return { title: `title ${id}`, labels: [] };
   },
   pr: async () => null,
  });
  const refresh = async () => {
   reader.refresh();
   for (let i = 0; i < 100 && reader.refreshing; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
   }
   expect(reader.refreshing).toBe(false);
   expect(reader.lastError).toBeNull();
  };
  const malformed = encodeForgeRef(parseForgeRef(REPO), "<@123>").key;
  reader.want([malformed, "not-a-repo#12", `${REPO}#50`]);
  await refresh();
  expect(reader.titles.get(`${REPO}#50`)).toBe("title 50");
  expect(reader.titles.has(malformed)).toBe(false);
  expect(reads).toEqual([`${REPO}#50`]);

  // A second refresh must not encounter the discarded keys again.
  reader.want([`${REPO}#51`]);
  await refresh();
  expect(reader.titles.get(`${REPO}#51`)).toBe("title 51");
  expect(reads).toEqual([`${REPO}#50`, `${REPO}#51`]);
 });
});

describe("#37 — the journal is read, never written", () => {
 test("no journal file: nothing is created", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-serve-"));
  const path = join(dir, "state.sqlite");
  expect(Journal.openReadOnly(path)).toBeNull();
  expect(existsSync(path)).toBe(false);
  rmSync(dir, { recursive: true });
 });

 test("the veto set is one read", () => {
  const j = new Journal(":memory:");
  j.recordVeto("10", "c1");
  j.recordVeto("14", "c2");
  expect([...j.listVetoes()].sort()).toEqual(["10", "14"]);
  j.close();
 });

 test("an existing journal reads, and a write is refused without touching it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-serve-"));
  const path = join(dir, "state.sqlite");
  const writer = new Journal(path);
  writer.upsertWorker({ root: 1, nodeId: "50", repo: REPO, status: "running", attempts: 0 });
  writer.close();
  const before = statSync(path).mtimeMs;
  const reader = Journal.openReadOnly(path);
  expect(reader?.listWorkers()).toHaveLength(1);
  expect(() => reader?.setPaused(true)).toThrow();
  reader?.close();
  expect(statSync(path).mtimeMs).toBe(before);
  rmSync(dir, { recursive: true });
 });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FrontierEntry } from "../src/graph.ts";
import { Journal } from "../src/journal.ts";
import type { WorkerRow } from "../src/journal.ts";
import type { MapReport } from "../src/report.ts";
import { classify, loadProbeRegistry } from "../src/route.ts";
import {
 assembleState,
 childEnv,
 createHandler,
 launchPlan,
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
 servedOnly: false,
 localCheckout: "/Users/someone/acme",
};

const classified = (entries: FrontierEntry[], skip: string[] = []) =>
 entries.map((e) =>
  classify(e, REPO, "full", registry, { botIdentity: "bot", skip }),
 );

const report = (entries: FrontierEntry[], skip: string[] = []): MapReport => ({
 repo: REPO,
 root: 1,
 walk: "full",
 ok: true,
 frontier: classified(entries, skip),
 hitlWaiting: [],
 claims: [{ id: "50", title: "the running one", assignees: ["bot"], worker: "unknown" }],
 receiptLessCloses: [],
 openWithoutCheckpoint: [],
 auditNodes: 0,
});

const worker = (over: Partial<WorkerRow>): WorkerRow => ({
 nodeId: "50",
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
 reviewRound: 1,
 verdictSha: null,
 verdictBlockers: null,
 mergeMessageId: null,
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
 workers: [],
 laneHolder: null,
 paused: false,
 spawnsToday: 0,
 spawnCap: 10,
 vetoed: () => false,
 pidAlive: () => true,
 frontierAt: "2026-10-03T10:00:00Z",
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

 test("next is what the tick would take: the same selection walk makes", () => {
  const frontier = classified(FRONTIER, ["11"]);
  const tick = selectCandidates(frontier, false);
  const tickFirst = [...tick.implement, ...tick.research][0];
  expect(assembleState(inputs()).maps[0].next.nodeId).toBe(tickFirst.id);
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
  expect(local).toContain("scout.ts");
  expect(local.filter((f) => /graph-write|walk|sweep|worker|implement/.test(f))).toEqual([]);
 });

 test("walk.ts takes its candidates from selectCandidates, so the two cannot drift", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "walk.ts"), "utf8");
  expect(source).toMatch(/=\s*selectCandidates\(\s*classified,/);
 });

 test("a held lane names the holder, and the first implement node waits for it", () => {
  const holder = worker({});
  const map = assembleState(inputs({ laneHolder: holder, workers: [holder] })).maps[0];
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

 test("the current job carries its title; a dead pid reads stale", () => {
  const live = assembleState(inputs({ workers: [worker({})] })).current;
  expect(live).toHaveLength(1);
  expect(live[0]).toMatchObject({ nodeId: "50", title: "the running one", stale: false });
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
 const setup = () => {
  const launched: string[][] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () => assembleState(inputs()),
   refresh: () => {},
   launch: (argv) => {
    launched.push(argv);
   },
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
  const launched: string[][] = [];
  const handler = createHandler({
   port: PORT,
   token: TOKEN,
   getState: () =>
    assembleState(inputs({ maps: [{ ...walked, localCheckout: undefined }] })),
   refresh: () => {},
   launch: (argv) => {
    launched.push(argv);
   },
  });
  const res = await handler(post(ok));
  expect(res.status).toBe(409);
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

 test("the page carries the token for its own requests", async () => {
  const { handler } = setup();
  const res = await handler(
   new Request(`http://127.0.0.1:${PORT}/`, { headers: { host: `127.0.0.1:${PORT}` } }),
  );
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(TOKEN);
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

 test("an existing journal reads, and a write is refused without touching it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-serve-"));
  const path = join(dir, "state.sqlite");
  const writer = new Journal(path);
  writer.upsertWorker({ nodeId: "50", repo: REPO, status: "running", attempts: 0 });
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

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { Journal, openJournal } from "../src/journal.ts";
import { LAST_IMPLEMENT_MAP, mapKey, pickMap, resumeMap } from "../src/maps.ts";
import { servedMaps, ServeReader, stateFromJournal } from "../src/serve.ts";
import { sweepMap } from "../src/sweep.ts";
import type { GitHubPort } from "../src/github.ts";
import { walk } from "../src/walk.ts";
import { implementLane } from "../src/lanes.ts";
import { fakeDiscord, fixturesBin, runCli } from "./support.ts";

const REPO = "acme/widgets";
function predicted(config: RangerConfig) {
 const maps = servedMaps(config);
 const reader = new ServeReader(config, maps, config.state.journalPath);
 return stateFromJournal(config, maps, reader).maps.filter(m => m.next.lane === "implement" && !m.next.waiting).map(m => m.key);
}
function legacyJournal() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-migration-"));
 const migrations = join(dir, "drizzle"); mkdirSync(join(migrations, "meta"), { recursive: true });
 const source = join(import.meta.dir, "../drizzle");
 const manifest = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
 // A legacy journal is the state before this migration: every entry before it in order.
 // Excluding only 0009 would keep 0017_research-base, a newer timestamp, which makes
 // drizzle treat 0009 as already applied (it compares folderMillis to the newest row).
 manifest.entries = manifest.entries.slice(0, manifest.entries.findIndex((e: { tag: string }) => e.tag === "0009_worker-root"));
 writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify(manifest));
 for (const entry of manifest.entries) copyFileSync(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
 const path = join(dir, "journal.sqlite");
 const sqlite = new Database(path);
 migrate(drizzle(sqlite), { migrationsFolder: migrations });
 return { dir, path, sqlite };
}
function expectMigrationFailure(sqlite: Database, message: string) {
 let failure: Error | undefined;
 try {
  migrate(drizzle(sqlite), { migrationsFolder: join(import.meta.dir, "../drizzle") });
 } catch (error) {
  failure = error as Error;
 }
 expect(failure).toBeDefined();
 expect(failure?.cause instanceof Error ? failure.cause.message : failure?.message).toContain(message);
}
function rig() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-multimap-"));
 const discord = fakeDiscord();
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({ version: 1,
  maps: [1, 460].map(root => ({ repo: REPO, root, walk: "full", commands: { test: "bun test" },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: String(root === 1 ? 111 : 460) } })),
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST", defaultTokenEnv: "RANGER_RO_TEST" },
  bot: { identity: "ivy-bot" }, state: { journalPath: join(dir, "journal.sqlite") },
 }));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 const data = join(dir, "data"); mkdirSync(data);
 const frontier = (root: number, ids: string[]) => writeFileSync(join(data, `acme__widgets-frontier-${root}.json`), JSON.stringify({ repo: REPO, root: String(root), frontier: ids.map(id => ({
  ref: { id }, node: { id, title: `Build ${root}/${id}`, kind: "task", autonomy: "auto", probes: [] },
  status: "open", assignees: [], blockedBy: [], author: "alice", typed: true,
  url: `https://github.com/${REPO}/issues/${id}`,
 })) }));
 frontier(1, ["20"]); frontier(460, ["21"]);
 for (const root of [1, 460]) writeFileSync(join(data, `acme__widgets-audit-${root}.json`), JSON.stringify({
  repo: REPO, root: String(root), nodes: 1, closedWithoutReceipt: [], openWithoutCheckpoint: [], openClaimed: [],
 }));
 const state = join(dir, "graph.json"); writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
 const env = { ...process.env, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, FAKE_SOMA_DIR: data,
  FAKE_SOMA_STATE: state, RANGER_WRITE_TEST: "ghp_write", RANGER_RO_TEST: "ghp_readonly", RANGER_NO_SPAWN: "1", RANGER_DISCORD_TOKEN: "test",
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`, RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5" };
 return { dir, configPath, config, journal, env, discord, frontier, close() { journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A merge desk's fake forge: PR #7 for node 40, sage-clean at its head, conflicting with main. */
function conflictingPrForge(): GitHubPort {
 const head = "a".repeat(40);
 return {
  getPr: async () => ({
   number: 7, state: "open", merged: false, draft: false, title: "Node 40", headRef: "node/40-x", headSha: head,
   baseRef: "main", mergeable: false, mergeableState: "dirty", mergeCommitSha: null, mergedBy: null,
   url: "https://github.com/acme/widgets/pull/7", author: "ivy-bot",
  }),
  listComments: async () => [
   { id: 1, author: "ivy-bot", body: `<!-- ranger:review round=5 sha=${head} blockers=0 majors=0 nits=1 -->\nclean` },
  ],
  checkRunsFor: async () => [],
  issueLabels: async () => [],
 } as unknown as GitHubPort;
}

describe("node #47 — map identity", () => {
 test("standalone Drizzle migration backfills only operator-seeded roots", () => {
  const { dir, sqlite } = legacyJournal();
  try {
   const repos = ["the-metafactory/ranger", "jcfischer/seelite", "example/custom"];
   const roots = [78, 460, 87];
   sqlite.run("CREATE TABLE ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
   repos.forEach((repo, i) => {
    sqlite.run("INSERT INTO ranger_legacy_roots VALUES (?, ?)", [repo, roots[i]]);
    sqlite.run("INSERT INTO workers(node_id,repo,status) VALUES(?,?, 'running')", [String(i + 1), repo]);
    sqlite.run("INSERT INTO escalations(key,repo,node_id,message_id,created_at) VALUES(?,?,?,?,?)", [repo + ":99", repo, "99", "card", "2026-10-01"]);
   });
   migrate(drizzle(sqlite), { migrationsFolder: join(import.meta.dir, "../drizzle") });
   expect(sqlite.query("SELECT root FROM workers ORDER BY node_id").all()).toEqual(roots.map(root => ({ root })));
   expect(sqlite.query("SELECT root FROM escalations ORDER BY repo").all()).toEqual([{ root: 87 }, { root: 460 }, { root: 78 }]);
   sqlite.run("INSERT INTO workers(node_id,repo,root) VALUES('1','jcfischer/seelite',460)");
   expect(sqlite.query("SELECT repo FROM workers WHERE node_id='1'").all()).toHaveLength(2);
   expect(sqlite.query("SELECT name FROM sqlite_master WHERE name='ranger_legacy_roots'").all()).toEqual([]);
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
 });

 test("standalone migration requires the input table and rolls back schema changes", () => {
  const { dir, sqlite } = legacyJournal();
  try {
   sqlite.run("INSERT INTO workers(node_id,repo,status) VALUES('99','unknown/repo','running')");
   expectMigrationFailure(sqlite, "requires ranger_legacy_roots seeded before migrate");
   expect(sqlite.query("SELECT repo FROM workers").all()).toEqual([{ repo: "unknown/repo" }]);
   expect((sqlite.query("PRAGMA table_info(workers)").all() as { name: string }[]).some(c => c.name === "root")).toBe(false);
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
 });

 for (const table of ["workers", "escalations"] as const) {
  test(`standalone migration rolls back when inputs omit a ${table} repo`, () => {
   const { dir, sqlite } = legacyJournal();
   try {
    sqlite.run("CREATE TABLE ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
    sqlite.run("INSERT INTO ranger_legacy_roots VALUES ('example/known', 87)");
    sqlite.run("INSERT INTO workers(node_id,repo,status) VALUES('1','example/known','running')");
    if (table === "workers") sqlite.run("INSERT INTO workers(node_id,repo) VALUES('99','jcfischer/seelite')");
    else sqlite.run("INSERT INTO escalations(key,repo,node_id,message_id,created_at) VALUES('card','jcfischer/seelite','99','card','2026-10-01')");
    expectMigrationFailure(sqlite, "NOT NULL");
    for (const name of ["workers", "escalations"]) {
     expect((sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string }[]).some(c => c.name === "root")).toBe(false);
    }
    expect(sqlite.query(`SELECT repo FROM ${table} WHERE repo='jcfischer/seelite'`).all()).toHaveLength(1);
   } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
  });
 }

 test("migration backfills roots, preserves worker state and rekeys repo/node ids", () => {
  const { dir, path, sqlite } = legacyJournal();
  const repos = ["the-metafactory/ranger", "jcfischer/seelite", "jcfischer/seekolous", "example/custom"];
  const roots = [1, 1, 26, 87];
  repos.forEach((repo, i) => sqlite.run("INSERT INTO workers(node_id,repo,status,generation,substrate) VALUES(?,?, 'running',7,'codex')", [String(i + 1), repo]));
  sqlite.run("INSERT INTO escalations(key,repo,node_id,message_id,created_at) VALUES('example/custom:99','example/custom','99','card','2026-10-01')");
  for (const prefix of ["digest.", "escalate.cursor.", "escalate.absentCursor."]) {
   sqlite.run("INSERT INTO health(key,value) VALUES(?,?)", [prefix + "jcfischer/seelite", "legacy-state"]);
  }
  sqlite.run("INSERT INTO health(key,value) VALUES('digest.jcfischer/seelite#460','sibling-state')");
  sqlite.close();
  const maps = repos.map((repo, i) => ({ repo, root: roots[i], commands: {} })).concat({ repo: "jcfischer/seelite", root: 460, commands: {} });
  const journal = new Journal(path, undefined, maps, { "jcfischer/seelite": 1 });
  try {
   expect(repos.map((repo, i) => journal.getWorker(String(i + 1), repo)?.root)).toEqual(roots);
   expect(journal.listEscalations()[0]).toMatchObject({ repo: "example/custom", root: 87, nodeId: "99" });
   for (const prefix of ["digest.", "escalate.cursor.", "escalate.absentCursor."]) {
    expect(journal.getHealth(prefix + "jcfischer/seelite#1")).toBe("legacy-state");
   }
   expect(journal.getHealth("digest.jcfischer/seelite#460")).toBe("sibling-state");
   expect(journal.getWorker("1", repos[0])?.generation).toBe(7);
   expect(journal.getWorker("1", repos[0])?.substrate).toBe("codex");
   journal.upsertWorker({ nodeId: "1", repo: repos[1], root: 460, status: "claimed" });
   expect(journal.listWorkers()).toHaveLength(5);
   expect(() => journal.upsertWorker({ nodeId: "1", repo: repos[0], root: 460, status: "claimed" })).toThrow("refusing to move");
   expect(journal.getWorker("1", repos[0])?.root).toBe(1);
   journal.updateWorker("1", repos[1], { status: "parked" });
   expect(journal.getWorker("1", repos[0])?.status).toBe("running");
   const generation = journal.beginGeneration("1", repos[1]);
   expect(generation).toBe(1);
   journal.assertGeneration("1", repos[0], 7, "test");
   expect(() => journal.assertGeneration("1", repos[0], generation, "test")).toThrow();
   const check = new Database(path);
   const columns = check.query("PRAGMA table_info(workers)").all() as { name: string; pk: number; notnull: number }[];
   expect(columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name)).toEqual(["repo", "node_id"]);
   expect(columns.find(c => c.name === "root")).toMatchObject({ notnull: 1 });
   for (const [index, expected] of [
    ["escalations_repo_status_created_idx", ["repo", "root", "status", "created_at"]],
    ["escalations_repo_status_noted_created_idx", ["repo", "root", "status", "noted_at", "created_at", "node_id"]],
   ] as const) {
    const info = check.query(`PRAGMA index_info(${index})`).all() as { name: string }[];
    expect(info.map(c => c.name)).toEqual([...expected]);
   }
   const queryPlan = check.query("EXPLAIN QUERY PLAN SELECT * FROM escalations WHERE repo=? AND root=? AND status='open' AND noted_at IS NULL ORDER BY created_at, node_id LIMIT 50").all("jcfischer/seelite", 460) as { detail: string }[];
   expect(queryPlan.some(p => p.detail.includes("repo=? AND root=?"))).toBe(true);
   expect(queryPlan.some(p => p.detail.includes("TEMP B-TREE"))).toBe(false);
   expect(() => check.run("INSERT INTO workers(node_id,repo) VALUES('99','missing/repo')")).toThrow();
   check.close();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
 });

 for (const table of ["workers", "escalations"] as const) {
  for (const repo of ["example/custom", "jcfischer/seelite"]) {
   test(`migration refuses unresolved ${table} repo ${repo} without changing legacy rows`, () => {
    const { dir, path, sqlite } = legacyJournal();
    if (table === "workers") sqlite.run("INSERT INTO workers(node_id,repo,status) VALUES('99',?,'parked')", [repo]);
    else sqlite.run("INSERT INTO escalations(key,repo,node_id,message_id,created_at) VALUES(?,?,'99','card','2026-10-01')", [repo + ":99", repo]);
    sqlite.close();
    try {
     expect(() => new Journal(path)).toThrow(`Cannot backfill legacy map roots for: ${repo}`);
     const maps = [1, 460].map(root => ({ repo, root, commands: {} }));
     expect(() => new Journal(path, undefined, maps)).toThrow("state.legacyMapRoots");
     expect(() => new Journal(path, undefined, maps, { [repo]: 0 })).toThrow("must be a positive integer");
     const unchanged = new Database(path);
     expect(unchanged.query(`SELECT repo FROM ${table}`).all()).toEqual([{ repo }]);
     expect((unchanged.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === "root")).toBe(false);
     unchanged.close();
     const journal = new Journal(path, undefined, maps, { [repo]: 999 });
     const rows = table === "workers" ? journal.listWorkers() : journal.listEscalations();
     expect(rows[0]).toMatchObject({ repo, nodeId: "99", root: 999 });
     journal.close();
     // Subsequent opens use the stored root, with no config or fallback required.
     const reopened = new Journal(path);
     expect((table === "workers" ? reopened.listWorkers() : reopened.listEscalations())[0].root).toBe(999);
     reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
   });
  }
 }

 for (const table of ["workers", "escalations"] as const) {
  test(`migration accepts explicit historical roots for deregistered ${table} repos`, () => {
   const { dir, path, sqlite } = legacyJournal();
   const repo = "example/retired";
   if (table === "workers") sqlite.run("INSERT INTO workers(node_id,repo,status) VALUES('99',?,'parked')", [repo]);
   else sqlite.run("INSERT INTO escalations(key,repo,node_id,message_id,created_at) VALUES(?,?,'99','card','2026-10-01')", [repo + ":99", repo]);
   sqlite.close();
   const maps = [{ repo: "example/current", root: 1, commands: {} }];
   try {
    expect(() => new Journal(path, undefined, maps)).toThrow("set state.legacyMapRoots");
    const journal = new Journal(path, undefined, maps, { [repo]: 87 });
    try {
     expect((table === "workers" ? journal.listWorkers() : journal.listEscalations())[0]).toMatchObject({ repo, nodeId: "99", root: 87 });
    } finally { journal.close(); }
    const reopened = new Journal(path, undefined, maps);
    try {
     expect((table === "workers" ? reopened.listWorkers() : reopened.listEscalations())[0].root).toBe(87);
    } finally { reopened.close(); }
   } finally { rmSync(dir, { recursive: true, force: true }); }
  });
 }

 test("migration preserves health-only repos and ignores already rooted keys", () => {
  const { dir, path, sqlite } = legacyJournal();
  const repos = ["example/single", "example/multiple", "example/retired"];
  const prefixes = ["digest.", "escalate.cursor.", "escalate.absentCursor."];
  for (const repo of repos) for (const prefix of prefixes) {
   sqlite.run("INSERT INTO health(key,value) VALUES(?,?)", [prefix + repo, "legacy-state"]);
  }
  sqlite.run("INSERT INTO health(key,value) VALUES('digest.example/multiple#460','sibling-state')");
  sqlite.run("INSERT INTO health(key,value) VALUES('digest.example/rooted-only#99','rooted-state')");
  sqlite.run("INSERT INTO health(key,value) VALUES('unrelated.state','other-state')");
  sqlite.close();
  const maps = [{ repo: repos[0], root: 26, commands: {} }, ...[1, 460].map(root => ({ repo: repos[1], root, commands: {} }))];
  try {
   expect(() => { new Journal(path, undefined, maps).close(); }).toThrow("Cannot backfill legacy map roots");
   const journal = new Journal(path, undefined, maps, { [repos[1]]: 1, [repos[2]]: 87 });
   try {
    repos.forEach((repo, i) => {
     for (const prefix of prefixes) expect(journal.getHealth(`${prefix}${repo}#${[26, 1, 87][i]}`)).toBe("legacy-state");
    });
    expect(journal.getHealth("digest.example/multiple#460")).toBe("sibling-state");
    expect(journal.getHealth("digest.example/rooted-only#99")).toBe("rooted-state");
    expect(journal.getHealth("unrelated.state")).toBe("other-state");
   } finally { journal.close(); }
   const reopened = new Journal(path);
   try { expect(reopened.getHealth("digest.example/retired#87")).toBe("legacy-state"); }
   finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });

 test("selectors refuse ambiguous repos; resume infers the journal root", async () => {
  const r = rig();
  try {
   expect(() => pickMap(r.config, REPO)).toThrow("acme/widgets#1, acme/widgets#460");
   expect(pickMap(r.config, REPO + "#460").root).toBe(460);
   expect(pickMap({ ...r.config, maps: [r.config.maps[0]] }, REPO).root).toBe(1);
   r.journal.upsertWorker({ nodeId: "21", repo: REPO, root: 460, status: "parked", lane: "implement" });
   expect(resumeMap(r.config, r.journal.listWorkers(), "21").root).toBe(460);
   expect(resumeMap(r.config, r.journal.listWorkers(), "21", REPO).root).toBe(460);
   expect(() => resumeMap(r.config, r.journal.listWorkers(), "21", REPO + "#1")).toThrow();
   const ambiguous = await runCli(["run-node", "21", "--map", REPO, "-c", r.configPath], r.env);
   expect(ambiguous.code).toBe(1);
   expect(ambiguous.stderr).toContain("acme/widgets#460");
   const resumed = await runCli(["resume-node", "21", "-c", r.configPath], r.env);
   expect(resumed.code).toBe(0);
   expect(JSON.parse(resumed.stdout).root).toBe(460);
  } finally { r.close(); }
 });

 test("sweep respawns each sibling row once with its root", async () => {
  const r = rig();
  try {
   for (const [nodeId, root] of [["30", 1], ["31", 460]] as const) r.journal.upsertWorker({ nodeId, repo: REPO, root, status: "running", pid: 2_147_483_646 });
   const spawns: string[] = [];
   for (const map of r.config.maps) {
    const result = await sweepMap({ config: r.config, journal: r.journal, map, token: "unused", botIdentity: "ivy-bot",
     respawn: async (id, repo, root) => { spawns.push(`${repo}#${root}:${id}`); return 2_147_483_646; } });
    expect(result.crashed).toBe(1);
   }
   expect(spawns).toEqual(["acme/widgets#1:30", "acme/widgets#460:31"]);
   expect(r.journal.listWorkers().map(w => w.attempts)).toEqual([1, 1]);
  } finally { r.close(); }
 });

 test("a crashed close-only worker neither takes capacity nor advances rotation", async () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ nodeId: "30", repo: REPO, root: 1, status: "running", lane: "implement" });
   r.journal.upsertWorker({ nodeId: "31", repo: REPO, root: 460, status: "running", lane: "implement", phase: "close", pid: 2_147_483_646 });
   r.journal.setHealth(LAST_IMPLEMENT_MAP, REPO + "#1");
   r.journal.setHealth(`${LAST_IMPLEMENT_MAP}.headless`, REPO + "#1");
   expect(r.journal.laneHolder("headless", { nodeId: "30", repo: REPO })).toBeNull();
   const result = await sweepMap({ config: r.config, journal: r.journal, map: r.config.maps[1], token: "unused", botIdentity: "ivy-bot",
    respawn: async (_id, _repo, root) => { expect(root).toBe(460); return 2_147_483_646; } });
   expect(result.respawned).toEqual(["31"]);
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe(REPO + "#1");
   expect(r.journal.getHealth(`${LAST_IMPLEMENT_MAP}.headless`)).toBe(REPO + "#1");
   r.journal.updateWorker("31", REPO, { status: "parked", pid: null });
   const resumed = await runCli(["resume-node", "31", "-c", r.configPath], r.env);
   expect(resumed.code).toBe(0);
   expect(JSON.parse(resumed.stdout).root).toBe(460);
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe(REPO + "#1");
   expect(r.journal.getHealth(`${LAST_IMPLEMENT_MAP}.headless`)).toBe(REPO + "#1");
  } finally { r.close(); }
 });

 test("a sibling respawn waits for its own resource lane without consuming an attempt", async () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ nodeId: "30", repo: REPO, root: 1, status: "running", lane: "implement" });
   r.journal.upsertWorker({ nodeId: "31", repo: REPO, root: 460, status: "running", lane: "implement", pid: 2_147_483_646 });
   let spawned = false;
   const result = await sweepMap({ config: r.config, journal: r.journal, map: r.config.maps[1], token: "unused", botIdentity: "ivy-bot",
    respawn: async () => { spawned = true; return 2_147_483_646; } });
   expect(result.respawned).toEqual([]);
   expect(spawned).toBe(false);
   expect(r.journal.getWorker("31", REPO)?.attempts).toBe(0);
  } finally { r.close(); }
 });

 for (const siblingRoot of [1, 460]) {
  test(`dead implement peers recover serially (second root=${siblingRoot})`, async () => {
   const r = rig();
   try {
    r.journal.upsertWorker({ nodeId: "30", repo: REPO, root: 1, status: "claimed", lane: "implement", pid: 2_147_483_646 });
    r.journal.upsertWorker({ nodeId: "31", repo: REPO, root: siblingRoot, status: "running", lane: "implement", pid: 2_147_483_646 });
    const spawns: string[] = [];
    const sweep = (root: number) => sweepMap({ config: r.config, journal: r.journal,
     map: pickMap(r.config, `${REPO}#${root}`), token: "unused", botIdentity: "ivy-bot",
     respawn: async (id) => { spawns.push(id); return process.pid; } });
    await sweep(1);
    if (siblingRoot !== 1) await sweep(siblingRoot);
    expect(spawns).toEqual(["30"]);
    expect(r.journal.getWorker("30", REPO)?.attempts).toBe(1);
    expect(r.journal.getWorker("31", REPO)?.attempts).toBe(0);
    r.journal.updateWorker("30", REPO, { status: "success", pid: null });
    expect((await sweep(siblingRoot)).respawned).toEqual(["31"]);
    expect(spawns).toEqual(["30", "31"]);
    expect(r.journal.getWorker("31", REPO)?.attempts).toBe(1);
   } finally { r.close(); }
  });
 }

 test("a dead holder cannot hide a later live holder from sweep", async () => {
  const r = rig();
  try {
   for (const [id, root, pid] of [["30", 1, 2_147_483_646], ["31", 460, 2_147_483_646], ["32", 460, process.pid]] as const) {
    r.journal.upsertWorker({ nodeId: id, repo: REPO, root, pid, status: "running", lane: "implement" });
   }
   let spawns = 0;
   const result = await sweepMap({ config: r.config, journal: r.journal, map: r.config.maps[1],
    token: "unused", botIdentity: "ivy-bot", respawn: async () => { spawns++; return process.pid; } });
   expect(result.respawned).toEqual([]);
   expect(spawns).toBe(0);
   expect(r.journal.getWorker("31", REPO)?.attempts).toBe(0);
  } finally { r.close(); }
 });

 test("a resource lane alternates maps across restarts and serve predicts the same choice", async () => {
  const r = rig();
  const tick = () => runCli(["walk", "-c", r.configPath], r.env);
  try {
   expect((await tick()).code).toBe(0);
   expect(r.journal.listWorkers().map(w => [w.nodeId, w.root])).toEqual([["20", 1]]);
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe(REPO + "#1");
   r.journal.updateWorker("20", REPO, { status: "success" });
   expect(predicted(r.config)).toEqual([REPO + "#460"]);
   expect((await tick()).code).toBe(0);
   expect(r.journal.getWorker("21", REPO)?.root).toBe(460);
   expect(r.discord.posts[1].content).toContain("map: acme/widgets#460");
   r.journal.updateWorker("21", REPO, { status: "success" });
   expect(predicted(r.config)).toEqual([REPO + "#1"]);
   r.frontier(1, ["22"]);
   expect((await tick()).code).toBe(0);
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe(REPO + "#1");
   expect(r.journal.getWorker("22", REPO)?.status).toBe("claimed");
   r.journal.updateWorker("22", REPO, { status: "success" });
   r.frontier(460, []);
   r.frontier(1, ["23"]);
   expect((await tick()).code).toBe(0);
   expect(r.journal.getWorker("23", REPO)?.root).toBe(1); // empty sibling skipped
  } finally { r.close(); }
 });

 test("a merge-desk send-back takes its lane before a fresh claim (seelite #691 beat #491 to it, 2026-10-05)", async () => {
  const r = rig();
  const saved = { ...process.env };
  try {
   Object.assign(process.env, r.env);
   // Node 40 waits for its merge on root 460; its PR now conflicts with main.
   // Both maps have a fresh candidate (20, 21) for the same headless lane.
   r.journal.upsertWorker({ root: 460, nodeId: "40", repo: REPO, status: "awaiting-merge", lane: "implement" });
   r.journal.updateWorker("40", REPO, { phase: "awaiting-merge", prNumber: 7 });
   const spawned: string[] = [];
   const result = await walk({
    config: r.config, configPath: r.configPath, journal: r.journal, github: conflictingPrForge(),
    spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; },
   });
   expect(spawned).toEqual(["40"]); // the send-back, and no fresh worker
   expect(result.maps.flatMap((m) => m.claimed)).toEqual([]);
   expect(r.journal.getWorker("40", REPO)).toMatchObject({ status: "running", phase: "review" });
   expect(r.journal.getWorker("20", REPO)).toBeNull();
   expect(r.journal.getWorker("21", REPO)).toBeNull();
   expect(result.maps.some((m) => (m.sweep?.mergeDesk?.resumed ?? []).includes("40"))).toBe(true);
  } finally {
   for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
   Object.assign(process.env, saved);
   r.close();
  }
 });

 test("a crashed holder on a later map is released before an earlier map's desk asks for the lane", async () => {
  const r = rig();
  const saved = { ...process.env };
  try {
   Object.assign(process.env, r.env);
   // The send-back is on root 1, walked first; root 460's crashed holder has used every attempt.
   r.journal.upsertWorker({ root: 1, nodeId: "40", repo: REPO, status: "awaiting-merge", lane: "implement" });
   r.journal.updateWorker("40", REPO, { phase: "awaiting-merge", prNumber: 7 });
   r.journal.upsertWorker({ root: 460, nodeId: "45", repo: REPO, status: "running", lane: "implement" });
   r.journal.updateWorker("45", REPO, { pid: 999_999, attempts: r.config.workers.maxAttempts, phase: "implement" });
   expect(r.journal.laneHolder(implementLane(r.config.maps[0]))?.nodeId).toBe("45");
   const spawned: string[] = [];
   const result = await walk({
    config: r.config, configPath: r.configPath, journal: r.journal, github: conflictingPrForge(),
    spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; },
   });
   expect(r.journal.getWorker("45", REPO)?.status).not.toBe("running"); // parked or released
   expect(spawned).toEqual(["40"]);
   expect(result.maps.flatMap((m) => m.claimed)).toEqual([]);
   expect(r.journal.getWorker("40", REPO)).toMatchObject({ status: "running", phase: "review" });
  } finally {
   for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
   Object.assign(process.env, saved);
   r.close();
  }
 });

 test("starts in another resource lane do not starve sibling map rotation", async () => {
  const r = rig();
  try {
   const visual = { ...r.config.maps[0], repo: "acme/game", commands: { ...r.config.maps[0].commands, test: "bun test", probe: "true" } };
   r.config.maps.push(visual);
   writeFileSync(r.configPath, stringify(r.config));
   const visualFrontier = join(r.dir, "data", "acme__game-frontier-1.json");
   const fixture = JSON.parse(readFileSync(join(r.dir, "data", "acme__widgets-frontier-1.json"), "utf8"));
   fixture.repo = visual.repo;
   fixture.frontier[0].ref.id = fixture.frontier[0].node.id = "50";
   writeFileSync(visualFrontier, JSON.stringify(fixture));
   expect((await runCli(["walk", "-c", r.configPath], r.env)).code).toBe(0);
   expect(r.journal.listWorkers().map(w => [w.repo, w.nodeId, w.root])).toEqual([[REPO, "20", 1], [visual.repo, "50", 1]]);
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe("acme/game#1");
   r.journal.updateWorker("20", REPO, { status: "success" });
   r.journal.updateWorker("50", visual.repo, { status: "success" });
   fixture.frontier[0].ref.id = fixture.frontier[0].node.id = "51";
   writeFileSync(visualFrontier, JSON.stringify(fixture));
   expect(predicted(r.config)).toEqual([REPO + "#460", "acme/game#1"]);
   expect((await runCli(["walk", "-c", r.configPath], r.env)).code).toBe(0);
   expect(r.journal.getWorker("21", REPO)?.root).toBe(460);
   expect(r.journal.getWorker("51", visual.repo)?.status).toBe("claimed");
  } finally { r.close(); }
 });

 test("sibling escalation passes keep each other's cards and separate daily digests", async () => {
  const r = rig();
  try {
   for (const root of [1, 460]) {
    const path = join(r.dir, "data", `acme__widgets-frontier-${root}.json`);
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    fixture.frontier[0].node.kind = "grilling";
    fixture.frontier[0].node.autonomy = "propose";
    writeFileSync(path, JSON.stringify(fixture));
   }
   for (let pass = 0; pass < 2; pass++) {
    const result = await runCli(["escalate", "--json", "-c", r.configPath], r.env);
    expect(result.code).toBe(0);
    expect(r.journal.listEscalations().map(c => [c.root, c.notedAt])).toEqual([[1, null], [460, null]]);
   }
   expect(r.discord.posts).toHaveLength(2);
   expect(r.discord.posts[0].content).toContain("map: acme/widgets#1");
   expect(r.discord.posts[1].content).toContain("map: acme/widgets#460");
   const digest = await runCli(["escalate", "--digest", "--json", "-c", r.configPath], r.env);
   expect(digest.code).toBe(0);
   expect(r.journal.getHealth(`digest.${REPO}#1`)).not.toBeNull();
   expect(r.journal.getHealth(`digest.${REPO}#460`)).not.toBeNull();
  } finally { r.close(); }
 });

 test("a shared frontier node cannot move its escalation to a sibling map", async () => {
  const r = rig();
  try {
   r.frontier(460, ["20"]);
   for (const root of [1, 460]) {
    const path = join(r.dir, "data", `acme__widgets-frontier-${root}.json`);
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    fixture.frontier[0].node.kind = "grilling";
    fixture.frontier[0].node.autonomy = "propose";
    writeFileSync(path, JSON.stringify(fixture));
   }
   for (let pass = 0; pass < 2; pass++) {
    const result = await runCli(["escalate", "--json", "-c", r.configPath], r.env);
    const report = JSON.parse(result.stdout);
    expect(report.maps[1].cardErrors[0]).toContain("belongs to map acme/widgets#1; refusing map acme/widgets#460");
    expect(r.journal.listEscalations()).toHaveLength(1);
    expect(r.journal.getEscalation(REPO, "20")).toMatchObject({ root: 1, channelId: "111", notedAt: null });
   }
   expect(r.discord.posts).toHaveLength(1);
   expect(r.discord.edits).toHaveLength(0);
   const card = r.journal.getEscalation(REPO, "20")!;
   expect(() => r.journal.upsertEscalation({ ...card, root: 460 })).toThrow("refusing to move it to map acme/widgets#460");
   expect(r.journal.getEscalation(REPO, "20")).toEqual(card);
  } finally { r.close(); }
 });

 test("a worker whose map was removed holds both resource lanes", () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ nodeId: "90", repo: REPO, root: 999, lane: "implement", status: "running" });
   expect(r.journal.laneHolder("headless")?.root).toBe(999);
   expect(r.journal.laneHolder("visual")?.root).toBe(999);
  } finally { r.close(); }
 });

 test("production config registers gameplay once with its own policy", () => {
  const config = loadConfig(join(import.meta.dir, "../ranger.yaml")).config;
  const platform = pickMap(config, "jcfischer/seelite#1");
  const gameplay = pickMap(config, "jcfischer/seelite#460");
  expect(gameplay.walk).toBe("full"); expect(gameplay.skip).toEqual([]); expect(gameplay.autoMerge).toBe(true);
  expect(gameplay.commands).toEqual(platform.commands); expect(gameplay.discord).toEqual(platform.discord);
  expect(servedMaps(config).filter(m => mapKey(m) === "jcfischer/seelite#460")).toHaveLength(1);
 });
});

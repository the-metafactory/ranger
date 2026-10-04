import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { Journal, openJournal } from "../src/journal.ts";
import { LAST_IMPLEMENT_MAP, mapKey, pickMap, resumeMap } from "../src/maps.ts";
import { servedMaps, ServeReader, stateFromJournal } from "../src/serve.ts";
import { sweepMap } from "../src/sweep.ts";
import { fakeDiscord, fixturesBin, runCli } from "./support.ts";

const REPO = "acme/widgets";
function legacyJournal() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-migration-"));
 const migrations = join(dir, "drizzle"); mkdirSync(join(migrations, "meta"), { recursive: true });
 const source = join(import.meta.dir, "../drizzle");
 const manifest = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
 manifest.entries = manifest.entries.filter((e: { tag: string }) => e.tag !== "0009_worker-root");
 writeFileSync(join(migrations, "meta/_journal.json"), JSON.stringify(manifest));
 for (const entry of manifest.entries) copyFileSync(join(source, `${entry.tag}.sql`), join(migrations, `${entry.tag}.sql`));
 const path = join(dir, "journal.sqlite");
 const sqlite = new Database(path);
 migrate(drizzle(sqlite), { migrationsFolder: migrations });
 return { dir, path, sqlite };
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

describe("node #47 — map identity", () => {
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
  const maps = repos.map((repo, i) => ({ repo, root: roots[i] })).concat({ repo: "jcfischer/seelite", root: 460 });
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
   expect(() => check.run("INSERT INTO workers(node_id,repo) VALUES('99','missing/repo')")).toThrow();
   check.close();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
 });

 for (const table of ["workers", "escalations"] as const) {
  test(`migration refuses unresolved ${table} repos without changing legacy rows`, () => {
   const { dir, path, sqlite } = legacyJournal();
   if (table === "workers") sqlite.run("INSERT INTO workers(node_id,repo,status) VALUES('99','example/custom','parked')");
   else sqlite.run("INSERT INTO escalations(key,repo,node_id,message_id,created_at) VALUES('example/custom:99','example/custom','99','card','2026-10-01')");
   sqlite.close();
   try {
    expect(() => new Journal(path)).toThrow("Cannot backfill legacy map roots for: example/custom");
    const maps = [1, 460].map(root => ({ repo: "example/custom", root }));
    expect(() => new Journal(path, undefined, maps)).toThrow("state.legacyMapRoots");
    expect(() => new Journal(path, undefined, maps, { "example/custom": 999 })).toThrow("must name a registered root");
    const unchanged = new Database(path);
    expect(unchanged.query(`SELECT repo FROM ${table}`).all()).toEqual([{ repo: "example/custom" }]);
    expect((unchanged.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === "root")).toBe(false);
    unchanged.close();
    const journal = new Journal(path, undefined, maps, { "example/custom": 460 });
    const rows = table === "workers" ? journal.listWorkers() : journal.listEscalations();
    expect(rows[0]).toMatchObject({ repo: "example/custom", nodeId: "99", root: 460 });
    journal.close();
    // Subsequent opens use the stored root, with no config or fallback required.
    const reopened = new Journal(path);
    expect((table === "workers" ? reopened.listWorkers() : reopened.listEscalations())[0].root).toBe(460);
    reopened.close();
   } finally { rmSync(dir, { recursive: true, force: true }); }
  });
 }

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

 test("the global lane alternates maps across restarts and serve predicts the same choice", async () => {
  const r = rig();
  const predicted = () => {
   const maps = servedMaps(r.config);
   const reader = new ServeReader(r.config, maps, r.config.state.journalPath);
   return stateFromJournal(r.config, maps, reader).maps.filter(m => m.next.lane === "implement" && !m.next.waiting).map(m => m.key);
  };
  const tick = () => runCli(["walk", "-c", r.configPath], r.env);
  try {
   expect((await tick()).code).toBe(0);
   expect(r.journal.listWorkers().map(w => [w.nodeId, w.root])).toEqual([["20", 1]]);
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe(REPO + "#1");
   r.journal.updateWorker("20", REPO, { status: "success" });
   expect(predicted()).toEqual([REPO + "#460"]);
   expect((await tick()).code).toBe(0);
   expect(r.journal.getWorker("21", REPO)?.root).toBe(460);
   expect(r.discord.posts[1].content).toContain("map: acme/widgets#460");
   r.journal.updateWorker("21", REPO, { status: "success" });
   expect(predicted()).toEqual([REPO + "#1"]);
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

 test("production config registers gameplay once with its own policy", () => {
  const config = loadConfig(join(import.meta.dir, "../ranger.yaml")).config;
  const platform = pickMap(config, "jcfischer/seelite#1");
  const gameplay = pickMap(config, "jcfischer/seelite#460");
  expect(gameplay.walk).toBe("full"); expect(gameplay.skip).toEqual([]); expect(gameplay.autoMerge).toBe(true);
  expect(gameplay.commands).toEqual(platform.commands); expect(gameplay.discord).toEqual(platform.discord);
  expect(servedMaps(config).filter(m => mapKey(m) === "jcfischer/seelite#460")).toHaveLength(1);
 });
});

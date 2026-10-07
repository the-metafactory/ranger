import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { Journal, openJournal, type WorkerStatus, type ImplementPhase } from "../src/journal.ts";
import { LAST_IMPLEMENT_MAP } from "../src/maps.ts";
import type { GitHubPort, PullRequest } from "../src/github.ts";
import { walk } from "../src/walk.ts";
import type { SpawnRunNodeArgs } from "../src/spawn.ts";
import { resumeNode } from "../src/resume.ts";
import { fakeDiscord, fixturesBin, runCli } from "./support.ts";

const REPO = "acme/widgets";
const NOW = new Date("2026-10-07T10:00:00Z");

function rig() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-resume-queue-"));
 const discord = fakeDiscord();
 const configPath = join(dir, "ranger.yaml");
 const raw = { version: 1,
  maps: [1, 460].map(root => ({ repo: REPO, root, walk: "full", commands: { test: "bun test" },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: String(root) } })),
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" }, bot: { identity: "ivy-bot" },
  state: { journalPath: join(dir, "journal.sqlite") }, workers: { spawnCapPerDay: 10 },
 };
 writeFileSync(configPath, stringify(raw));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 const data = join(dir, "data"); mkdirSync(data);
 const frontier = (root: number, ids: string[]) => writeFileSync(join(data, `acme__widgets-frontier-${root}.json`), JSON.stringify({
  repo: REPO, root: String(root), frontier: ids.map(id => ({ ref: { id }, node: { id, title: `Build ${id}`, kind: "task", autonomy: "auto", probes: [] },
   status: "open", assignees: [], blockedBy: [], author: "alice", typed: true, url: `https://github.com/${REPO}/issues/${id}` })) }));
 for (const root of [1, 460]) frontier(root, []);
 const state = join(dir, "graph.json"); writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
 const env = { ...process.env, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, FAKE_SOMA_DIR: data,
  FAKE_SOMA_STATE: state, RANGER_WRITE_TEST: "ghp_write", RANGER_NO_SPAWN: "1", RANGER_DISCORD_TOKEN: "test",
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`, RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5" };
 const node = (id: string, status = "open") => writeFileSync(join(data, `acme__widgets-node-${id}.json`), JSON.stringify({
  repo: REPO, ref: { id }, node: { id, title: `Build ${id}`, kind: "task", autonomy: "auto" },
  status, assignees: ["ivy-bot"], blockedBy: [], author: "alice", typed: true, url: "" }));
 const worker = (id: string, root = 1, status: WorkerStatus = "parked", lane = "implement", phase: ImplementPhase | null = "review") => {
  journal.upsertWorker({ nodeId: id, repo: REPO, root, status, lane, phase, finishedAt: "2026-10-06T00:00:00Z", workerPgid: 1234 });
  node(id);
 };
 const queue = (id: string, root = 1) => {
  worker(id, root);
  return journal.enqueueResume({ nodeId: id, repo: REPO, root, lane: "headless" }, NOW);
 };
 return { dir, raw, configPath, config, journal, env, node, worker, queue, frontier,
  cli: (id: string, flags: string[] = [], over: NodeJS.ProcessEnv = {}) => runCli(["resume-node", id, "-c", configPath, ...flags], { ...env, ...over }),
  close() { journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

async function withRig(fn: (r: ReturnType<typeof rig>) => Promise<void>) {
 const r = rig();
 const saved = { ...process.env };
 try { Object.assign(process.env, r.env); await fn(r); }
 finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved); r.close();
 }
}

function pr(number = 7): PullRequest {
 return { number, state: "open", merged: false, draft: false, title: "Build", headRef: "node/40-x", headSha: "b".repeat(40),
  baseRef: "main", mergeable: true, mergeableState: "clean", mergeCommitSha: null, mergedBy: null, url: "", author: "ivy-bot" };
}

describe("resume-node CLI", () => {
 test("explicit map without a row refuses clearly, including a row disappearing after map selection", async () => {
  await withRig(async r => {
   const result = await r.cli("40", ["--map", REPO + "#1", "--when-free"]);
   expect(result.code).not.toBe(0);
   expect(result.stderr).toContain("no unique journal row for node 40");
   r.worker("40");
   const getWorker = spyOn(r.journal, "getWorker").mockReturnValue(null);
   try {
    await expect(resumeNode("40", REPO + "#1", r, { whenFree: true }))
     .rejects.toThrow(`no journal row for node 40 on ${REPO} — nothing to resume`);
   } finally { getWorker.mockRestore(); }
  });
 });

 test("held lane queues durably, records queued, and repeated requests keep FIFO position", async () => {
  await withRig(async r => {
   r.worker("40"); r.worker("41", 460, "running");
   const result = await r.cli("40", ["--when-free"]);
   expect(result.code).toBe(0);
   expect(JSON.parse(result.stdout)).toMatchObject({ nodeId: "40", root: 1, queued: true, lane: "headless" });
   const entry = r.journal.listResumeQueue()[0];
   expect(r.journal.getWorker("40", REPO)).toMatchObject({ status: "parked", pid: null });
   expect(r.journal.spawnsToday()).toBe(0);
   expect((await r.cli("40", ["--when-free"])).code).toBe(0);
   expect(r.journal.listResumeQueue()).toEqual([entry]);
   expect(r.journal.listEvents(REPO).filter(e => e.kind === "queued")).toHaveLength(1);
   expect(r.journal.listEvents(REPO).some(e => e.kind === "sweep")).toBe(false);
   const reader = Journal.openReadOnly(r.config.state.journalPath)!;
   expect(reader.listResumeQueue()).toEqual([entry]); reader.close();
  });
 });

 for (const gate of ["pause", "cap"] as const) {
  test(`${gate} queues a free-lane request, and later requests remain FIFO after the hold clears`, async () => {
   await withRig(async r => {
    r.worker("40"); r.worker("41", 460, "running");
    if (gate === "pause") r.journal.setPaused(true);
    else for (let i = 0; i < r.config.workers.spawnCapPerDay; i++) r.journal.recordSpawn(NOW);
    expect((await r.cli("40", ["--when-free"])).code).toBe(0);
    const first = r.journal.listResumeQueue()[0];
    r.journal.updateWorker("41", REPO, { status: "parked" });
    const spawned: string[] = [];
    const ctx = { ...r, now: () => NOW, spawnRunNode: async ({ nodeId }: SpawnRunNodeArgs) => {
     spawned.push(nodeId); return process.pid;
    } };
    const held = await resumeNode("41", undefined, ctx, { whenFree: true });
    expect(held).toMatchObject({ nodeId: "41", queued: true });
    const second = r.journal.listResumeQueue()[1];
    expect(r.journal.listResumeQueue()).toEqual([first, second]);
    if (gate === "pause") r.journal.setPaused(false);
    else r.config.workers.spawnCapPerDay++;
    expect(await resumeNode("41", undefined, ctx, { whenFree: true })).toMatchObject({ queued: true });
    expect(await resumeNode("40", undefined, ctx, { whenFree: true })).toMatchObject({ queued: true });
    expect(spawned).toEqual([]);
    expect(r.journal.listResumeQueue()).toEqual([first, second]);
    expect(r.journal.listEvents(REPO).filter(e => e.kind === "queued")).toHaveLength(2);
    expect(r.journal.getWorker("40", REPO)?.status).toBe("parked");
    expect(r.journal.getWorker("41", REPO)?.status).toBe("parked");
    await walk(ctx);
    expect(spawned).toEqual(["40"]);
    expect(r.journal.listResumeQueue()).toEqual([second]);
   });
  });

  test(`${gate} does not hold an immediate operator resume on a free lane`, async () => {
   await withRig(async r => {
    r.worker("40");
    if (gate === "pause") r.journal.setPaused(true);
    else for (let i = 0; i < r.config.workers.spawnCapPerDay; i++) r.journal.recordSpawn(new Date());
    const before = r.journal.spawnsToday();
    const result = await r.cli("40", ["--when-free"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ nodeId: "40", kind: "started" });
    expect(r.journal.listResumeQueue()).toEqual([]);
    expect(r.journal.getWorker("40", REPO)?.status).toBe("claimed");
    expect(r.journal.spawnsToday()).toBe(before);
   });
  });
 }

 test("a backlog in another implement lane leaves a free-lane resume immediate", async () => {
  await withRig(async r => {
   r.queue("40");
   r.config.maps[1].lane = "visual";
   r.worker("41", 460);
   const spawned: string[] = [];
   const result = await resumeNode("41", undefined, { ...r, spawnRunNode: async ({ nodeId }) => {
    spawned.push(nodeId); return process.pid;
   } }, { whenFree: true });
   expect(result).toMatchObject({ pid: process.pid });
   expect(spawned).toEqual(["41"]);
   expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["40"]);
  });
 });

 test("requeue reports the stored lane after the map's lane changes", async () => {
  await withRig(async r => {
   const entry = r.queue("40");
   r.config.maps[0].lane = "visual";
   r.journal.setPaused(true);
   const result = await resumeNode("40", undefined, r, { whenFree: true });
   expect(result).toMatchObject({ queued: true, lane: entry.lane, queuedAt: entry.queuedAt });
   expect(r.journal.listResumeQueue()).toEqual([entry]);
  });
 });

 for (const [lane, phase] of [["research", null], ["implement", "close"]] as const) {
  test(`${lane}/${phase} resumes immediately despite backlog, pause and cap`, async () => {
   await withRig(async r => {
    r.queue("40"); r.worker("41", 460, "parked", lane, phase);
    r.journal.setPaused(true);
    for (let i = 0; i < r.config.workers.spawnCapPerDay; i++) r.journal.recordSpawn(new Date());
    const result = await r.cli("41", ["--when-free"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ nodeId: "41", was: "parked", pid: null });
    expect(r.journal.getWorker("41", REPO)?.status).toBe("claimed");
    expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["40"]);
   });
  });
 }

 for (const [name, lane, phase, held] of [
  ["free implement lane", "implement", "review", false],
  ["research resume", "research", null, true],
  ["close-only resume", "implement", "close", true],
 ] as const) {
  test(`${name} resumes immediately through the ordinary resume path`, async () => {
   await withRig(async r => {
    r.worker("40", 460, "failed", lane, phase);
    if (held) r.worker("41", 1, "running");
    const result = await r.cli("40", ["--when-free"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ nodeId: "40", root: 460, was: "failed", pid: null });
    expect(r.journal.listResumeQueue()).toEqual([]);
    expect(r.journal.getWorker("40", REPO)).toMatchObject({ status: "claimed", workerPgid: null, finishedAt: null, phase });
    expect(r.journal.getHealth(LAST_IMPLEMENT_MAP)).toBe(held ? null : REPO + "#460");
    expect(r.journal.spawnsToday()).toBe(0);
   });
  });
 }

 test("cancel removes only the selected queued node with an event; absent entry refuses", async () => {
  await withRig(async r => {
   r.queue("40"); r.queue("41", 460);
   expect((await r.cli("40", ["--cancel"])).code).toBe(0);
   expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["41"]);
   expect(r.journal.listEvents(REPO).find(e => e.kind === "resume-cancelled")?.nodeId).toBe("40");
   expect((await r.cli("40", ["--cancel"])).code).not.toBe(0);
   expect(r.journal.getWorker("40", REPO)?.status).toBe("parked");
  });
 });

 test("plain resume still refuses a held lane; force starts; conflicting flags refuse", async () => {
  await withRig(async r => {
   r.worker("40"); r.worker("41", 460, "running");
   expect((await r.cli("40")).code).not.toBe(0);
   for (const flags of [["--cancel", "--when-free"], ["--when-free", "--force"], ["--cancel", "--force"]]) {
    expect((await r.cli("40", flags)).code).not.toBe(0);
   }
   expect(r.journal.listResumeQueue()).toEqual([]);
   expect((await r.cli("40", ["--force"])).code).toBe(0);
   expect(r.journal.getWorker("40", REPO)?.status).toBe("claimed");
  });
 });

 test("queueing and immediate startup retain the identity gate", async () => {
  await withRig(async r => {
   r.worker("40"); r.worker("41", 460, "running");
   const result = await r.cli("40", ["--when-free"], { RANGER_WRITE_TEST: "ghp_principal" });
   expect(result.code).not.toBe(0);
   expect(r.journal.listResumeQueue()).toEqual([]);
   r.journal.updateWorker("41", REPO, { status: "success" });
   expect((await r.cli("40", ["--when-free"], { RANGER_WRITE_TEST: "ghp_principal" })).code).not.toBe(0);
   expect(r.journal.getWorker("40", REPO)?.status).toBe("parked");
  });
 });
});

describe("resume-queue-starts-when-lane-frees", () => {
 test("transient reads and admission holds preserve prior failures until the third failed start", async () => {
  await withRig(async r => {
   const entry = r.queue("40");
   const tick = () => walk({ ...r, now: () => NOW, spawnRunNode: async () => { throw new Error("spawn unavailable"); } });
   await tick(); await tick();
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(2);
   rmSync(join(r.env.FAKE_SOMA_DIR!, "acme__widgets-node-40.json"));
   for (let i = 0; i < 4; i++) await tick();
   expect(r.journal.getResume(REPO, "40")).toEqual({ ...entry, failedStarts: 2 });
   r.node("40"); r.journal.setPaused(true);
   await tick();
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(2);
   r.journal.setPaused(false); r.journal.recordSpawn(NOW); r.config.workers.spawnCapPerDay = 1;
   await tick();
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(2);
   r.config.workers.spawnCapPerDay++;
   await tick();
   expect(r.journal.getResume(REPO, "40")).toBeNull();
   expect(r.journal.listEvents(REPO).find(e => e.kind === "resume-dropped")?.detail)
    .toContain("3 consecutive failed starts; last error: start failed: spawn unavailable");
   expect(r.journal.getWorker("40", REPO)?.status).toBe("parked");
  });
 });

 test("RANGER_NO_SPAWN counts a failed queued start, permits fresh claims, and drops after three", async () => {
  await withRig(async r => {
   r.queue("40", 460); r.queue("41");
   r.frontier(1, ["20"]);
   const tick = () => walk({ ...r, now: () => NOW });
   const first = await tick();
   expect(first.maps.flatMap(m => m.claimed)).toEqual(["20"]);
   expect(first.maps.flatMap(m => m.errors).join(" ")).toContain("run-node spawn returned no PID");
   expect(r.journal.getWorker("40", REPO)?.status).toBe("parked");
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(1);
   expect(r.journal.getResume(REPO, "41")?.failedStarts).toBe(0);
   r.frontier(1, []);
   r.journal.updateWorker("20", REPO, { status: "success" });
   await tick();
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(2);
   await tick();
   expect(r.journal.getResume(REPO, "40")).toBeNull();
   expect(r.journal.getResume(REPO, "41")?.failedStarts).toBe(1);
   expect(r.journal.listEvents(REPO).find(e => e.kind === "resume-dropped")?.detail)
    .toContain("3 consecutive failed starts; last error: start failed: run-node spawn returned no PID");
   expect(r.journal.listEvents(REPO).some(e => e.kind === "resume-started")).toBe(false);
   expect(r.journal.spawnsToday(NOW)).toBe(1); // Only the fresh claim spent budget.
  });
 });

 test("an immediate when-free start spends no spawn and leaves another lane's queue eligible", async () => {
  await withRig(async r => {
   r.config.maps[1].lane = "visual"; r.config.workers.spawnCapPerDay = 1;
   r.worker("40"); r.worker("41", 460);
   r.journal.enqueueResume({ nodeId: "41", repo: REPO, root: 460, lane: "visual" }, NOW);
   const spawned: string[] = [];
   const ctx = { ...r, now: () => NOW, spawnRunNode: async ({ nodeId }: SpawnRunNodeArgs) => {
    spawned.push(nodeId); return process.pid;
   } };
   expect(await resumeNode("40", undefined, ctx, { whenFree: true })).toMatchObject({ kind: "started", pid: process.pid });
   expect(r.journal.spawnsToday(NOW)).toBe(0);
   await walk(ctx);
   expect(spawned).toEqual(["40", "41"]);
   expect(r.journal.listResumeQueue()).toEqual([]);
   expect(r.journal.spawnsToday(NOW)).toBe(1);
  });
 });

 test("an immediate when-free spawn error restores the row and spends no budget", async () => {
  await withRig(async r => {
   r.worker("40");
   const before = r.journal.getWorker("40", REPO);
   await expect(resumeNode("40", undefined, { ...r, now: () => NOW,
    spawnRunNode: async () => { throw new Error("spawn failed"); } }, { whenFree: true }))
    .rejects.toThrow("spawn failed");
   expect(r.journal.getWorker("40", REPO)).toEqual(before);
   expect(r.journal.spawnsToday(NOW)).toBe(0);
  });
 });

 test("FIFO across maps: held queue waits, A alone starts, then B after A releases", async () => {
  await withRig(async r => {
   r.queue("40", 460); r.queue("41"); r.worker("42", 1, "running");
   const spawned: string[] = [];
   const launches: SpawnRunNodeArgs[] = [];
   const tick = () => walk({ ...r, spawnRunNode: async (args) => { launches.push(args); spawned.push(args.nodeId); return process.pid; }, now: () => NOW });
   await tick(); expect(spawned).toEqual([]);
   r.journal.updateWorker("42", REPO, { status: "success" });
   await tick(); expect(spawned).toEqual(["40"]);
   expect(launches[0]).toMatchObject({ nodeId: "40", repo: REPO, root: 460, configPath: r.configPath });
   expect(launches[0].cliEntry).toEndWith("/src/cli.ts");
   expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["41"]);
   expect(r.journal.getWorker("40", REPO)).toMatchObject({ status: "claimed", pid: process.pid, workerPgid: null, finishedAt: null, phase: "review" });
   expect(r.journal.getHealth(LAST_IMPLEMENT_MAP + ".headless")).toBe(REPO + "#460");
   expect(r.journal.spawnsToday(NOW)).toBe(1);
   await tick(); expect(spawned).toEqual(["40"]);
   r.journal.updateWorker("40", REPO, { status: "success" });
   await tick(); expect(spawned).toEqual(["40", "41"]);
   expect(r.journal.listResumeQueue()).toEqual([]);
   expect(r.journal.listEvents(REPO).filter(e => e.kind === "resume-started")).toHaveLength(2);
  });
 });

 test("started resume prevents all same-lane fresh claims even when its worker finishes during the tick", async () => {
  await withRig(async r => {
   r.queue("40", 460); r.frontier(1, ["20"]); r.frontier(460, ["21"]);
   const spawned: string[] = [];
   const result = await walk({ ...r, spawnRunNode: async ({ nodeId }) => {
    spawned.push(nodeId); r.journal.updateWorker(nodeId, REPO, { status: "success" }); return process.pid;
   } });
   expect(spawned).toEqual(["40"]);
   expect(result.maps.flatMap(m => m.claimed)).toEqual([]);
   expect(r.journal.getWorker("20", REPO)).toBeNull(); expect(r.journal.getWorker("21", REPO)).toBeNull();
  });
 });

 test("independent implement lanes each start their first resume", async () => {
  await withRig(async r => {
   r.config.maps[1].lane = "visual";
   r.queue("40"); r.worker("41", 460);
   r.journal.enqueueResume({ nodeId: "41", repo: REPO, root: 460, lane: "visual" });
   const spawned: string[] = [];
   await walk({ ...r, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual(["40", "41"]);
  });
 });

 test("merge-desk send-back takes the lane before a queued resume", async () => {
  await withRig(async r => {
   r.queue("41"); r.worker("40", 460, "awaiting-merge", "implement", "awaiting-merge");
   r.journal.updateWorker("40", REPO, { prNumber: 7 });
   const github = { getPr: async () => ({ ...pr(), mergeable: false, mergeableState: "dirty" }),
    listComments: async () => [{ id: 1, author: "ivy-bot", body: `<!-- ranger:review round=5 sha=${pr().headSha} blockers=0 majors=0 nits=1 -->\nclean` }],
    checkRunsFor: async () => [], issueLabels: async () => [] } as unknown as GitHubPort;
   const spawned: string[] = [];
   await walk({ ...r, github, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual(["40"]);
   expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["41"]);
  });
 });

 for (const gate of ["pause", "cap"] as const) {
  test(`${gate} retains the queue; clearing it permits a start`, async () => {
   await withRig(async r => {
    r.queue("40");
    if (gate === "pause") r.journal.setPaused(true);
    else for (let i = 0; i < r.config.workers.spawnCapPerDay; i++) r.journal.recordSpawn(NOW);
    r.journal.updateWorker("40", REPO, { prNumber: 7 });
    const calls = join(r.dir, "calls"); writeFileSync(calls, ""); process.env.FAKE_SOMA_CALLS = calls;
    let reads = 0;
    const github = { getPr: async () => { reads++; return pr(); } } as unknown as GitHubPort;
    const spawned: string[] = [];
    const tick = () => walk({ ...r, github, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; }, now: () => NOW });
    await tick(); expect(spawned).toEqual([]); expect(r.journal.listResumeQueue()).toHaveLength(1);
    // The desk reads parked PRs even while paused/capped; the queue adds no read.
    expect(reads).toBe(1);
    expect(readFileSync(calls, "utf8")).not.toContain("node ");
    if (gate === "pause") r.journal.setPaused(false);
    else r.config.workers.spawnCapPerDay++;
    await tick(); expect(spawned).toEqual(["40"]); expect(r.journal.listResumeQueue()).toEqual([]);
   });
  });
 }

 for (const reason of ["node closed", "released", "PR merged", "PR closed", "claimed", "running", "walk none"] as const) {
  test(`drops ${reason} with a reason and considers the next entry`, async () => {
   await withRig(async r => {
    r.queue("40"); r.queue("41", 460);
    if (reason === "node closed") r.node("40", "closed");
    if (["released", "claimed", "running"].includes(reason)) r.journal.updateWorker("40", REPO, { status: reason as WorkerStatus });
    if (reason.startsWith("PR")) r.journal.updateWorker("40", REPO, { status: "failed", prNumber: 7 });
    if (reason === "walk none") r.config.maps[0].walk = "none";
    const github = { getPr: async () => ({ ...pr(), state: "closed", merged: reason === "PR merged" }) } as unknown as GitHubPort;
    const spawned: string[] = [];
    await walk({ ...r, github, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
    // An in-flight implement row still holds the lane after its queue entry is dropped.
    expect(spawned).toEqual(["claimed", "running"].includes(reason) ? [] : ["41"]);
    expect(r.journal.listResumeQueue().some(e => e.nodeId === "40")).toBe(false);
    const event = r.journal.listEvents(REPO).find(e => e.kind === "resume-dropped" && e.nodeId === "40");
    expect(event?.detail).toContain(reason === "walk none" ? "walk: none" : reason.split(" ").at(-1)!);
   });
  });
 }

 test("a moved PR head still starts, using one PR read shared with the desk", async () => {
  await withRig(async r => {
   r.queue("40"); r.journal.updateWorker("40", REPO, { prNumber: 7, verdictSha: "a".repeat(40) });
   let reads = 0;
   const github = { getPr: async () => { reads++; return pr(); } } as unknown as GitHubPort;
   const spawned: string[] = [];
   await walk({ ...r, github, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(reads).toBe(1); expect(spawned).toEqual(["40"]); expect(r.journal.listResumeQueue()).toEqual([]);
  });
 });

 test("closed node is dropped even while another worker holds its lane", async () => {
  await withRig(async r => {
   r.queue("40"); r.queue("41", 460); r.worker("42", 1, "running"); r.node("40", "closed");
   const spawned: string[] = [];
   await walk({ ...r, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual([]);
   expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["41"]);
   expect(r.journal.listEvents(REPO).find(e => e.kind === "resume-dropped")?.detail).toBe("node is closed");
  });
 });

 for (const failure of ["node", "PR"] as const) {
 test(`${failure} validation failure retains FIFO without counting and permits shared-lane claims`, async () => {
  await withRig(async r => {
   r.queue("40"); r.queue("41", 460); r.journal.updateWorker("40", REPO, { status: "failed", prNumber: 7 });
   const entries = r.journal.listResumeQueue();
   if (failure === "node") rmSync(join(r.env.FAKE_SOMA_DIR!, "acme__widgets-node-40.json"));
   r.frontier(1, ["20"]);
   r.frontier(460, ["21"]);
   let readFails = failure === "PR";
   let reads = 0;
   const github = { getPr: async () => {
    reads++;
    if (readFails) throw new Error("read failed");
    return pr();
   } } as unknown as GitHubPort;
   const spawned: string[] = [];
   const tick = () => walk({ ...r, github, now: () => NOW,
    spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   for (let attempt = 0; attempt < 2; attempt++) {
    const result = await tick();
    expect(spawned).toEqual(["20"]);
    expect(r.journal.listResumeQueue()).toEqual(entries);
    expect(result.maps.flatMap(m => m.claimed)).toEqual(attempt === 0 ? ["20"] : []);
    expect(result.maps.flatMap(m => m.errors).join(" ")).toContain("validation failed");
    expect(r.journal.getWorker("40", REPO)?.status).toBe("failed");
    expect(r.journal.getWorker("41", REPO)?.status).toBe("parked");
    expect(r.journal.spawnsToday(NOW)).toBe(1);
    expect(reads).toBe(failure === "PR" ? attempt + 1 : 0);
   }
   expect(r.journal.listEvents(REPO).some(e => e.kind === "resume-dropped")).toBe(false);
   const event = r.journal.listEvents(REPO).find(e => e.kind === "sweep" && e.detail?.includes("queued resume #40 deferred"));
   expect(event?.detail).toContain("validation failed");
   expect(event?.detail).toContain(failure === "node" ? "no fixture" : "read failed");
   r.journal.updateWorker("20", REPO, { status: "success" });
   r.frontier(1, []); r.frontier(460, []);
   r.node("40"); readFails = false;
   const recovered = await tick();
   expect(spawned).toEqual(["20", "40"]);
   expect(r.journal.listResumeQueue()).toEqual([entries[1]]);
   expect(recovered.maps.flatMap(m => m.claimed)).toEqual([]);
   expect(r.journal.spawnsToday(NOW)).toBe(2);
   r.journal.updateWorker("40", REPO, { status: "success" });
   const next = await tick();
   expect(spawned).toEqual(["20", "40", "41"]);
   expect(r.journal.listResumeQueue()).toEqual([]);
   expect(next.maps.flatMap(m => m.claimed)).toEqual([]);
  });
 });
 }

 for (const failure of ["validation", "no PID"] as const) {
 test(`${failure} failure retains its entry without blocking an independent lane`, async () => {
  await withRig(async r => {
   r.config.maps[1].lane = "visual";
   const entry = r.queue("40");
   if (failure === "validation") rmSync(join(r.env.FAKE_SOMA_DIR!, "acme__widgets-node-40.json"));
   r.frontier(460, ["21"]);
   const spawned: string[] = [];
   const result = await walk({ ...r, spawnRunNode: async ({ nodeId }) => {
    if (nodeId === "40") return null;
    spawned.push(nodeId); return process.pid;
   } });
   expect(spawned).toEqual(["21"]);
   expect(result.maps.flatMap(m => m.claimed)).toEqual(["21"]);
   expect(r.journal.listResumeQueue()).toEqual([{ ...entry, failedStarts: failure === "no PID" ? 1 : 0 }]);
   expect(result.maps.flatMap(m => m.errors).join(" ")).toContain(failure === "validation" ? "validation failed" : "run-node spawn returned no PID");
  });
 });
 }

 for (const independent of [false, true]) {
 test(`credential-gated queue preserves FIFO ${independent ? "without blocking an independent lane" : "and permits shared-lane claims"}`, async () => {
  await withRig(async r => {
   if (independent) r.config.maps[1].lane = "visual";
   const repo = "acme/unavailable";
   r.config.maps.unshift({ ...r.config.maps[0], repo });
   r.config.auth.writeTokens[repo] = "RANGER_QUEUE_UNAVAILABLE_TEST";
   delete process.env.RANGER_QUEUE_UNAVAILABLE_TEST;
   r.journal.upsertWorker({ nodeId: "40", repo, root: 1, status: "parked", lane: "implement", phase: "review" });
   const entry = r.journal.enqueueResume({ nodeId: "40", repo, root: 1, lane: "headless" });
   r.worker("41", 460);
   const second = r.journal.enqueueResume({ nodeId: "41", repo: REPO, root: 460, lane: independent ? "visual" : "headless" });
   r.frontier(1, ["20"]);
   r.frontier(460, ["21"]);
   const spawned: string[] = [];
   const tick = () => walk({ ...r, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   const result = await tick();
   expect(spawned).toEqual(independent ? ["41", "20"] : ["20"]);
   expect(result.maps.flatMap(m => m.claimed)).toEqual(["20"]);
   expect(r.journal.listResumeQueue()).toEqual(independent ? [{ ...entry, failedStarts: 1 }] : [{ ...entry, failedStarts: 1 }, second]);
   expect(result.maps.find(m => m.repo === repo)?.errors.join(" ")).toContain("RANGER_QUEUE_UNAVAILABLE_TEST");
   expect(r.journal.listEvents(repo).find(e => e.kind === "sweep")?.detail).toContain("queued resume #40 deferred");
  });
 });
 }

 test("a changed map lane defers the head without a definitive drop or a lane reservation", async () => {
  await withRig(async r => {
   const head = r.queue("40"); const next = r.queue("41", 460);
   r.config.maps[0].lane = "visual";
   r.frontier(460, ["21"]);
   const spawned: string[] = [];
   await walk({ ...r, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual(["21"]);
   expect(r.journal.listResumeQueue()).toEqual([head, next]);
   expect(r.journal.listEvents(REPO).some(e => e.kind === "resume-dropped")).toBe(false);
  });
 });

 test("a row activated during validation is dropped rather than restarted", async () => {
  await withRig(async r => {
   r.queue("40"); r.queue("41", 460); r.journal.updateWorker("40", REPO, { status: "failed", prNumber: 7 });
   const github = { getPr: async () => {
    r.journal.updateWorker("40", REPO, { status: "running", phase: "close" }); return pr();
   } } as unknown as GitHubPort;
   const spawned: string[] = [];
   await walk({ ...r, github, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual(["41"]);
   expect(r.journal.getWorker("40", REPO)?.status).toBe("running");
   expect(r.journal.listResumeQueue()).toEqual([]);
   expect(r.journal.listEvents(REPO).find(e => e.kind === "resume-dropped")?.detail).toContain("running");
  });
 });

 test("one queued start spends the last spawn, retaining the other lane's entry", async () => {
  await withRig(async r => {
   r.config.maps[1].lane = "visual"; r.config.workers.spawnCapPerDay = 1;
   r.queue("40"); r.worker("41", 460);
   r.journal.enqueueResume({ nodeId: "41", repo: REPO, root: 460, lane: "visual" });
   const spawned: string[] = [];
   await walk({ ...r, now: () => NOW, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual(["40"]); expect(r.journal.spawnsToday(NOW)).toBe(1);
   expect(r.journal.listResumeQueue().map(e => e.nodeId)).toEqual(["41"]);
  });
 });

 test("identity refusal counts failed starts and drops after three without starting", async () => {
  await withRig(async r => {
   r.queue("40");
   process.env.RANGER_WRITE_TEST = "ghp_principal";
   const spawned: string[] = [];
   const result = await walk({ ...r, spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return process.pid; } });
   expect(spawned).toEqual([]); expect(r.journal.listResumeQueue()).toHaveLength(1);
   expect(result.maps.every(m => m.gated)).toBe(true);
   expect(r.journal.getWorker("40", REPO)?.status).toBe("parked");
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(1);
   await walk({ ...r, spawnRunNode: async () => { throw new Error("must not spawn"); } });
   expect(r.journal.getResume(REPO, "40")?.failedStarts).toBe(2);
   await walk({ ...r, spawnRunNode: async () => { throw new Error("must not spawn"); } });
   expect(r.journal.getResume(REPO, "40")).toBeNull();
   expect(r.journal.listEvents(REPO).find(e => e.kind === "resume-dropped")?.detail)
    .toContain("last error: start failed: configured bot.identity");
   expect(r.journal.spawnsToday()).toBe(0);
  });
 });

 for (const [lane, phase] of [["research", null], ["implement", "close"]] as const) {
  test(`a failed queued ${lane}/${phase} resume leaves same-lane implement capacity available`, async () => {
   await withRig(async r => {
    const entry = r.queue("40");
    r.worker("40", 1, "parked", lane, phase);
    const before = r.journal.getWorker("40", REPO);
    r.frontier(460, ["21"]);
    const spawned: string[] = [];
    const result = await walk({ ...r, spawnRunNode: async ({ nodeId }) => {
     spawned.push(nodeId);
     if (nodeId === "40") throw new Error("spawn failed");
     return process.pid;
    } });
    expect(spawned).toEqual(["40", "21"]);
    expect(result.maps.flatMap(m => m.claimed)).toEqual(["21"]);
    expect(result.maps.flatMap(m => m.errors).join(" ")).toContain("queued resume #40: start failed: spawn failed");
    expect(r.journal.listResumeQueue()).toEqual([{ ...entry, failedStarts: 1 }]);
    expect(r.journal.getWorker("40", REPO)).toEqual(before);
   });
  });
 }

 for (const failure of ["no PID", "throws"] as const) {
 test(`${failure} reports failed queued starts, retains FIFO and restores rows until recovery`, async () => {
  await withRig(async r => {
   r.queue("40"); r.queue("41", 460);
   r.frontier(1, ["20"]); r.frontier(460, ["21"]);
   const entries = r.journal.listResumeQueue();
   const before = r.journal.getWorker("40", REPO);
   const spawned: string[] = [];
   const error = failure === "throws" ? "spawn failed" : "run-node spawn returned no PID";
   const spawnRunNode = async ({ nodeId }: SpawnRunNodeArgs) => {
    spawned.push(nodeId);
    if (nodeId !== "40") return process.pid;
    if (failure === "throws") throw new Error(error);
    return null;
   };
   for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) { r.journal.updateWorker("20", REPO, { status: "success" }); r.frontier(1, []); r.frontier(460, []); }
    const result = await walk({ ...r, spawnRunNode, now: () => NOW });
    expect(spawned).toEqual(attempt === 0 ? ["40", "20"] : ["40", "20", "40"]);
    expect(result.maps.flatMap(m => m.claimed)).toEqual(attempt === 0 ? ["20"] : []);
    expect(result.maps.flatMap(m => m.errors).join(" ")).toContain(`queued resume #40: start failed: ${error}`);
    expect(r.journal.listResumeQueue()).toEqual([{ ...entries[0], failedStarts: attempt + 1 }, entries[1]]);
    expect(r.journal.getWorker("40", REPO)).toEqual(before);
    expect(r.journal.getWorker("41", REPO)?.status).toBe("parked");
    expect(r.journal.spawnsToday(NOW)).toBe(1);
   }
   const events = r.journal.listEvents(REPO).filter(e => e.kind === "sweep" && e.detail?.includes("queued resume #40 deferred: start failed"));
   expect(events).toHaveLength(2);
   expect(events.every(e => e.detail?.includes(error))).toBe(true);
   expect(r.journal.listEvents(REPO).some(e => e.kind === "resume-started")).toBe(false);
   const recovered: string[] = [];
   const tick = () => walk({ ...r, now: () => NOW,
    spawnRunNode: async ({ nodeId }) => { recovered.push(nodeId); return process.pid; } });
   await tick();
   expect(recovered).toEqual(["40"]);
   expect(r.journal.listResumeQueue()).toEqual([entries[1]]);
   expect(r.journal.spawnsToday(NOW)).toBe(2);
   r.journal.updateWorker("40", REPO, { status: "parked" });
   const requeued = r.journal.enqueueResume({ nodeId: "40", repo: REPO, root: 1, lane: "headless" }, NOW);
   expect(requeued.failedStarts).toBe(0);
   r.journal.removeResume(requeued, "resume-cancelled", "test reset");
   r.journal.updateWorker("40", REPO, { status: "success" });
   await tick();
   expect(recovered).toEqual(["40", "41"]);
   expect(r.journal.listResumeQueue()).toEqual([]);
  });
 });
 }
});

test("resume queue migration appends to the prior journal and preserves worker state", () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-resume-migration-"));
 const folder = join(dir, "drizzle"); mkdirSync(join(folder, "meta"), { recursive: true });
 const source = join(import.meta.dir, "../drizzle");
 const manifest = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
 manifest.entries = manifest.entries.filter((e: { tag: string }) => !e.tag.startsWith("0022") && !e.tag.startsWith("0023"));
 writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(manifest));
 for (const e of manifest.entries) copyFileSync(join(source, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
 const path = join(dir, "state.sqlite"); const sqlite = new Database(path);
 try {
  sqlite.run("CREATE TABLE ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  sqlite.run("INSERT INTO workers(repo,node_id,root,status,generation) VALUES('acme/widgets','40',460,'parked',7)");
  sqlite.close();
  const journal = new Journal(path);
  try {
   expect(journal.getWorker("40", REPO)).toMatchObject({ root: 460, status: "parked", generation: 7 });
   const entry = journal.enqueueResume({ nodeId: "40", repo: REPO, root: 460, lane: "headless" });
   expect(journal.listResumeQueue()).toEqual([entry]);
  } finally { journal.close(); }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed-start migration preserves existing FIFO entries and retry counts survive reopen", () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-resume-failures-migration-"));
 const folder = join(dir, "drizzle"); mkdirSync(join(folder, "meta"), { recursive: true });
 const source = join(import.meta.dir, "../drizzle");
 const manifest = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
 manifest.entries = manifest.entries.filter((e: { tag: string }) => e.tag !== "0023_resume-start-failures");
 writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(manifest));
 for (const e of manifest.entries) copyFileSync(join(source, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
 const path = join(dir, "state.sqlite");
 const sqlite = new Database(path);
 sqlite.run("CREATE TABLE ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
 migrate(drizzle(sqlite), { migrationsFolder: folder });
 sqlite.run("INSERT INTO resume_queue(id,repo,node_id,root,lane,queued_at) VALUES(8,'acme/widgets','40',1,'headless','2026-10-07T10:00:00Z'),(9,'acme/widgets','41',460,'headless','2026-10-07T10:00:00Z')");
 sqlite.close();
 let journal = new Journal(path);
 try {
  const [head, next] = journal.listResumeQueue();
  expect(head).toMatchObject({ id: 8, nodeId: "40", failedStarts: 0 });
  expect(next).toMatchObject({ id: 9, nodeId: "41", failedStarts: 0 });
  expect(journal.recordResumeStartFailure(head, "first error")).toBe(false);
  expect(journal.recordResumeStartFailure(head, "second error")).toBe(false);
  journal.close(); journal = new Journal(path);
  expect(journal.getResume(REPO, "40")?.failedStarts).toBe(2);
  expect(journal.recordResumeStartFailure(head, "last error")).toBe(true);
  expect(journal.listResumeQueue()).toEqual([next]);
  expect(journal.listEvents(REPO).find(e => e.kind === "resume-dropped")?.detail)
   .toBe("3 consecutive failed starts; last error: last error");
 } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

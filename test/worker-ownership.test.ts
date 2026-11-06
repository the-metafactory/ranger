import { activeRecovery, nodeRecoveryScope } from "../src/recovery.ts";
import * as exec from "../src/exec.ts";
import { claimNode } from "../src/walk.ts";
import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fixturesBin } from "./support.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { FencedError, Journal, type WorkerRow } from "../src/journal.ts";
import { startOwnedWorker, startFailureOutcome, FRESH_START_FAILURE } from "../src/node-ownership.ts";
import { runMergeDesk } from "../src/merge-desk.ts";
import { realGitHub } from "../src/implement.ts";
import { sweepMap } from "../src/sweep.ts";
import { startResumeNode } from "../src/resume.ts";
import { runNodeArgv } from "../src/spawn.ts";

const repo = "acme/widgets";
let dir: string;
let config: RangerConfig;
let a: Journal;
let b: Journal;
let configPath: string;
const originalPath = process.env.PATH;
const originalToken = process.env.RANGER_WRITE_TEST;
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-ownership-"));
 configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({ maps: [{ repo, root: 1, walk: "full", commands: { test: "true" } }],
  state: { journalPath: join(dir, "journal.sqlite") } }));
 config = loadConfig(configPath).config;
 config.auth.defaultWriteTokenEnv = "RANGER_WRITE_TEST";
 config.bot.identity = "ivy-bot";
 process.env.RANGER_WRITE_TEST = "ghp_write";
 process.env.PATH = `${fixturesBin}:${originalPath}`;
 a = new Journal(config.state.journalPath);
 b = new Journal(config.state.journalPath);
 a.upsertWorker({ nodeId: "10", repo, root: 1, status: "awaiting-merge", phase: "awaiting-merge", prNumber: 11 });
});
afterEach(() => { process.env.PATH = originalPath;
 if (originalToken === undefined) delete process.env.RANGER_WRITE_TEST; else process.env.RANGER_WRITE_TEST = originalToken;
 a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
const row = (journal = a): WorkerRow => {
 const value = journal.getWorker("10", repo);
 if (value === null) throw new Error("missing fixture row");
 return value;
};
const merged = { ...realGitHub, getPr: async () => ({ iid: 11, state: "merged" as const, draft: false,
 title: "Feature", body: "", headRef: "node/10", headSha: "a".repeat(40), baseRef: "main",
 mergeState: "mergeable" as const, mergeCommitSha: "b".repeat(40), mergedBy: "alice", webUrl: "", author: "bot" }) };
const desk = (journal: Journal, spawn: (id: string, repo: string, root: number, generation: number) => Promise<number | null>) =>
 runMergeDesk({ config, journal, map: config.maps[0], token: "unused", botIdentity: "bot", github: merged,
  post: async () => "message", spawn });

test("two journal handles race merged close: exactly one reserved generation spawns", async () => {
 let spawns = 0;
 let release: () => void = () => {};
 const gate = new Promise<void>(resolve => { release = resolve; });
 const spawn = async () => { spawns++; await gate; return 1234; };
 const first = desk(a, spawn);
 const second = desk(b, spawn);
 await new Promise(resolve => setTimeout(resolve, 10));
 expect(spawns).toBe(1);
 release();
 const results = await Promise.all([first, second]);
 expect(results.flatMap(result => result.resumed)).toEqual(["10"]);
 expect(row()).toMatchObject({ generation: 1, status: "running", phase: "close", pid: 1234 });
 await desk(b, spawn);
 expect(spawns).toBe(1);
});

test("stale phase, PID, upsert and terminal writes are fenced atomically", () => {
 const old = a.forWorker("10", repo, row().generation);
 const generation = b.beginGeneration("10", repo);
 for (const patch of [{ phase: "close" as const }, { pid: 99 }, { status: "success" as const }]) {
  expect(() => old.updateWorker("10", repo, patch)).toThrow(FencedError);
 }
 expect(() => old.upsertWorker({ nodeId: "10", repo, root: 1, status: "failed" })).toThrow(FencedError);
 expect(row()).toMatchObject({ generation, status: "awaiting-merge", pid: null });
 expect(a.listNodeEvents(repo, "10").filter(event => event.kind === "fenced")).toHaveLength(4);
});

test("operator stop fences the current generation's terminal write", () => {
 a.updateWorker("10", repo, { status: "running", pid: process.pid });
 const scoped = a.forWorker("10", repo, row().generation);
 expect(b.requestStop("10", repo, row().generation, "operator stop", new Date())).toBe(true);
 expect(() => scoped.updateWorker("10", repo, { status: "success", pid: null })).toThrow(FencedError);
 expect(row().status).toBe("stop-requested");
});

for (const throws of [false, true]) test(`failed spawn resolves reservation visibly without a strike (throws=${throws})`, async () => {
 const before = row();
 expect(await startOwnedWorker({ journal: a, row: before, spawn: async () => {
  if (throws) throw new Error("process unavailable");
  return null;
 } })).toBeNull();
 expect(row()).toMatchObject({ status: "awaiting-merge", attempts: 0, generation: before.generation + 1 });
 expect(row().outcome).toContain("resume node 10");
 expect(a.deadmanCount()).toBe(0);
});

test("late null or PID cannot overwrite a newer generation", async () => {
 for (const pid of [null, 123]) {
  const before = row();
  await startOwnedWorker({ journal: a, row: before, spawn: async () => {
   b.beginGeneration("10", repo);
   b.updateWorker("10", repo, { status: "success", pid: null, outcome: "new owner finished" });
   return pid;
  } });
  expect(row()).toMatchObject({ status: "success", pid: null, outcome: "new owner finished" });
 }
});

test("a fast child's terminal write survives parent PID attachment", async () => {
 await startOwnedWorker({ journal: a, row: row(), spawn: async generation => {
  b.adoptReservation("10", repo, generation, 123);
  b.forWorker("10", repo, generation).updateWorker("10", repo, { status: "success", pid: null });
  return 123;
 } });
 expect(row()).toMatchObject({ status: "success", pid: null, generation: 1 });
});

test("pending reservation blocks manual resume through another journal handle", async () => {
 a.reserveWorker(row());
 await expect(startResumeNode("10", config.maps[0], { config, configPath, journal: b }, () => {}))
  .rejects.toThrow(/still claimed/);
});

test("restart parks abandoned reservations and rejects a delayed child", async () => {
 const generation = a.reserveWorker(row(), {}, new Date(0));
 if (generation === null) throw new Error("reservation failed");
 a.close(); a = new Journal(config.state.journalPath);
 const result = await sweepMap({ config, journal: a, map: config.maps[0], token: "unused", botIdentity: "bot", phase: "liveness" });
 expect(result.parked).toEqual(["10"]);
 expect(row().outcome).toContain("abandoned worker reservation");
 expect(() => b.adoptReservation("10", repo, generation, 123)).toThrow(FencedError);
 expect(a.deadmanCount()).toBe(0);
});

test("spawn argv binds the child to the reservation generation", () => {
 expect(runNodeArgv({ nodeId: "10", repo, root: 1, cliEntry: "/tmp/ranger/src/cli.ts", configPath, generation: 7 }))
  .toContain("--generation");
 expect(runNodeArgv({ nodeId: "10", repo, root: 1, cliEntry: "/tmp/ranger/src/cli.ts", configPath, generation: 7 }).at(-1)).toBe("7");
});

test("merged desk and operator resume race on separate handles", async () => {
 let spawns = 0;
 const spawn = async () => { spawns++; await new Promise(resolve => setTimeout(resolve, 10)); return process.pid; };
 await Promise.allSettled([
  desk(a, spawn),
  startResumeNode("10", config.maps[0], { config, configPath, journal: b, spawnRunNode: spawn }, () => {}),
 ]);
 expect(spawns).toBe(1);
 expect(row()).toMatchObject({ generation: 1, pid: process.pid });
});

test("concurrent sweep handles recover a dead supervisor once", async () => {
 a.updateWorker("10", repo, { status: "running", pid: 2_147_483_647, phase: "close" });
 let spawns = 0;
 const respawn = async () => { spawns++; await new Promise(resolve => setTimeout(resolve, 10)); return process.pid; };
 const context = { config, map: config.maps[0], token: "unused", botIdentity: "ivy-bot", phase: "liveness" as const, respawn };
 await Promise.all([sweepMap({ ...context, journal: a }), sweepMap({ ...context, journal: b })]);
 expect(spawns).toBe(0);
 const due = new Date(activeRecovery(a, nodeRecoveryScope(repo, "10"))!.nextEligibleAt!);
 const results = await Promise.all([sweepMap({ ...context, journal: a, now: () => due }), sweepMap({ ...context, journal: b, now: () => due })]);
 expect(spawns).toBe(1);
 expect(results.flatMap(result => result.respawned)).toEqual(["10"]);
 expect(row()).toMatchObject({ generation: 2, attempts: 0, pid: process.pid });
});

test("a delayed desk failure cannot park a newly resumed generation", async () => {
 let arrived: () => void = () => {};
 let release: () => void = () => {};
 const waiting = new Promise<void>(resolve => { arrived = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 const github = { ...merged, getPr: async () => {
  arrived(); await gate;
  return { ...await merged.getPr(), state: "closed" as const };
 } };
 const pass = runMergeDesk({ config, journal: a, map: config.maps[0], token: "unused", botIdentity: "ivy-bot", github,
  post: async () => "message" });
 await waiting;
 await startResumeNode("10", config.maps[0], { config, configPath, journal: b, spawnRunNode: async () => process.pid }, () => {}, { resetRecovery: true });
 release();
 await pass;
 expect(row()).toMatchObject({ generation: 1, status: "claimed", pid: process.pid, outcome: null });
 expect(a.listNodeEvents(repo, "10").some(event => event.kind === "fenced")).toBe(true);
});

test("orphan cleanup precedes a lane wait and preserves the unspent recovery attempt", async () => {
 a.updateWorker("10", repo, { status: "running", pid: 2_147_483_647, phase: "implement", lane: "implement", workerPgid: 1234, worktree: "/tmp/node-10" });
 const read = spyOn(exec, "processGroupCommands").mockResolvedValue(["worker /tmp/node-10"]);
 const kill = spyOn(exec, "killProcessGroup").mockReturnValue(true);
 try {
  const result = await sweepMap({ config, journal: a, map: config.maps[0], token: "unused", botIdentity: "bot",
   phase: "liveness", reservedLanes: new Set(["headless"]), respawn: async () => { throw new Error("lane held"); } });
  expect(result.orphansKilled).toEqual(["10"]);
  expect(kill).toHaveBeenCalledWith(1234);
  expect(row()).toMatchObject({ status: "parked", pid: null, workerPgid: null, attempts: 0 });
 } finally { read.mockRestore(); kill.mockRestore(); }
});

test("start-failure suffix is bounded, deduplicated and preserves infrastructure evidence", () => {
 const evidence = "probe failure class: infrastructure\nprobe failure head: " + "a".repeat(40);
 let outcome: string | null = evidence;
 for (let n = 0; n < 100; n++) outcome = startFailureOutcome(outcome, `failure ${n} ${"x".repeat(1000)}`);
 expect(outcome).toStartWith(evidence);
 expect(outcome.length).toBeLessThan(evidence.length + 430);
 expect(outcome.split("[worker-start]")).toHaveLength(2);
});

const freshClaim = (id: string, spawn: () => Promise<number | null>, claim?: () => Promise<never>) => claimNode({
 journal: a, map: config.maps[0], node: { id, title: "Feature" }, lane: "implement", botIdentity: "ivy-bot", token: "unused",
 cliEntry: "/tmp/ranger/cli.ts", configPath, announce: async () => ({ messageId: "message" }),
 claim: claim ?? (async () => ({ repo, node: id, held: true, assignees: ["ivy-bot"] })), spawnRunNode: spawn,
});

test("throwing graph claim parks unknown remote ownership and holds fresh claims without spending spawn budget", async () => {
 await expect(freshClaim("20", async () => 123, async () => { throw new Error("claim endpoint unavailable"); })).rejects.toThrow("claim endpoint unavailable");
 expect(a.getWorker("20", repo)).toMatchObject({ status: "parked", outcome: expect.stringContaining("graph claim result unknown") });
 expect(a.spawnsToday()).toBe(0);
 expect(await freshClaim("21", async () => 123)).toMatchObject({ claimed: false, error: expect.stringContaining("fresh claims held") });
});

for (const resolution of ["resume", "release", "external-close"] as const) test(`failed fresh spawn holds further claims until ${resolution}`, async () => {
 expect(await freshClaim("20", async () => null)).toMatchObject({ claimed: true, pid: null });
 expect(a.getWorker("20", repo)?.outcome).toContain(FRESH_START_FAILURE);
 let spawns = 0;
 for (let n = 0; n < 3; n++) expect(await freshClaim("21", async () => { spawns++; return 123; })).toMatchObject({ claimed: false, error: expect.stringContaining("fresh claims held") });
 expect(spawns).toBe(0);
 expect(a.getWorker("21", repo)).toBeNull();
 if (resolution === "resume") {
  await startResumeNode("20", config.maps[0], { config, configPath, journal: b, spawnRunNode: async () => process.pid }, () => {}, { resetRecovery: true });
 } else a.updateWorker("20", repo, { status: resolution === "release" ? "released" : "success" });
 expect(await freshClaim("21", async () => 123)).toMatchObject({ claimed: true, pid: 123 });
});

test("abandoned reservation preserves its original probe evidence", async () => {
 const evidence = "probe failure class: infrastructure\nprobe failure head: " + "a".repeat(40);
 a.updateWorker("10", repo, { outcome: evidence });
 a.reserveWorker(row(), {}, new Date(0));
 await sweepMap({ config, journal: a, map: config.maps[0], token: "unused", botIdentity: "bot", phase: "liveness" });
 expect(row().outcome).toContain(evidence);
 expect(row().outcome).toContain("abandoned worker reservation");
 expect(await freshClaim("21", async () => 123)).toMatchObject({ claimed: false, error: expect.stringContaining("fresh claims held") });
});

test.each([1, 2])("dead supervisors exhaust configured respawns=%s durably without fresh frontier replenishment", async maxAttempts => {
 config.workers.maxAttempts = maxAttempts;
 const limit = maxAttempts + 1;
 let now = new Date("2026-11-06T00:00:00Z");
 let spawns = 0;
 a.updateWorker("10", repo, { status: "running", pid: 2_147_483_647, phase: "close" });
 const tick = () => sweepMap({ config, journal: a, map: config.maps[0], token: "unused", botIdentity: "bot",
  now: () => now, phase: "liveness", respawn: async () => { spawns++; return 2_147_483_647; } });
 for (let attempt = 1; attempt <= limit; attempt++) {
  await tick();
  const state = activeRecovery(a, nodeRecoveryScope(repo, "10"))!;
  expect(state.attempts).toBe(attempt);
  expect(row()).toMatchObject({ status: "parked", pid: null, attempts: 0 });
  expect(await freshClaim("10", async () => { throw new Error("fresh claim must not start"); })).toMatchObject({ claimed: false });
  a.close(); a = new Journal(config.state.journalPath);
  await tick();
  expect(spawns).toBe(attempt - 1);
  if (attempt < limit) {
   now = new Date(state.nextEligibleAt!);
   await tick();
   expect(spawns).toBe(attempt);
  }
 }
 now = new Date(now.getTime() + 86_400_000);
 for (let n = 0; n < 5; n++) await tick();
 expect(spawns).toBe(maxAttempts);
 expect(activeRecovery(a, nodeRecoveryScope(repo, "10"))).toMatchObject({ status: "exhausted", attempts: limit, limit });
 expect(row()?.outcome).toContain("--reset-recovery after intervention");
 expect(a.deadmanCount()).toBe(0);
});

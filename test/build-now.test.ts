import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { buildNow, BuildNowRefusal, type BuildNowContext } from "../src/build-now.ts";
import { loadConfig } from "../src/config.ts";
import type { FrontierEntry } from "../src/graph.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import type { AnnounceContext } from "../src/announce.ts";
import type { SpawnRunNodeArgs } from "../src/walk.ts";
import { claimLockFile, withClaimLock } from "../src/claim-lock.ts";

/**
 * node #58 — `ranger build-now`: the walk's claim for one chosen node. The
 * frontier, the claim, the announce and the spawn are injected and recorded;
 * no network, no soma, no process.
 */

const REPO = "acme/widgets";
const BOT = "ivy-bot";

const entry = (
 id: string,
 kind: string,
 autonomy = "auto",
 author = "alice",
): FrontierEntry => ({
 ref: { id },
 node: { id, title: `node ${id}`, kind, autonomy, probes: [] },
 status: "open",
 assignees: [],
 blockedBy: [],
 author,
 url: `https://github.com/${REPO}/issues/${id}`,
 typed: true,
});

const FRONTIER = [
 entry("10", "task"),
 entry("11", "research"),
 entry("12", "grilling", "propose"),
 entry("13", "task"),
 entry("14", "task", "propose", BOT),
 entry("15", "task", "propose"),
 entry("16", "task"),
];

let cleanup: (() => void)[] = [];
afterEach(() => {
 for (const fn of cleanup) fn();
 cleanup = [];
});

function rig(opts: { cap?: number } = {}) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-build-now-"));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(
  configPath,
  stringify({
   version: 1,
   maps: [
    {
     repo: REPO,
     root: 1,
     walk: "full",
     skip: ["13"],
     commands: { test: "bun test" },
     discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
    },
   ],
   bot: { identity: BOT },
   auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
   state: { journalPath: join(dir, "state.sqlite") },
   workers: { spawnCapPerDay: opts.cap ?? 10 },
  }),
 );
 const { config } = loadConfig(configPath);
 const journal = openJournal(config);
 cleanup.push(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
 });
 const announced: AnnounceContext[] = [];
 const claimed: string[] = [];
 const spawned: SpawnRunNodeArgs[] = [];
 let announceFails = false;
 let raceLostTo: string | null = null;
 const ctx = (over: Partial<BuildNowContext> = {}): BuildNowContext => ({
  config,
  configPath,
  journal,
  map: config.maps[0],
  token: "ghp_write",
  botIdentity: BOT,
  readFrontier: async () => FRONTIER,
  registry: {},
  announce: async (_map, a) => {
   announced.push(a);
   if (announceFails) throw new Error("discord down");
   return { messageId: `msg-${a.nodeId}` };
  },
  claim: async (repo, id, identity) => {
   claimed.push(id);
   return raceLostTo === null
    ? { repo, node: id, held: true, assignees: [identity] }
    : { repo, node: id, held: false, holder: raceLostTo, assignees: [raceLostTo] };
  },
  spawnRunNode: async (args) => {
   spawned.push(args);
   return 4242;
  },
  now: () => new Date("2026-10-04T10:00:00Z"),
  ...over,
 });
 return {
  config,
  journal,
  /** A second journal on the same file: another process's view. */
  otherJournal: () => {
   const other = openJournal(config);
   cleanup.unshift(() => other.close());
   return other;
  },
  ctx,
  announced,
  claimed,
  spawned,
  failAnnounce: () => (announceFails = true),
  loseRace: (to: string) => (raceLostTo = to),
 };
}

/** Nothing happened: no announce, no claim, no row, no event, no spawn counted. */
function untouched(r: ReturnType<typeof rig>, nodeId: string) {
 expect(r.announced).toHaveLength(0);
 expect(r.claimed).toHaveLength(0);
 expect(r.spawned).toHaveLength(0);
 expect(r.journal.getWorker(nodeId, REPO)).toBeNull();
 expect(r.journal.listEvents(REPO).filter((e) => e.nodeId === nodeId)).toEqual([]);
 expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(0);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
 try {
  await promise;
 } catch (error) {
  expect(error).toBeInstanceOf(BuildNowRefusal);
  return (error as Error).message;
 }
 throw new Error("expected a refusal");
}

/** A running implement worker on the map's lane. */
function holdLane(journal: Journal, nodeId = "663") {
 journal.upsertWorker({ nodeId, repo: REPO, root: 1, status: "running", lane: "implement", pid: 1 });
}

describe("node #58 — build-now claims and starts a walkable node", () => {
 test("an implement node: announced, claimed, a fresh claimed row, the events, the spawn counted and started", async () => {
  const r = rig();
  const result = await buildNow("10", r.ctx());
  expect(result).toMatchObject({ nodeId: "10", lane: "implement", beside: null, messageId: "msg-10", pid: 4242 });
  expect(r.announced.map((a) => a.nodeId)).toEqual(["10"]);
  expect(r.claimed).toEqual(["10"]);
  expect(r.spawned).toEqual([
   expect.objectContaining({ nodeId: "10", repo: REPO, root: 1, configPath: r.ctx().configPath }),
  ]);
  const row = r.journal.getWorker("10", REPO)!;
  expect(row).toMatchObject({
   status: "claimed",
   lane: "implement",
   root: 1,
   attempts: 0,
   pid: 4242,
   messageId: "msg-10",
   phase: null,
   prNumber: null,
   reviewRound: 0,
  });
  const kinds = r.journal.listEvents(REPO).map((e) => [e.kind, e.detail]).reverse();
  expect(kinds).toEqual([
   ["announced", "msg-10"],
   ["claimed", `by ${BOT}`],
  ]);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(1);
 });

 test("a research node runs in the research lane, even while the implement lane is held", async () => {
  const r = rig();
  holdLane(r.journal);
  const result = await buildNow("11", r.ctx());
  expect(result).toMatchObject({ lane: "research", beside: null });
  expect(r.journal.getWorker("11", REPO)?.lane).toBe("research");
 });

 test("a re-claimed node starts a clean row, not the parked attempt's", async () => {
  const r = rig();
  r.journal.upsertWorker({ nodeId: "10", repo: REPO, root: 1, status: "parked", lane: "implement", phase: "review", prNumber: 9, reviewRound: 2 });
  await buildNow("10", r.ctx());
  expect(r.journal.getWorker("10", REPO)).toMatchObject({ status: "claimed", phase: null, prNumber: null, reviewRound: 0 });
 });

 test("with --force it starts beside the lane holder and names it", async () => {
  const r = rig();
  holdLane(r.journal);
  const result = await buildNow("10", r.ctx({ force: true }));
  expect(result.beside).toMatchObject({ nodeId: "663", repo: REPO, root: 1, status: "running" });
  expect(r.spawned).toHaveLength(1);
 });

 test("a failed announce is reported, not a refusal: the principal chose this node", async () => {
  const r = rig();
  r.failAnnounce();
  const result = await buildNow("10", r.ctx());
  expect(result.messageId).toBeNull();
  expect(result.announceError).toMatch(/discord down/);
  const events = r.journal.listEvents(REPO);
  expect(events.map((e) => e.kind)).toEqual(["claimed"]);
  expect(events[0].detail).toMatch(/announce failed: discord down/);
  expect(r.spawned).toHaveLength(1);
 });
});

describe("node #58 — build-now refuses", () => {
 const cases: [string, string, RegExp][] = [
  ["a HITL node (grilling)", "12", /escalate-hitl.*never forced/],
  ["a skip-listed node", "13", /not walkable/],
  ["a propose node ranger itself authored (node #9)", "14", /escalate-hitl/],
  ["a node not on the frontier", "99", /not on the map's frontier/],
 ];
 for (const [name, id, why] of cases) {
  test(name, async () => {
   const r = rig();
   expect(await refusal(buildNow(id, r.ctx()))).toMatch(why);
   untouched(r, id);
  });
 }

 test("a HITL node even with --force", async () => {
  const r = rig();
  expect(await refusal(buildNow("12", r.ctx({ force: true })))).toMatch(/never forced/);
  untouched(r, "12");
 });

 test("a held implement lane without --force, naming the holder", async () => {
  const r = rig();
  holdLane(r.journal);
  expect(await refusal(buildNow("10", r.ctx()))).toMatch(/held by #663 \(acme\/widgets#1, running\).*--force/);
  untouched(r, "10");
 });

 test("an exhausted daily spawn cap", async () => {
  const r = rig({ cap: 2 });
  const now = new Date("2026-10-04T10:00:00Z");
  r.journal.recordSpawn(now);
  r.journal.recordSpawn(now);
  expect(await refusal(buildNow("10", r.ctx()))).toMatch(/spawn cap is spent \(2\/2\)/);
  expect(r.announced).toHaveLength(0);
  expect(r.claimed).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toBeNull();
  expect(r.journal.spawnsToday(now)).toBe(2);
 });

 test("a paused run", async () => {
  const r = rig();
  r.journal.setPaused(true);
  expect(await refusal(buildNow("10", r.ctx({ force: true })))).toMatch(/dead-man paused/);
  untouched(r, "10");
 });

 test("a vetoed node", async () => {
  const r = rig();
  r.journal.recordVeto("10", "c1");
  expect(await refusal(buildNow("10", r.ctx()))).toMatch(/vetoed/);
  untouched(r, "10");
 });

 test("a node already in flight", async () => {
  const r = rig();
  r.journal.upsertWorker({ nodeId: "10", repo: REPO, root: 1, status: "running", lane: "implement", pid: 7, prNumber: 3 });
  expect(await refusal(buildNow("10", r.ctx({ force: true })))).toMatch(/already in flight/);
  expect(r.journal.getWorker("10", REPO)).toMatchObject({ status: "running", prNumber: 3 });
  expect(r.claimed).toHaveLength(0);
 });

 test("a lost claim race is reported once, never retried, and writes no row", async () => {
  const r = rig();
  r.loseRace("someone-else");
  expect(await refusal(buildNow("10", r.ctx()))).toMatch(/claim race lost to someone-else/);
  expect(r.claimed).toEqual(["10"]);
  expect(r.spawned).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toBeNull();
  expect(r.journal.listEvents(REPO).map((e) => e.kind)).toEqual(["announced"]);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(0);
 });
});

describe("node #58 — concurrent claims are serialized by the claim lock", () => {
 /** An announce slow enough that two unserialized calls would both pass every gate. */
 const slowAnnounce: BuildNowContext["announce"] = async (_map, a) => {
  await Bun.sleep(40);
  return { messageId: `msg-${a.nodeId}` };
 };

 async function both(calls: Promise<unknown>[]) {
  const settled = await Promise.allSettled(calls);
  const ok = settled.filter((s) => s.status === "fulfilled");
  const refused = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as Error] : []));
  for (const error of refused) expect(error).toBeInstanceOf(BuildNowRefusal);
  return { ok, refused: refused.map((e) => e.message) };
 }

 test("the same node twice at once (two journals on one file): one start, one already in flight", async () => {
  const r = rig();
  const other = r.otherJournal();
  const { ok, refused } = await both([
   buildNow("10", r.ctx({ force: true, announce: slowAnnounce })),
   buildNow("10", r.ctx({ force: true, announce: slowAnnounce, journal: other })),
  ]);
  expect(ok).toHaveLength(1);
  expect(refused).toEqual([expect.stringMatching(/already in flight \(claimed\)/)]);
  expect(r.spawned).toHaveLength(1);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(1);
 });

 test("two nodes at once against a cap of one: one spawn, one refusal", async () => {
  const r = rig({ cap: 1 });
  const { ok, refused } = await both([
   buildNow("10", r.ctx({ force: true, announce: slowAnnounce })),
   buildNow("11", r.ctx({ force: true, announce: slowAnnounce, journal: r.otherJournal() })),
  ]);
  expect(ok).toHaveLength(1);
  expect(refused).toEqual([expect.stringMatching(/spawn cap is spent \(1\/1\)/)]);
  expect(r.spawned).toHaveLength(1);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(1);
 });

 test("two implement nodes at once without --force: the second finds the lane held", async () => {
  const r = rig();
  const { ok, refused } = await both([
   buildNow("10", r.ctx({ announce: slowAnnounce })),
   buildNow("16", r.ctx({ announce: slowAnnounce, journal: r.otherJournal() })),
  ]);
  expect(ok).toHaveLength(1);
  expect(refused).toEqual([expect.stringMatching(/held by #(10|16) .*--force/)]);
  expect(r.spawned).toHaveLength(1);
 });

 test("a claim in progress elsewhere (the walk) holds build-now before any gate or announce", async () => {
  const r = rig({ cap: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const walkClaim = withClaimLock(r.otherJournal(), async () => {
   entered();
   await held;
   r.journal.recordSpawn(new Date("2026-10-04T10:00:00Z"));
  });
  await inside;
  const build = buildNow("10", r.ctx({ force: true }));
  await Bun.sleep(400);
  expect(r.announced).toHaveLength(0);
  release();
  await walkClaim;
  expect(await refusal(build)).toMatch(/spawn cap is spent \(1\/1\)/);
  expect(r.announced).toHaveLength(0);
 });

 test("a claim lock held past the wait is a refusal to press again, with nothing touched", async () => {
  const r = rig();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const walkClaim = withClaimLock(r.otherJournal(), async () => {
   entered();
   await held;
  });
  await inside;
  expect(await refusal(buildNow("10", r.ctx({ force: true, claimLockWaitMs: 300 })))).toMatch(
   /another claim is in progress.*press again/,
  );
  untouched(r, "10");
  release();
  await walkClaim;
 });
});

describe("node #58 — the claim lock's fence: a holder whose lease was lost stops at its next write", () => {
 /** Another process reclaimed the claim lock (our lease expired while we were stopped). */
 function reclaimElsewhere(journal: Journal) {
  writeFileSync(
   claimLockFile(journal),
   JSON.stringify({ nonce: "other-process", pid: process.pid, startedAt: Date.now(), leaseUntil: Date.now() + 60_000 }),
  );
 }

 test("lost during the announce: no claim, no row, no event, no spawn counted or started", async () => {
  const r = rig();
  const announce = r.ctx().announce!;
  const message = await refusal(
   buildNow(
    "10",
    r.ctx({
     announce: async (map, a) => {
      reclaimElsewhere(r.journal);
      return announce(map, a);
     },
    }),
   ),
  );
  expect(message).toMatch(
   /stopped mid-claim — claim lock lost mid-claim \(another run owns the lock\) — stopped before the next write; only the announce was posted \(message msg-10\)/,
  );
  expect(r.announced).toHaveLength(1);
  expect(r.claimed).toHaveLength(0);
  expect(r.spawned).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toBeNull();
  expect(r.journal.listEvents(REPO).filter((e) => e.nodeId === "10")).toEqual([]);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(0);
 });

 test("lost during the graph claim: no row, no spawn counted or started, and the refusal names the graph claim left behind", async () => {
  const r = rig();
  const claim = r.ctx().claim!;
  const message = await refusal(
   buildNow(
    "10",
    r.ctx({
     claim: async (...args) => {
      reclaimElsewhere(r.journal);
      return claim(...args);
     },
    }),
   ),
  );
  expect(message).toMatch(/stopped mid-claim/);
  expect(message).toMatch(/#10 is claimed on the graph under ivy-bot with no journal row .*soma graph release 10/);
  expect(r.claimed).toEqual(["10"]);
  expect(r.spawned).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toBeNull();
  expect(r.journal.listEvents(REPO).filter((e) => e.nodeId === "10" && e.kind === "claimed")).toEqual([]);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(0);
 });

 test("our own lease already expired: stopped before the claim, though no one has reclaimed it yet", async () => {
  const r = rig();
  const announce = r.ctx().announce!;
  const message = await refusal(
   buildNow(
    "10",
    r.ctx({
     announce: async (map, a) => {
      const file = claimLockFile(r.journal);
      const lease = JSON.parse(readFileSync(file, "utf8")) as { leaseUntil: number };
      writeFileSync(file, JSON.stringify({ ...lease, leaseUntil: Date.now() - 1 }));
      return announce(map, a);
     },
    }),
   ),
  );
  expect(message).toMatch(/our lease expired/);
  expect(r.claimed).toHaveLength(0);
  expect(r.spawned).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toBeNull();
 });
});

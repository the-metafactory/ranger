import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { buildNow, BuildNowRefusal, type BuildNowContext } from "../src/build-now.ts";
import { ClaimLeaseLost, ClaimLockBusy, withClaimLock } from "../src/claim-lock.ts";
import { changeDrain, type DrainTarget } from "../src/drain.ts";
import { loadConfig } from "../src/config.ts";
import type { FrontierEntry } from "../src/graph.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import type { AnnounceContext } from "../src/announce.ts";
import { claimNode } from "../src/walk.ts";
import type { SpawnRunNodeArgs } from "../src/spawn.ts";

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
];

let cleanup: (() => void)[] = [];
afterEach(() => {
 for (const fn of cleanup) fn();
 cleanup = [];
});

function rig(opts: { cap?: number; lane?: "headless" | "visual" } = {}) {
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
     lane: opts.lane ?? "headless",
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
  readFrontier: async () => ({ frontier: FRONTIER }),
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
 for (const status of ["failed", "parked"] as const) {
  test(`a ${status} worker requires Resume even with force`, async () => {
   const r = rig();
   r.journal.upsertWorker({ nodeId: "10", repo: REPO, root: 1, status, phase: "review", prNumber: 500,
    outcome: "principal must choose the mouse-sensitivity range", reviewRound: 2, verdictSha: "a".repeat(40), verdictBlockers: 1 });
   const before = r.journal.getWorker("10", REPO);
   expect(await refusal(buildNow("10", r.ctx({ force: true })))).toMatch(/resume-node.*Resume/i);
   expect(r.announced).toEqual([]);
   expect(r.claimed).toEqual([]);
   expect(r.spawned).toEqual([]);
   expect(r.journal.getWorker("10", REPO)).toEqual(before);
   expect(r.journal.listEvents(REPO)).toEqual([]);
   expect(r.journal.spawnsToday(r.ctx().now!())).toBe(0);
  });

  test(`the shared fresh claim boundary refuses a ${status} worker`, async () => {
   const r = rig();
   r.journal.upsertWorker({ nodeId: "10", repo: REPO, root: 1, status, phase: "review", prNumber: 500, reviewRound: 2 });
   const before = r.journal.getWorker("10", REPO);
   const ctx = r.ctx();
   const outcome = await claimNode({ ...ctx, node: { id: "10", title: "held" }, lane: "implement", cliEntry: "unused" });
   expect(outcome).toMatchObject({ claimed: false, error: expect.stringMatching(/resume-node.*Resume/i) });
   expect(r.announced).toEqual([]);
   expect(r.claimed).toEqual([]);
   expect(r.spawned).toEqual([]);
   expect(r.journal.getWorker("10", REPO)).toEqual(before);
   expect(r.journal.listEvents(REPO)).toEqual([]);
  });
 }

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

 test("a released node starts a clean row when reclaimed", async () => {
  const r = rig();
  r.journal.upsertWorker({ nodeId: "10", repo: REPO, root: 1, status: "released", lane: "implement", phase: "review", prNumber: 9, reviewRound: 2 });
  await buildNow("10", r.ctx());
  expect(r.journal.getWorker("10", REPO)).toMatchObject({ status: "claimed", phase: null, prNumber: null, reviewRound: 0 });
 });

 test("an equal held id in another repo does not block a fresh claim", async () => {
  const r = rig();
  r.journal.upsertWorker({ nodeId: "10", repo: "other/widgets", root: 1, status: "parked", phase: "review", prNumber: 7 });
  const before = r.journal.getWorker("10", "other/widgets");
  await buildNow("10", r.ctx());
  expect(r.claimed).toEqual(["10"]);
  expect(r.journal.getWorker("10", "other/widgets")).toEqual(before);
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

describe("node #512 — build-now honours drains", () => {
 for (const lane of ["headless", "visual"] as const) {
  const target: DrainTarget = lane === "visual" ? { scope: "lane", lane: "visual" } : { scope: "map", key: `${REPO}#1` };

  test(`${lane}: drain committed before admission refuses with no effects; lifting it restores starts`, async () => {
   const r = rig({ lane });
   const operator = openJournal(r.config);
   try {
    expect(await changeDrain(operator, target, true)).toMatchObject({ drained: true, was: false });
    const before = r.journal.listEvents();
    expect(await refusal(buildNow("10", r.ctx({ force: true })))).toContain("drained");
    expect(r.announced).toEqual([]);
    expect(r.claimed).toEqual([]);
    expect(r.spawned).toEqual([]);
    expect(r.journal.getWorker("10", REPO)).toBeNull();
    expect(r.journal.spawnsToday(r.ctx().now!())).toBe(0);
    expect(r.journal.listEvents()).toEqual(before);
    expect(await changeDrain(operator, target, false)).toMatchObject({ drained: false, was: true });
    expect(await buildNow("10", r.ctx())).toMatchObject({ pid: 4242 });
   } finally { operator.close(); }
  });

  test(`${lane}: admission owns the boundary through spawn before a competing drain can commit`, async () => {
   const r = rig({ lane });
   const operator = openJournal(r.config);
   const entered = Promise.withResolvers<undefined>();
   const release = Promise.withResolvers<undefined>();
   const announcing = r.ctx().announce!;
   const starting = buildNow("10", r.ctx({ announce: async (...args) => {
    entered.resolve();
    await release.promise;
    return announcing(...args);
   } }));
   await entered.promise;
   const draining = changeDrain(operator, target, true);
   try {
    await expect(withClaimLock(operator, async () => {}, 0)).rejects.toBeInstanceOf(ClaimLockBusy);
    expect(operator.isVisualLaneDrained()).toBe(false);
    expect(operator.isMapDrained(`${REPO}#1`)).toBe(false);
    expect(operator.listEvents()).toEqual([]);
    expect(r.claimed).toEqual([]);
    expect(r.spawned).toEqual([]);
    expect(r.journal.getWorker("10", REPO)).toBeNull();
    release.resolve();
    expect(await starting).toMatchObject({ pid: 4242 });
    expect(await draining).toMatchObject({ drained: true, was: false });
    expect(r.claimed).toEqual(["10"]);
    expect(r.spawned).toHaveLength(1);
    expect(r.journal.listEvents().map(e => e.kind).reverse()).toEqual(["announced", "claimed", "drain"]);
    expect(await refusal(buildNow("15", r.ctx({ force: true })))).toContain("drained");
    expect(r.claimed).toEqual(["10"]);
    expect(r.spawned).toHaveLength(1);
   } finally { release.resolve(); await Promise.allSettled([starting, draining]); operator.close(); }
  });

  for (const force of [false, true]) {
   test(`${lane} drain refuses implementation before any effects, force=${force}`, async () => {
    const r = rig({ lane });
    if (lane === "headless") r.journal.setMapDrained(`${REPO}#1`, true);
    else r.journal.setVisualLaneDrained(true);
    const why = await refusal(buildNow("10", r.ctx({ force })));
    expect(why).toContain(lane === "headless" ? "map drained" : "visual lane drained");
    expect(why).toContain(lane === "headless" ? `ranger drain --map ${REPO}#1 --off` : "ranger drain --lane visual --off");
    untouched(r, "10");
   });
  }
 }

 test("a map drain also refuses fresh research", async () => {
  const r = rig();
  r.journal.setMapDrained(`${REPO}#1`, true);
  expect(await refusal(buildNow("11", r.ctx()))).toContain("map drained");
  untouched(r, "11");
 });

 test("visual research still starts while the visual lane is drained", async () => {
  const r = rig({ lane: "visual" });
  r.journal.setVisualLaneDrained(true);
  expect(await buildNow("11", r.ctx())).toMatchObject({ lane: "research", pid: 4242 });
  expect(r.claimed).toEqual(["11"]);
 });

 test("an unrelated map drain and the visual drain do not stop a headless start", async () => {
  const r = rig();
  r.journal.setMapDrained("acme/other#1", true);
  r.journal.setVisualLaneDrained(true);
  expect(await buildNow("10", r.ctx())).toMatchObject({ lane: "implement", pid: 4242 });
  expect(r.claimed).toEqual(["10"]);
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

 test("a build node whose brief soma's audit reports not ready, even with --force (node #154)", async () => {
  const r = rig();
  const readFrontier = async () => ({
   frontier: [...FRONTIER, entry("16", "build")],
   briefs: { ok: true as const, notReady: [{ id: "16", missing: ["## Deliverable"] }] },
  });
  expect(await refusal(buildNow("16", r.ctx({ readFrontier, force: true })))).toMatch(
   /brief-not-ready: build brief not ready — missing `## Deliverable`/,
  );
  untouched(r, "16");
 });

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
  r.journal.recordVeto({ repo: REPO, nodeId: "10", commentId: "c1" });
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

 test("a lost claim race is reported once and resolves its reservation", async () => {
  const r = rig();
  r.loseRace("someone-else");
  expect(await refusal(buildNow("10", r.ctx()))).toMatch(/claim race lost to someone-else/);
  expect(r.claimed).toEqual(["10"]);
  expect(r.spawned).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toMatchObject({ status: "released", outcome: "claim held by someone-else" });
  expect(r.journal.listEvents(REPO).map((e) => e.kind)).toEqual(["announced"]);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(0);
 });
});

describe("node #58 — the claim lock serializes claimers", () => {
 /** A claim that waits for `release` before it answers, so two claimers overlap. */
 function slowClaim(r: ReturnType<typeof rig>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const claim: BuildNowContext["claim"] = async (repo, id, identity) => {
   r.claimed.push(id);
   await gate;
   return { repo, node: id, held: true, assignees: [identity] };
  };
  return { claim, release };
 }

 test("two build-nows of one node: the second waits, then sees it in flight", async () => {
  const r = rig();
  const slow = slowClaim(r);
  const first = buildNow("10", r.ctx({ claim: slow.claim }));
  await Bun.sleep(50);
  const second = buildNow("10", r.ctx({ claim: slow.claim }));
  await Bun.sleep(50);
  slow.release();
  await first;
  expect(await refusal(second)).toMatch(/already in flight \(claimed\)/);
  expect(r.claimed).toEqual(["10"]);
  expect(r.spawned).toHaveLength(1);
  expect(r.journal.spawnsToday(new Date("2026-10-04T10:00:00Z"))).toBe(1);
 });

 test("two build-nows against a cap of one: the second reads the first's spawn", async () => {
  const r = rig({ cap: 1 });
  const slow = slowClaim(r);
  const first = buildNow("10", r.ctx({ claim: slow.claim }));
  await Bun.sleep(50);
  const second = buildNow("11", r.ctx({ claim: slow.claim }));
  await Bun.sleep(50);
  slow.release();
  await first;
  expect(await refusal(second)).toMatch(/daily spawn cap is spent \(1\/1\)/);
  expect(r.spawned.map((s) => s.nodeId)).toEqual(["10"]);
 });

 test("a lock held past the wait is a refusal, and nothing is touched", async () => {
  const r = rig();
  let release!: () => void;
  const held = withClaimLock(r.journal, () => new Promise<void>((resolve) => (release = resolve)));
  await Bun.sleep(50);
  const why = await refusal(buildNow("10", r.ctx({ lockWaitMs: 300 })));
  release();
  await held;
  expect(why).toMatch(/another claim \(a walk tick or a build-now\) is running; try again/);
  untouched(r, "10");
 });

 test("a lost lease stops the claim at its next fence", async () => {
  const r = rig();
  let fences = 0;
  const owned = () => {
   fences += 1;
   if (fences === 2) throw new ClaimLeaseLost("claim lock lost mid-claim (test)");
  };
  await expect(
   claimNode({
    journal: r.journal,
    map: r.config.maps[0],
    node: { id: "10", title: "node 10" },
    lane: "implement",
    botIdentity: BOT,
    token: "ghp_write",
    cliEntry: "cli.ts",
    configPath: "ranger.yaml",
    announce: async (_map, a) => {
     r.announced.push(a);
     return { messageId: "msg-10" };
    },
    claim: async (repo, id, identity) => {
     r.claimed.push(id);
     return { repo, node: id, held: true, assignees: [identity] };
    },
    spawnRunNode: async (args) => {
     r.spawned.push(args);
     return 1;
    },
    owned,
   }),
  ).rejects.toBeInstanceOf(ClaimLeaseLost);
  // The announce went out before the fence that failed; the claim, row and spawn did not.
  expect(r.announced).toHaveLength(1);
  expect(r.claimed).toHaveLength(0);
  expect(r.spawned).toHaveLength(0);
  expect(r.journal.getWorker("10", REPO)).toBeNull();
 });

 test("no run-node spawned: the result carries a null pid and a visible parked reason", async () => {
  const r = rig();
  const result = await buildNow("10", r.ctx({ spawnRunNode: async () => null }));
  expect(result.pid).toBeNull();
  expect(r.journal.getWorker("10", REPO)).toMatchObject({ status: "parked", pid: null, outcome: expect.stringContaining("resume node 10") });
 });
});

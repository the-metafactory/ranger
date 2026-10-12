import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import { runCmd } from "../src/exec.ts";
import { boundProposalComment, boundVeto, principalRatified, principalVetoed, ratifyReadKey, vetoMarker } from "../src/ratify.ts";
import { walk, type WalkResult } from "../src/walk.ts";
import { auditCacheKey } from "../src/frontier-cache.ts";
import { baseConfigLines, bun, cliPath, createCanonicalRepo, fakeDiscord, GIT_ENV, testCliEnv } from "./support.ts";

/**
 * The ratify phase (node #250): the walk tick reads each open proposal's
 * reactions, every page, and resumes it at the close only on the
 * principal's 👍 with no principal 👎. The tick runs in-process (its spawn
 * recorded); fake soma and fake gh answer the graph and GitHub, and the
 * resume-for-close runs as the CLI's run-node.
 */

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const REPO = "acme/widgets";
const marker = (id: string) => `<!-- ranger:proposal node=${id} -->`;

type Reaction = { user: { login: string }; content: string };
const r = (login: string, content: string): Reaction => ({ user: { login }, content });

function frontierEntry(id: string) {
 return {
  ref: { id },
  node: {
   id, title: "Survey third-party API", kind: "research", checkpointId: "api-surveyed", autonomy: "propose",
   probes: [{ type: "git-ref-exists", ref: "research/api-survey" }],
  },
  status: "open", assignees: [], blockedBy: [], author: "alice",
  url: `https://github.com/${REPO}/issues/${id}`, typed: true, parent: { id: "1" },
 };
}

interface Fixture {
 dir: string;
 config: string;
 canonical: string;
 env: NodeJS.ProcessEnv;
 discord: ReturnType<typeof fakeDiscord>;
 calls: string;
 writeFrontier(entries: unknown[]): void;
 state(): Record<string, any>;
 patchState(patch: (s: Record<string, any>) => void): void;
 journal<T>(read: (journal: Journal) => T): T;
 /** One walk tick in-process, its run-node spawns recorded. */
 tick(env?: NodeJS.ProcessEnv, pid?: number | null): Promise<{ result: WalkResult; spawned: string[] }>;
 cli(args: string[], env?: NodeJS.ProcessEnv): ReturnType<typeof runCmd>;
 stop(): void;
}

async function fixture(opts: { pinBot?: boolean; readsPerTick?: number; spawnCapPerDay?: number } = {}): Promise<Fixture> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-ratify-"));
 const { origin, canonical } = await createCanonicalRepo(dir);
 const data = join(dir, "data");
 cpSync(dataDir, data, { recursive: true });
 const root = JSON.parse(readFileSync(join(data, "acme__widgets-node-1.json"), "utf8"));
 writeFileSync(join(data, "acme__widgets-node-1.json"), JSON.stringify({ ...root, author: "jcfischer" }));
 const node = JSON.parse(readFileSync(join(data, "acme__widgets-node-10.json"), "utf8"));
 writeFileSync(join(data, "acme__widgets-node-10.json"), JSON.stringify({ ...node, node: { ...node.node, autonomy: "propose" } }));
 const writeFrontier = (entries: unknown[]) =>
  writeFileSync(join(data, "acme__widgets-frontier.json"), JSON.stringify({ repo: REPO, root: "1", frontier: entries }));
 writeFrontier([frontierEntry("10")]);
 const lines = baseConfigLines(dir, {
  map: [`    canonical: ${canonical}`],
  auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'],
  state: [`  canonicalRoot: ${dir}`],
  workers: ["  wallClockMin: 1", "  maxAttempts: 2", "  deadmanThreshold: 3"],
 })
  .filter((line) => opts.pinBot !== false || line !== "  identity: ivy-bot")
  .map((line) => opts.pinBot === false && line === "bot:" ? "bot: {}" : line)
  .map((line) => opts.spawnCapPerDay !== undefined && line === "  spawnCapPerDay: 10" ? `  spawnCapPerDay: ${opts.spawnCapPerDay}` : line);
 if (opts.readsPerTick !== undefined) lines.push("ratify:", `  readsPerTick: ${opts.readsPerTick}`);
 const config = join(dir, "ranger.yaml");
 writeFileSync(config, lines.join("\n"));
 const statePath = join(dir, "state.json");
 writeFileSync(statePath, JSON.stringify({
  nodes: { "10": { autonomy: "propose", assignees: [], status: "open", checkpoint: "api-surveyed", probes: [{ type: "git-ref-exists", ref: "research/api-survey" }] } },
  decisions: [],
  rootAuthor: "jcfischer",
 }));
 const discord = fakeDiscord();
 const calls = join(dir, "gh-calls.log");
 const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...GIT_ENV,
  PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
  FAKE_SOMA_DIR: data,
  FAKE_SOMA_STATE: statePath,
  FAKE_SOMA_REPO_DIR: origin,
  FAKE_GH_CALLS: calls,
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
  RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
  RANGER_DISCORD_MIN_INTERVAL_MS: "5",
  RANGER_DISCORD_TOKEN: "fake-bot-token",
  RANGER_WRITE_TEST: "ghp_write",
  RANGER_RO_TEST: "ghp_ro",
  RANGER_NO_SPAWN: "1",
  RANGER_WORKER_CMD: join(fixturesBin, "worker"),
 };
 const state = () => JSON.parse(readFileSync(statePath, "utf8"));
 return {
  dir, config, canonical, env, discord, calls, writeFrontier, state,
  patchState: (patch) => {
   const s = state();
   patch(s);
   writeFileSync(statePath, JSON.stringify(s));
  },
  journal: (read) => {
   const journal = openJournal(loadConfig(config).config);
   try { return read(journal); } finally { journal.close(); }
  },
  tick: async (extra = {}, pid: number | null = process.pid) => {
   const saved = { ...process.env };
   Object.assign(process.env, testCliEnv({ ...env, ...extra }));
   const loaded = loadConfig(config).config;
   const journal = openJournal(loaded);
   const spawned: string[] = [];
   try {
    const result = await walk({
     config: loaded, configPath: config, journal,
     spawnRunNode: async ({ nodeId }) => { spawned.push(nodeId); return pid; },
    });
    return { result, spawned };
   } finally {
    journal.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
   }
  },
  cli: (args, extra = {}) => runCmd(bun, [cliPath, ...args, "-c", config], { env: testCliEnv({ ...env, ...extra }) }),
  stop: () => {
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  },
 };
}

/** Walk + run-node through the propose research lane (node #246): node 10 proposed, comment 9001. */
async function propose(f: Fixture): Promise<void> {
 const walked = await runCmd(bun, ["--preload", join(import.meta.dir, "fixtures", "research-timing.ts"), cliPath, "walk", "-c", f.config], { env: testCliEnv(f.env) });
 expect(walked.code).toBe(0);
 const run = await runCmd(bun, ["--preload", join(import.meta.dir, "fixtures", "research-timing.ts"), cliPath, "run-node", "10", "--map", REPO, "-c", f.config], { env: testCliEnv(f.env) });
 expect(run.code).toBe(0);
 expect(JSON.parse(run.stdout).status).toBe("proposed");
 expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ status: "proposed", proposalCommentId: "9001" });
 // Off the frontier from here: the next ticks only ratify.
 f.writeFrontier([]);
}

/** A proposed row seeded straight into the journal (the propose lane is #246's test). */
function seedProposal(f: Fixture, nodeId: string, commentId: string | null, proposedAt: string): void {
 f.journal((j) => j.upsertWorker({
  nodeId, repo: REPO, root: 1, status: "proposed", lane: "research", attempts: 0,
  finishedAt: proposedAt, proposalCommentId: commentId,
  outcome: commentId === null ? "proposal posted, but its comment id is unknown" : `proposal comment ${commentId}`,
 }));
}

/** The comment-list reads fake gh logged for one node. */
const commentReads = (f: Fixture, id: string) =>
 existsSync(f.calls) ? readFileSync(f.calls, "utf8").split("\n").filter((l) => l.includes(`/issues/${id}/comments`)) : [];

const reactionReads = (f: Fixture) =>
 existsSync(f.calls) ? readFileSync(f.calls, "utf8").split("\n").filter((l) => l.includes("/reactions?")) : [];

describe("ratify phase (node #250)", () => {
 test("propose → a non-principal 👍 is ignored → the principal's 👍 on page 2 → ratified close with approved evidence", async () => {
  const f = await fixture();
  try {
   await propose(f);
   const cardsBefore = await f.cli(["escalate", "--json"]);
   expect(cardsBefore.code).toBe(0);
   const card = f.discord.posts.find((p) => p.content.startsWith("🗳️ proposal"))!;
   expect(card).toBeDefined();

   // Someone else's 👍: soma would count it; ranger's pin does not.
   f.patchState((s) => { s.reactions = { "9001": [[r("alice", "+1"), r("jcfischer", "heart")]] }; });
   const ignored = await f.tick();
   expect(ignored.result.ratify.read).toEqual([`${REPO}#10`]);
   expect(ignored.spawned).toEqual([]);
   expect(f.journal((j) => j.getWorker("10", REPO))?.status).toBe("proposed");
   expect(f.state().nodes["10"].status).toBe("open");

   // The principal's 👍, on the second page of reactions.
   f.patchState((s) => { s.reactions["9001"].push([r("jcfischer", "+1")]); });
   const ratified = await f.tick();
   expect(ratified.result.ratify.closing).toEqual([`${REPO}#10`]);
   expect(ratified.spawned).toEqual(["10"]);
   expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ status: "running", phase: "close", lane: "research", pid: process.pid });
   const ratifiedEvent = f.journal((j) => j.listEvents(REPO)).find((e) => e.kind === "ratified");
   expect(ratifiedEvent?.detail).toContain("jcfischer 👍 on proposal comment 9001");
   // Reactions were read under the machine write token, every page in one paged read.
   expect(reactionReads(f).at(-1)).toBe(`repos/${REPO}/issues/comments/9001/reactions?per_page=100`);

   // The spawned resume-for-close: no LLM session, the close cites the proposal.
   const close = await f.cli(["run-node", "10", "--map", REPO], { RANGER_WORKER_CMD: "/nonexistent/worker" });
   expect(close.code).toBe(0);
   const outcome = JSON.parse(close.stdout);
   expect(outcome).toMatchObject({ status: "success", workerExit: null });
   const state = f.state();
   expect(state.nodes["10"].status).toBe("closed");
   expect(state.lastClose).toMatchObject({ proposalComment: "9001", resolutionFile: "", checkpoint: "api-surveyed" });
   expect(state.lastClose.evidence).toContainEqual(expect.objectContaining({ kind: "approved" }));
   expect(state.lastClose.evidence.find((e: { kind: string }) => e.kind === "approved").summary).toContain("ratified by jcfischer");
   expect(realpathSync(state.lastCloseCwd)).toBe(realpathSync(f.canonical));
   expect(state.decisions).toEqual([{ id: "10", gist: "", closedBy: "ivy-bot" }]);
   expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ status: "success", phase: "close", pid: null });
   const kinds = f.journal((j) => j.listEvents(REPO)).map((e) => e.kind);
   expect(kinds).toContain("closed");
   expect(kinds).toContain("decisions-written");
   // The card closes with the node.
   expect(f.discord.edits.some((e) => e.messageId === card.messageId && e.content.startsWith("✅ closed on the graph"))).toBe(true);

   // Nothing reads it again.
   const after = await f.tick();
   expect(after.result.ratify.read).toEqual([]);
  } finally {
   f.stop();
  }
 }, 90_000);

 test("a principal 👍 beside a principal 👎 closes nothing", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.reactions = { "9001": [[r("jcfischer", "+1")], [r("jcfischer", "-1")]] }; });
   const { result, spawned } = await f.tick();
   expect(result.ratify.read).toEqual([`${REPO}#10`]);
   expect(spawned).toEqual([]);
   // The 👎 vetoes it (node #240): released, never closed.
   expect(result.ratify.vetoed).toEqual([`${REPO}#10`]);
   expect(f.journal((j) => j.getWorker("10", REPO))?.status).toBe("released");
   expect(f.state().nodes["10"].status).toBe("open");
   expect(f.state().lastClose).toBeUndefined();
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a ratified close whose run-node did not spawn stays proposed and spawns next tick", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.reactions = { "9001": [[r("jcfischer", "+1")]] }; });
   const failed = await f.tick({}, null);
   expect(failed.result.ratify.errors.join("\n")).toContain("did not spawn");
   expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ status: "proposed", phase: null });
   const next = await f.tick();
   expect(next.spawned).toEqual(["10"]);
   expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ status: "running", phase: "close" });
  } finally {
   f.stop();
  }
 }, 60_000);

 test("reads at most ratify.readsPerTick proposals, oldest first; the rest wait for the next tick", async () => {
  const f = await fixture();
  try {
   f.writeFrontier([]);
   for (let i = 0; i < 11; i++) {
    seedProposal(f, String(100 + i), String(5000 + i), `2026-10-${String(11 - i).padStart(2, "0")}T00:00:00.000Z`);
   }
   const first = await f.tick();
   // Node 110 was proposed on 2026-10-01: oldest, read first; node 100 (2026-10-11) waits.
   expect(first.result.ratify.read).toHaveLength(10);
   expect(first.result.ratify.read[0]).toBe(`${REPO}#110`);
   expect(first.result.ratify.deferred).toEqual([`${REPO}#100`]);
   expect(reactionReads(f)).toHaveLength(10);
   expect(reactionReads(f).some((l) => l.includes("/5000/"))).toBe(false);
   // The one left waiting is read on the next tick.
   const second = await f.tick();
   expect(second.result.ratify.read[0]).toBe(`${REPO}#100`);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a configured readsPerTick caps the reads", async () => {
  const f = await fixture({ readsPerTick: 2 });
  try {
   f.writeFrontier([]);
   for (let i = 0; i < 3; i++) seedProposal(f, String(100 + i), String(5000 + i), `2026-10-0${i + 1}T00:00:00.000Z`);
   const { result } = await f.tick();
   expect(result.ratify.read).toEqual([`${REPO}#100`, `${REPO}#101`]);
   expect(result.ratify.deferred).toEqual([`${REPO}#102`]);
  } finally {
   f.stop();
  }
 }, 60_000);

 for (const mode of ["exit", "page"] as const) {
  test(`a failed reactions read (${mode === "exit" ? "non-2xx" : "a page missing"}) closes nothing and is read again next tick`, async () => {
   const f = await fixture();
   try {
    seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
    f.writeFrontier([]);
    f.patchState((s) => { s.reactions = { "9001": [[r("jcfischer", "+1")]] }; });
    const failed = await f.tick({ FAKE_GH_RATIFY_FAIL: mode });
    expect(failed.spawned).toEqual([]);
    expect(failed.result.ratify.errors.join("\n")).toContain("#10: ratify read failed");
    expect(f.journal((j) => j.getWorker("10", REPO))?.status).toBe("proposed");
    expect(f.journal((j) => j.getHealth(ratifyReadKey(REPO, "10")))).toBeNull();
    const next = await f.tick();
    expect(next.spawned).toEqual(["10"]);
   } finally {
    f.stop();
   }
  }, 60_000);
 }

 test("no journaled comment id: the newest bot comment with the marker binds it", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", null, "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => {
    s.comments = { "10": [
     [{ id: 500, user: { login: "ivy-bot" }, body: `old findings\n${marker("10")}` }, { id: 600, user: { login: "alice" }, body: `copied\n${marker("10")}` }],
     [{ id: 700, user: { login: "ivy-bot" }, body: `findings\n${marker("10")}` }, { id: 750, user: { login: "ivy-bot" }, body: `other node\n${marker("11")}` }, { id: 800, user: { login: "ivy-bot" }, body: "no marker" }],
    ] };
    s.reactions = { "700": [[r("jcfischer", "+1")]] };
   });
   const { spawned } = await f.tick();
   expect(spawned).toEqual(["10"]);
   expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ proposalCommentId: "700", status: "running", phase: "close" });
   expect(f.journal((j) => j.listEvents(REPO)).find((e) => e.kind === "proposal-bound")?.detail).toContain("proposal comment 700");
  } finally {
   f.stop();
  }
 }, 60_000);

 test("no journaled comment id and no marked bot comment: nothing closes and the card says the comment is missing", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", null, "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => {
    s.comments = { "10": [[{ id: 600, user: { login: "alice" }, body: `copied\n${marker("10")}` }, { id: 800, user: { login: "ivy-bot" }, body: "no marker" }]] };
   });
   const first = await f.tick();
   expect(first.spawned).toEqual([]);
   expect(reactionReads(f)).toEqual([]);
   const row = f.journal((j) => j.getWorker("10", REPO))!;
   expect(row).toMatchObject({ status: "proposed", proposalCommentId: null });
   expect(row.outcome).toStartWith("proposal comment missing");
   const cards = await f.cli(["escalate", "--json"]);
   expect(cards.code).toBe(0);
   const card = f.discord.posts.find((p) => p.content.startsWith("🗳️ proposal"))!;
   expect(card.content).toContain("The proposal comment is missing");
   // Not read again: the principal acts on the card.
   const second = await f.tick();
   expect(second.result.ratify.read).toEqual([]);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a write identity that resolves to the principal closes nothing", async () => {
  const f = await fixture({ pinBot: false });
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.reactions = { "9001": [[r("jcfischer", "+1")]] }; });
   const tick = await f.tick({ RANGER_WRITE_TEST: "ghp_principal" });
   expect(tick.result.maps[0]).toMatchObject({ gated: true });
   expect(tick.result.maps[0]!.gateReason).toContain("principal's identity");
   expect(tick.spawned).toEqual([]);
   expect(reactionReads(f)).toEqual([]);

   // A row already resumed at the close refuses under the principal too.
   f.journal((j) => j.updateWorker("10", REPO, { status: "running", phase: "close", pid: null }));
   const close = await f.cli(["run-node", "10", "--map", REPO], { RANGER_WRITE_TEST: "ghp_principal" });
   expect(close.code).not.toBe(0);
   expect(close.stderr).toContain("principal's identity");
   expect(f.state().nodes["10"].status).toBe("open");
   expect(f.state().lastClose).toBeUndefined();
  } finally {
   f.stop();
  }
 }, 60_000);
});

describe("ratify pins (node #250, ruling D6)", () => {
 const reactions = (...list: [string, string][]) => list.map(([author, content]) => ({ author, content }));
 test("only the principal's +1 without the principal's -1 ratifies", () => {
  expect(principalRatified(reactions(["jcfischer", "+1"]), "jcfischer")).toBe(true);
  expect(principalRatified(reactions(["JCFischer", "+1"]), "jcfischer")).toBe(true);
  expect(principalRatified(reactions(["alice", "+1"], ["ivy-bot", "+1"]), "jcfischer")).toBe(false);
  expect(principalRatified(reactions(["jcfischer", "+1"], ["jcfischer", "-1"]), "jcfischer")).toBe(false);
  expect(principalRatified(reactions(["jcfischer", "heart"], ["jcfischer", "hooray"]), "jcfischer")).toBe(false);
  expect(principalRatified(reactions(["jcfischer", "+1"], ["alice", "-1"]), "jcfischer")).toBe(true);
  expect(principalRatified([], "jcfischer")).toBe(false);
 });

 test("the bound comment is the newest bot comment carrying this node's marker", () => {
  const c = (id: number, author: string, body: string) => ({ id, author, body });
  expect(boundProposalComment([c(1, "ivy-bot", marker("10")), c(3, "ivy-bot", marker("10")), c(2, "ivy-bot", marker("10"))], "ivy-bot", "10")).toBe("3");
  expect(boundProposalComment([c(1, "alice", marker("10")), c(2, "ivy-bot", marker("100"))], "ivy-bot", "10")).toBeNull();
  expect(boundProposalComment([], "ivy-bot", "10")).toBeNull();
 });
});

/** Every comment on a node in the fake GitHub state, flattened. */
const commentsOn = (f: Fixture, id: string): { id: number; user: { login: string }; body: string }[] =>
 (f.state().comments?.[id] ?? []).flat();

/** The journal file and its WAL, gone: a lost journal (ruling D1). */
function loseJournal(f: Fixture): void {
 for (const suffix of ["", "-wal", "-shm"]) rmSync(join(f.dir, `state.sqlite${suffix}`), { force: true });
}

/** The audit the walk caches: the machine account's open claim on node 10. */
function auditClaims(f: Fixture, claims: { id: string; assignees: string[] }[]): void {
 writeFileSync(join(f.dir, "data", "acme__widgets-audit.json"), JSON.stringify({
  repo: REPO, root: "1", nodes: 2, closedWithoutReceipt: [], openWithoutCheckpoint: [], openClaimed: claims,
 }));
}

describe("veto (node #240)", () => {
 test("propose → the principal's 👎 beside a 👍 → veto comment, release, refused card, no close, never re-proposed", async () => {
  const f = await fixture();
  try {
   await propose(f);
   expect(f.state().nodes["10"].assignees).toEqual(["ivy-bot"]);
   expect((await f.cli(["escalate", "--json"])).code).toBe(0);
   const card = f.discord.posts.find((p) => p.content.startsWith("🗳️ proposal"))!;
   expect(card).toBeDefined();

   f.patchState((s) => { s.reactions = { "9001": [[r("jcfischer", "+1"), r("alice", "+1")], [r("jcfischer", "-1")]] }; });
   const { result, spawned } = await f.tick();
   expect(result.ratify.vetoed).toEqual([`${REPO}#10`]);
   expect(result.ratify.closing).toEqual([]);
   expect(spawned).toEqual([]);

   // The veto comment, under the machine account, with the marker.
   const veto = commentsOn(f, "10").find((c) => c.body.includes(vetoMarker("10", "9001")))!;
   expect(veto.user.login).toBe("ivy-bot");
   expect(veto.body).toContain("jcfischer reacted 👎");
   expect(veto.body).toContain(`https://github.com/${REPO}/issues/10#issuecomment-9001`);
   // Released, not closed.
   const state = f.state();
   expect(state.nodes["10"]).toMatchObject({ status: "open", assignees: [] });
   expect(state.lastClose).toBeUndefined();
   const row = f.journal((j) => j.getWorker("10", REPO))!;
   expect(row.status).toBe("released");
   expect(row.outcome).toStartWith("vetoed: jcfischer 👎 on proposal comment 9001 — claim released");
   expect(f.journal((j) => j.getVeto("10", REPO))).toMatchObject({ commentId: String(veto.id), proposalCommentId: "9001", root: 1 });
   expect(f.journal((j) => j.listEvents(REPO)).map((e) => e.kind)).toContain("vetoed");
   // The card, edited in place.
   const refused = f.discord.edits.filter((e) => e.messageId === card.messageId).at(-1)!;
   expect(refused.content).toStartWith("🚫 refused, yours to take");
   expect(refused.content).toContain("will never propose it again");

   // Back on the frontier: never claimed into the propose research lane again.
   f.writeFrontier([frontierEntry("10")]);
   const again = await f.tick();
   expect(again.result.maps[0]!.claimed).toEqual([]);
   expect(again.result.maps[0]!.errors.join("\n")).toContain("#10 vetoed — not claimed");
   expect(f.state().nodes["10"].assignees).toEqual([]);
   // One veto comment, however many ticks.
   expect(commentsOn(f, "10").filter((c) => c.body.includes("ranger:veto"))).toHaveLength(1);

   // The desk keeps the refused card as the ratify phase left it.
   const edits = f.discord.edits.length;
   expect((await f.cli(["escalate", "--json"])).code).toBe(0);
   expect(f.discord.edits.length).toBe(edits);
   expect(f.discord.posts.filter((p) => p.content.startsWith("🚫"))).toEqual([]);
  } finally {
   f.stop();
  }
 }, 120_000);

 test("a principal 👎 alone vetoes too", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.nodes["10"].assignees = ["ivy-bot"]; s.reactions = { "9001": [[r("jcfischer", "-1")]] }; });
   const { result } = await f.tick();
   expect(result.ratify.vetoed).toEqual([`${REPO}#10`]);
   expect(commentsOn(f, "10").some((c) => c.body.includes(vetoMarker("10", "9001")))).toBe(true);
   expect(f.state().nodes["10"]).toMatchObject({ status: "open", assignees: [] });
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a failed veto comment POST leaves the proposal as it was; the next tick vetoes", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.nodes["10"].assignees = ["ivy-bot"]; s.reactions = { "9001": [[r("jcfischer", "-1")]] }; });
   const failed = await f.tick({ FAKE_GH_COMMENT_FAIL: "1" });
   expect(failed.result.ratify.vetoed).toEqual([]);
   expect(failed.result.ratify.errors.join("\n")).toContain("#10:");
   expect(f.journal((j) => [j.getWorker("10", REPO)?.status, j.hasVeto("10", REPO)])).toEqual(["proposed", false]);
   expect(f.state().nodes["10"].assignees).toEqual(["ivy-bot"]);
   const next = await f.tick();
   expect(next.result.ratify.vetoed).toEqual([`${REPO}#10`]);
   expect(f.state().nodes["10"].assignees).toEqual([]);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a write identity that resolves to the principal posts no veto and releases nothing", async () => {
  const f = await fixture({ pinBot: false });
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.nodes["10"].assignees = ["ivy-bot"]; s.reactions = { "9001": [[r("jcfischer", "-1")]] }; });
   const tick = await f.tick({ RANGER_WRITE_TEST: "ghp_principal" });
   expect(tick.result.maps[0]!.gateReason).toContain("principal's identity");
   expect(tick.result.ratify.vetoed).toEqual([]);
   expect(commentsOn(f, "10")).toEqual([]);
   expect(f.state().nodes["10"].assignees).toEqual(["ivy-bot"]);
   expect(f.journal((j) => [j.getWorker("10", REPO)?.status, j.hasVeto("10", REPO)])).toEqual(["proposed", false]);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("journal lost after a veto: the veto is rebuilt from the bot's veto comment before any claim", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => { s.nodes["10"].assignees = ["ivy-bot"]; s.reactions = { "9001": [[r("jcfischer", "-1")]] }; });
   expect((await f.tick()).result.ratify.vetoed).toEqual([`${REPO}#10`]);
   const vetoId = commentsOn(f, "10").find((c) => c.body.includes("ranger:veto"))!.id;
   // Someone else's copy of the marker binds nothing.
   f.patchState((s) => { s.comments["10"][0].unshift({ id: 1, user: { login: "alice" }, body: vetoMarker("10", "1") }); });

   loseJournal(f);
   f.writeFrontier([frontierEntry("10")]);
   const { result } = await f.tick();
   expect(result.maps[0]!.claimed).toEqual([]);
   expect(result.maps[0]!.errors.join("\n")).toContain("#10 vetoed — not claimed");
   expect(f.state().nodes["10"].assignees).toEqual([]);
   expect(f.journal((j) => j.getVeto("10", REPO))).toMatchObject({ commentId: String(vetoId), proposalCommentId: "9001" });
   expect(f.journal((j) => j.listEvents(REPO)).map((e) => e.kind)).toContain("veto-recovered");
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a failed veto rebuild read claims no propose research node on the map that tick", async () => {
  const f = await fixture();
  try {
   const failed = await f.tick({ FAKE_GH_RATIFY_FAIL: "exit" });
   expect(failed.result.maps[0]!.claimed).toEqual([]);
   expect(failed.result.maps[0]!.errors.join("\n")).toContain("veto rebuild failed");
   expect(f.state().nodes["10"].assignees).toEqual([]);
   // No veto on GitHub: once the read answers, the node is claimed.
   const next = await f.tick();
   expect(next.result.maps[0]!.claimed).toEqual(["10"]);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("journal lost while a proposal is open: the comment id is recovered from GitHub and the 👍 ratifies", async () => {
  const f = await fixture();
  try {
   await propose(f);
   // The proposal comment soma posted, as GitHub has it.
   f.patchState((s) => {
    s.comments = { "10": [[{ id: 9001, user: { login: "ivy-bot" }, body: `findings\n${marker("10")}` }]] };
    s.reactions = { "9001": [[r("jcfischer", "+1")]] };
   });
   auditClaims(f, [{ id: "10", assignees: ["ivy-bot"] }, { id: "16", assignees: ["alice"] }]);
   loseJournal(f);

   // The first tick after the loss caches the audit; the ratify phase reads it from then on.
   await f.tick();
   const { result, spawned } = await f.tick();
   expect(result.ratify.recovered).toEqual([`${REPO}#10`]);
   expect(result.ratify.closing).toEqual([`${REPO}#10`]);
   expect(spawned).toEqual(["10"]);
   expect(f.journal((j) => j.getWorker("10", REPO))).toMatchObject({ proposalCommentId: "9001", status: "running", phase: "close", root: 1 });
   expect(f.journal((j) => j.listEvents(REPO)).map((e) => e.kind)).toContain("proposal-recovered");
   // Someone else's claim is not ranger's to recover.
   expect(f.journal((j) => j.getWorker("16", REPO))).toBeNull();
  } finally {
   f.stop();
  }
 }, 120_000);

 test("journal lost after a veto whose release failed: the veto is recovered and the claim released", async () => {
  const f = await fixture();
  try {
   seedProposal(f, "10", "9001", "2026-10-01T00:00:00.000Z");
   f.writeFrontier([]);
   f.patchState((s) => {
    s.nodes["10"].assignees = ["ivy-bot"];
    s.comments = { "10": [[
     { id: 9001, user: { login: "ivy-bot" }, body: `findings\n${marker("10")}` },
     { id: 9100, user: { login: "ivy-bot" }, body: `vetoed\n${vetoMarker("10", "9001")}` },
    ]] };
   });
   auditClaims(f, [{ id: "10", assignees: ["ivy-bot"] }]);
   loseJournal(f);
   await f.tick();
   const { result } = await f.tick();
   expect(result.ratify.recovered).toEqual([`${REPO}#10`]);
   expect(result.ratify.vetoed).toEqual([`${REPO}#10`]);
   expect(f.state().nodes["10"].assignees).toEqual([]);
   expect(f.journal((j) => j.getVeto("10", REPO))).toMatchObject({ commentId: "9100", proposalCommentId: "9001" });
   expect(f.journal((j) => j.getWorker("10", REPO))?.status).toBe("released");
   // No second veto comment.
   expect(commentsOn(f, "10").filter((c) => c.body.includes("ranger:veto"))).toHaveLength(1);
  } finally {
   f.stop();
  }
 }, 120_000);
});

describe("veto rebuild reads (node #240)", () => {
 const second = () => ({ ...frontierEntry("11"), url: `https://github.com/${REPO}/issues/11`, node: { ...frontierEntry("11").node, title: "Survey a second API" } });

 test("at most ratify.readsPerTick propose nodes are read a tick; an unread one waits for the next", async () => {
  const f = await fixture({ readsPerTick: 1 });
  try {
   f.writeFrontier([frontierEntry("10"), second()]);
   const { result } = await f.tick();
   expect(result.maps[0]!.claimed).toEqual(["10"]);
   expect(result.maps[0]!.errors.join("\n")).toContain("#11 past ratify.readsPerTick");
   expect(commentReads(f, "10").length).toBeGreaterThan(0);
   expect(commentReads(f, "11")).toEqual([]);
   expect(f.state().nodes["11"]?.assignees ?? []).toEqual([]);
   f.writeFrontier([second()]);
   expect((await f.tick()).result.maps[0]!.claimed).toEqual(["11"]);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("a propose node past the spawn cap's room is not read", async () => {
  const f = await fixture({ spawnCapPerDay: 1 });
  try {
   f.writeFrontier([frontierEntry("10"), second()]);
   const { result } = await f.tick();
   expect(result.maps[0]!.claimed).toEqual(["10"]);
   expect(result.maps[0]!.spawnCapExhausted).toBe(true);
   expect(commentReads(f, "11")).toEqual([]);
  } finally {
   f.stop();
  }
 }, 60_000);

 test("an audit cached before node #240, without openClaimed, is reported: lost proposals are not looked for", async () => {
  const f = await fixture();
  try {
   f.writeFrontier([]);
   await f.tick();
   // soma's audit always carries openClaimed; a record cached by an older ranger does not.
   f.journal((j) => {
    const key = auditCacheKey(REPO, 1);
    const record = JSON.parse(j.getHealth(key)!);
    delete record.good.openClaimed;
    j.setHealth(key, JSON.stringify(record));
   });
   const { result } = await f.tick();
   expect(result.ratify.errors.join("\n")).toContain("carries no openClaimed");
  } finally {
   f.stop();
  }
 }, 60_000);
});

describe("veto pins (node #240, ruling D7)", () => {
 const reactions = (...list: [string, string][]) => list.map(([author, content]) => ({ author, content }));
 test("any principal -1 vetoes; nobody else's does", () => {
  expect(principalVetoed(reactions(["jcfischer", "-1"]), "jcfischer")).toBe(true);
  expect(principalVetoed(reactions(["jcfischer", "+1"], ["JCFischer", "-1"]), "jcfischer")).toBe(true);
  expect(principalVetoed(reactions(["alice", "-1"], ["jcfischer", "+1"]), "jcfischer")).toBe(false);
  expect(principalVetoed([], "jcfischer")).toBe(false);
 });

 test("the bound veto is the newest bot comment carrying this node's veto marker", () => {
  const c = (id: number, author: string, body: string) => ({ id, author, body });
  expect(boundVeto([c(1, "ivy-bot", vetoMarker("10", "5")), c(3, "ivy-bot", vetoMarker("10", "7"))], "ivy-bot", "10"))
   .toEqual({ commentId: "3", proposalCommentId: "7" });
  expect(boundVeto([c(1, "alice", vetoMarker("10", "5")), c(2, "ivy-bot", vetoMarker("100", "5"))], "ivy-bot", "10")).toBeNull();
  expect(boundVeto([c(2, "ivy-bot", "<!-- ranger:veto node=10 proposal=x -->")], "ivy-bot", "10")).toBeNull();
 });

 test("only a marker on the comment's final line binds: a bot comment quoting it mid-body records no veto", () => {
  const c = (id: number, author: string, body: string) => ({ id, author, body });
  expect(boundVeto([c(4, "ivy-bot", `relayed: ${vetoMarker("10", "5")}\nmore text`)], "ivy-bot", "10")).toBeNull();
  expect(boundVeto([c(4, "ivy-bot", `relayed: ${vetoMarker("10", "5")}`)], "ivy-bot", "10")).toBeNull();
  expect(boundVeto([c(4, "ivy-bot", `vetoed\n${vetoMarker("10", "5")}\n\n`)], "ivy-bot", "10"))
   .toEqual({ commentId: "4", proposalCommentId: "5" });
 });
});

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import { runCmd } from "../src/exec.ts";
import { boundProposalComment, principalRatified, ratifyReadKey } from "../src/ratify.ts";
import { walk, type WalkResult } from "../src/walk.ts";
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

async function fixture(opts: { pinBot?: boolean; readsPerTick?: number } = {}): Promise<Fixture> {
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
  .map((line) => opts.pinBot === false && line === "bot:" ? "bot: {}" : line);
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
   expect(f.journal((j) => j.getWorker("10", REPO))?.status).toBe("proposed");
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

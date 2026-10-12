import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";
import { runCmd } from "../src/exec.ts";
import { holdsImplementLane } from "../src/lanes.ts";
import { baseConfigLines, bun, cliPath, createCanonicalRepo, fakeDiscord, GIT_ENV, testCliEnv } from "./support.ts";

/**
 * The propose research lane (node #246): a `propose` research node on a map
 * the principal rooted is claimed into the research lane, researched, and
 * ended with `soma graph close --propose`, against fake soma and GitHub.
 */

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const MARKER = "<!-- ranger:proposal node=10 -->";

function runCli(args: string[], env: NodeJS.ProcessEnv) {
 return runCmd(bun, ["--preload", join(import.meta.dir, "fixtures", "research-timing.ts"), cliPath, ...args], { env: testCliEnv(env) });
}

function frontierEntry(id: string, over: { autonomy?: string; kind?: string; author?: string; title?: string } = {}) {
 return {
  ref: { id },
  node: {
   id,
   title: over.title ?? "Survey third-party API",
   kind: over.kind ?? "research",
   checkpointId: "api-surveyed",
   autonomy: over.autonomy ?? "propose",
   probes: [{ type: "git-ref-exists", ref: "research/api-survey" }],
  },
  status: "open",
  assignees: [],
  blockedBy: [],
  author: over.author ?? "alice",
  url: `https://github.com/acme/widgets/issues/${id}`,
  typed: true,
  parent: { id: "1" },
 };
}

interface Fixture {
 dir: string;
 data: string;
 config: string;
 statePath: string;
 origin: string;
 canonical: string;
 env: NodeJS.ProcessEnv;
 discord: ReturnType<typeof fakeDiscord>;
 writeFrontier(entries: unknown[]): void;
 state(): Record<string, any>;
 journal<T>(read: (journal: Journal) => T): T;
 stop(): void;
}

/** A map whose root `rootAuthor` wrote, with node 10 a `propose` research node `nodeAuthor` filed. */
async function fixture(opts: { rootAuthor?: string; nodeAuthor?: string; walk?: string; pinBot?: boolean } = {}): Promise<Fixture> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-propose-"));
 const { origin, canonical } = await createCanonicalRepo(dir);
 const data = join(dir, "data");
 cpSync(dataDir, data, { recursive: true });
 const root = JSON.parse(readFileSync(join(data, "acme__widgets-node-1.json"), "utf8"));
 writeFileSync(join(data, "acme__widgets-node-1.json"), JSON.stringify({ ...root, author: opts.rootAuthor ?? "jcfischer" }));
 const node = JSON.parse(readFileSync(join(data, "acme__widgets-node-10.json"), "utf8"));
 writeFileSync(join(data, "acme__widgets-node-10.json"), JSON.stringify({
  ...node, author: opts.nodeAuthor ?? "alice", node: { ...node.node, autonomy: "propose" },
 }));
 const writeFrontier = (entries: unknown[]) =>
  writeFileSync(join(data, "acme__widgets-frontier.json"), JSON.stringify({ repo: "acme/widgets", root: "1", frontier: entries }));
 writeFrontier([frontierEntry("10", { author: opts.nodeAuthor })]);
 const lines = baseConfigLines(dir, {
  map: [`    canonical: ${canonical}`],
  auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'],
  state: [`  canonicalRoot: ${dir}`],
  workers: ["  wallClockMin: 1", "  maxAttempts: 2", "  deadmanThreshold: 3"],
 })
  .map((line) => opts.walk !== undefined && line === "    walk: research-only" ? `    walk: ${opts.walk}` : line)
  // Unpinned, the write token's login is the identity: the principal's reaches the not-principal gate.
  .filter((line) => opts.pinBot !== false || line !== "  identity: ivy-bot")
  .map((line) => opts.pinBot === false && line === "bot:" ? "bot: {}" : line);
 const config = join(dir, "ranger.yaml");
 writeFileSync(config, lines.join("\n"));
 const statePath = join(dir, "state.json");
 writeFileSync(statePath, JSON.stringify({
  nodes: { "10": { autonomy: "propose", assignees: [], status: "open", checkpoint: "api-surveyed", probes: [{ type: "git-ref-exists", ref: "research/api-survey" }] } },
  decisions: [],
 }));
 const discord = fakeDiscord();
 const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...GIT_ENV,
  PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
  FAKE_SOMA_DIR: data,
  FAKE_SOMA_STATE: statePath,
  FAKE_SOMA_REPO_DIR: origin,
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
  RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
  RANGER_DISCORD_MIN_INTERVAL_MS: "5",
  RANGER_DISCORD_TOKEN: "fake-bot-token",
  RANGER_WRITE_TEST: "ghp_write",
  RANGER_RO_TEST: "ghp_ro",
  RANGER_NO_SPAWN: "1",
  RANGER_WORKER_CMD: join(fixturesBin, "worker"),
 };
 return {
  dir, data, config, statePath, origin, canonical, env, discord, writeFrontier,
  state: () => JSON.parse(readFileSync(statePath, "utf8")),
  journal: (read) => {
   const journal = new Journal(join(dir, "state.sqlite"));
   try { return read(journal); } finally { journal.close(); }
  },
  stop: () => {
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  },
 };
}

async function walk(f: Fixture, env: NodeJS.ProcessEnv = {}) {
 const result = await runCli(["walk", "-c", f.config], { ...f.env, ...env });
 expect(result.code).toBe(0);
 return JSON.parse(result.stdout).maps[0] as { claimed: string[]; errors: string[] };
}

async function runNode(f: Fixture, env: NodeJS.ProcessEnv = {}) {
 const result = await runCli(["run-node", "10", "--map", "acme/widgets", "-c", f.config], { ...f.env, ...env });
 return { ...result, outcome: result.code === 0 ? JSON.parse(result.stdout) : null };
}

async function cards(f: Fixture) {
 const result = await runCli(["escalate", "--json", "-c", f.config], f.env);
 expect(result.code).toBe(0);
 return JSON.parse(result.stdout).maps[0] as { cards: { nodeId: string; route: string; reason?: string }[] };
}

describe("propose research lane (node #246)", () => {
 test("claims, researches and proposes on a principal-rooted map; the claim stays and the lane frees", async () => {
  const f = await fixture();
  try {
   expect((await walk(f)).claimed).toEqual(["10"]);
   expect(f.state().nodes["10"].assignees).toEqual(["ivy-bot"]);
   expect(f.journal((j) => j.getWorker("10", "acme/widgets"))).toMatchObject({ status: "claimed", lane: "research" });

   const run = await runNode(f);
   expect(run.code).toBe(0);
   expect(run.outcome.status).toBe("proposed");

   // One proposal comment through `close --propose`, under the machine account, from the canonical checkout.
   const state = f.state();
   expect(state.lastClose).toBeUndefined();
   expect(state.nodes["10"].status).toBe("open");
   expect(state.nodes["10"].assignees).toEqual(["ivy-bot"]);
   expect(state.proposals).toHaveLength(1);
   const [proposal] = state.proposals;
   expect(proposal).toMatchObject({ node: "10", identity: "ivy-bot", commentId: 9001 });
   expect(realpathSync(proposal.cwd)).toBe(realpathSync(f.canonical));
   expect(proposal.body).toContain("Surveyed the third-party API");
   expect(proposal.body).toContain("https://github.com/acme/widgets/tree/research/api-survey");
   expect(proposal.body).toContain("draft https://github.com/acme/widgets/pull/31");
   expect(proposal.body).toContain("React 👍 on this comment");
   expect(proposal.body.trimEnd().endsWith(MARKER)).toBe(true);
   // The findings branch was pushed.
   const pushed = await runCmd("git", ["--git-dir", f.origin, "rev-parse", "--verify", "refs/heads/research/api-survey"]);
   expect(pushed.code).toBe(0);

   const row = f.journal((j) => j.getWorker("10", "acme/widgets"))!;
   expect(row).toMatchObject({ status: "proposed", proposalCommentId: "9001", pid: null });
   expect(holdsImplementLane(row)).toBe(false);
   const events = f.journal((j) => j.listEvents("acme/widgets"));
   expect(events.find((e) => e.kind === "proposed")?.detail).toContain("issuecomment-9001");

   // The card links the proposal comment and says to react 👍 there.
   const desk = await cards(f);
   expect(desk.cards.find((c) => c.nodeId === "10")).toMatchObject({ route: "proposal", reason: "proposal" });
   const card = f.discord.posts.find((p) => p.content.startsWith("🗳️ proposal"))!;
   expect(card.content).toContain("**#10**");
   expect(card.content).toContain("https://github.com/acme/widgets/issues/10#issuecomment-9001");
   expect(card.content).toContain("react 👍 there");

   // A second run-node never posts a second proposal.
   const again = await runNode(f);
   expect(again.outcome.status).toBe("refused");
   expect(again.outcome.detail).toContain("is proposed");
   expect(f.state().proposals).toHaveLength(1);

   // The next tick claims another eligible node; the proposed node keeps its claim.
   f.writeFrontier([frontierEntry("17", { autonomy: "auto", title: "Survey the billing API" })]);
   expect((await walk(f)).claimed).toEqual(["17"]);
   expect(f.state().nodes["10"].assignees).toEqual(["ivy-bot"]);
   expect(f.journal((j) => j.getWorker("10", "acme/widgets"))?.status).toBe("proposed");
  } finally {
   f.stop();
  }
 }, 60_000);

 test("soma's --json comment id wins over the text parse (D18)", async () => {
  const f = await fixture({ walk: "full" });
  try {
   expect((await walk(f)).claimed).toEqual(["10"]);
   const run = await runNode(f, { FAKE_SOMA_PROPOSE_OUTPUT: "json" });
   expect(run.outcome.status).toBe("proposed");
   expect(f.journal((j) => j.getWorker("10", "acme/widgets"))?.proposalCommentId).toBe("9101");
  } finally {
   f.stop();
  }
 }, 60_000);

 test("an unparseable comment id stays empty and the card says it is unknown", async () => {
  const f = await fixture();
  try {
   await walk(f);
   const run = await runNode(f, { FAKE_SOMA_PROPOSE_OUTPUT: "garbled" });
   expect(run.outcome.status).toBe("proposed");
   expect(run.outcome.detail).toContain("comment id is unknown");
   expect(f.journal((j) => j.getWorker("10", "acme/widgets"))).toMatchObject({ status: "proposed", proposalCommentId: null });
   await cards(f);
   const card = f.discord.posts.find((p) => p.content.startsWith("🗳️ proposal"))!;
   expect(card.content).toContain("proposal comment id is unknown");
   expect(card.content).not.toContain("issuecomment-");
  } finally {
   f.stop();
  }
 }, 60_000);

 for (const [name, opts] of [
  ["a map the principal did not root", { rootAuthor: "alice" }],
  ["a node the machine account filed", { nodeAuthor: "ivy-bot" }],
 ] as const) {
  test(`escalates as propose-approve on ${name}`, async () => {
   const f = await fixture(opts);
   try {
    expect((await walk(f)).claimed).toEqual([]);
    expect(f.state().nodes["10"].assignees).toEqual([]);
    const desk = await cards(f);
    expect(desk.cards.find((c) => c.nodeId === "10")).toMatchObject({ route: "escalate-hitl", reason: "propose-approve" });
   } finally {
    f.stop();
   }
  }, 60_000);
 }

 test("a write identity that resolves to the principal posts nothing", async () => {
  const f = await fixture({ pinBot: false });
  try {
   await walk(f);
   const run = await runNode(f, { RANGER_WRITE_TEST: "ghp_principal" });
   expect(run.code).not.toBe(0);
   expect(run.stderr).toContain("principal's identity");
   expect(f.state().proposals).toBeUndefined();
   expect(f.journal((j) => j.getWorker("10", "acme/widgets"))?.status).toBe("claimed");
  } finally {
   f.stop();
  }
 }, 60_000);
});

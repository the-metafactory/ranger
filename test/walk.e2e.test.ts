import { describe, expect, test } from "bun:test";
import {
 mkdirSync,
 mkdtempSync,
 readFileSync,
 realpathSync,
 rmSync,
 writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { Journal } from "../src/journal.ts";
import {
 classify,
 loadProbeRegistry,
 type ClassifiedNode,
} from "../src/route.ts";
import { researchCandidates } from "../src/walk.ts";
import { bootstrapWorktree } from "../src/worker.ts";
import type { FrontierEntry } from "../src/graph.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const bun = process.execPath;

const GIT_ENV = {
 GIT_AUTHOR_NAME: "ranger-test",
 GIT_AUTHOR_EMAIL: "ranger-test@example.com",
 GIT_COMMITTER_NAME: "ranger-test",
 GIT_COMMITTER_EMAIL: "ranger-test@example.com",
};

function writeConfig(dir: string, extra: string[] = []): string {
 const config = [
  "version: 1",
  "maps:",
  "  - repo: acme/widgets",
  "    root: 1",
  "    walk: research-only",
  `    canonical: ${join(dir, "canonical")}`,
  "    discord:",
  "      tokenEnv: RANGER_DISCORD_TOKEN",
  '      channelId: "1234567890"',
  "auth:",
  "  readOnlyTokens:",
  '    "acme/*": RANGER_RO_TEST',
  "  writeTokens:",
  '    "acme/*": RANGER_WRITE_TEST',
  "bot:",
  "  identity: ivy-bot",
  "state:",
  `  journalPath: ${join(dir, "state.sqlite")}`,
  `  canonicalRoot: ${dir}`,
  "workers:",
  "  spawnCapPerDay: 10",
  "  wallClockMin: 1",
  "  maxAttempts: 2",
  "  deadmanThreshold: 3",
  ...extra,
 ].join("\n");
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, config);
 return path;
}

function writeState(dir: string, nodes: Record<string, unknown>): string {
 const path = join(dir, "state.json");
 writeFileSync(path, JSON.stringify({ nodes, decisions: [] }, null, 2));
 return path;
}

const RESEARCH_NODE_STATE = {
 assignees: [],
 status: "open",
 checkpoint: "api-surveyed",
 probes: [{ type: "git-ref-exists", ref: "research/api-survey" }],
};

async function runCli(
 args: string[],
 env: NodeJS.ProcessEnv,
 cwd = join(import.meta.dir, ".."),
) {
 return runCmd(bun, [cliPath, ...args], { env, cwd });
}

/** Spin up a fake Discord server; returns {port, posts}. */
function fakeDiscord() {
 const posts: string[] = [];
 const server = Bun.serve({
  port: 0,
  fetch(req) {
   const url = new URL(req.url);
   if (req.method === "POST" && url.pathname.startsWith("/channels/")) {
    posts.push(req.url);
    return Response.json({ id: `discord-msg-${posts.length}` });
   }
   return new Response("not found", { status: 404 });
  },
 });
 return { port: server.port, posts, stop: () => server.stop(true) };
}

describe("ranger walk — claim phase (node #13)", () => {
 test("claims an auto+research frontier node: announce (fail-closed) → soma graph claim → journal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-walk-"));
  const discord = fakeDiscord();
  try {
   const config = writeConfig(dir);
   const statePath = writeState(dir, { "10": RESEARCH_NODE_STATE });

   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5", // keep e2e fast
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_WRITE_TEST: "ghp_write",
    RANGER_NO_SPAWN: "1",
   };

   const result = await runCli(["walk", "-c", config], env);
   expect(result.code).toBe(0);

   // The node was announced + claimed.
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].assignees).toEqual(["ivy-bot"]);
   expect(discord.posts).toHaveLength(1);
   expect(discord.posts[0]).toContain("/channels/1234567890/messages");

   // The journal recorded the claim.
   const journal = new Journal(join(dir, "state.sqlite"));
   const events = journal.listEvents("acme/widgets");
   const kinds = events.map((e) => e.kind);
   expect(kinds).toContain("announced");
   expect(kinds).toContain("claimed");
   expect(events.find((e) => e.kind === "claimed")?.detail).toContain(
    "ivy-bot",
   );
   const worker = journal.getWorker("10");
   expect(worker?.status).toBe("claimed");
   expect(worker?.messageId).toMatch(/^discord-msg-/);
   journal.close();
  } finally {
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("tick runs the escalation cards pass then the walk claim phase (design §1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-tick-"));
  const discord = fakeDiscord();
  try {
   const config = writeConfig(dir);
   const statePath = writeState(dir, { "10": RESEARCH_NODE_STATE });

   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5", // keep e2e fast
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_WRITE_TEST: "ghp_write",
    RANGER_RO_TEST: "ghp_ro", // escalate cards pass needs the read-only token
    RANGER_NO_SPAWN: "1",
   };

   const result = await runCli(["tick", "-c", config], env);
   expect(result.code).toBe(0);
   const report = JSON.parse(result.stdout);
   // The cards pass ran and carded the fixture's HITL/provisioning nodes;
   // the walk claimed node 10. Both phases under one tick.
   expect(report.escalate.maps[0].ok).toBe(true);
   expect(report.escalate.maps[0].posted.sort()).toEqual([
    "11",
    "12",
    "13",
    "14",
   ]);
   expect(report.walk.maps[0].claimed).toEqual(["10"]);

   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].assignees).toEqual(["ivy-bot"]);
  } finally {
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("announce fail-closed: no Discord token → the node is NOT claimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-walk-"));
  try {
   const config = writeConfig(dir);
   const statePath = writeState(dir, { "10": RESEARCH_NODE_STATE });

   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    // RANGER_DISCORD_TOKEN intentionally unset
    RANGER_WRITE_TEST: "ghp_write",
    RANGER_NO_SPAWN: "1",
   };

   const result = await runCli(["walk", "-c", config], env);
   expect(result.code).toBe(0);
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].assignees).toEqual([]); // never claimed
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("refuses a graph-mutating tick under the principal's identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-walk-"));
  try {
   // Same config, but the bot identity is the principal's — the mechanical
   // gate must refuse before any claim.
   const config = writeConfig(dir);
   const content = readFileSync(config, "utf8").replace(
    "  identity: ivy-bot",
    "  identity: jcfischer",
   );
   writeFileSync(config, content);
   const statePath = writeState(dir, { "10": RESEARCH_NODE_STATE });

   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    RANGER_DISCORD_API_BASE: "http://127.0.0.1:1",
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5", // keep e2e fast
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    // a token whose real login is the principal — the refusal must fire even
    // though bot.identity labels it the principal (resolveBotIdentity passes
    // the label↔login match, then assertNotPrincipal refuses).
    RANGER_WRITE_TEST: "ghp_principal",
    RANGER_NO_SPAWN: "1",
   };

   const result = await runCli(["walk", "-c", config], env);
   expect(result.code).toBe(0);
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].assignees).toEqual([]); // gated before any claim
   expect(result.stdout).toContain("principal");
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("refuses when bot.identity does not match the write token's real login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-walk-mismatch-"));
  const dataDir = mkdtempSync(join(tmpdir(), "ranger-walk-mismatch-data-"));
  try {
   // Label says ivy-bot but the write token is the principal's — the identity
   // gate must catch the mismatch, not run mutations under the principal
   // credential while claiming to be the machine account.
   const config = writeConfig(dir);
   const statePath = writeState(dir, { "10": RESEARCH_NODE_STATE });
   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    RANGER_DISCORD_API_BASE: "http://127.0.0.1:1",
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5", // keep e2e fast
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_WRITE_TEST: "ghp_principal", // resolves to jcfischer, not ivy-bot
    RANGER_NO_SPAWN: "1",
   };

   const result = await runCli(["walk", "-c", config], env);
   expect(result.code).toBe(0);
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].assignees).toEqual([]); // gated before any claim
   expect(result.stdout).toContain("does not match");
  } finally {
   rmSync(dir, { recursive: true, force: true });
   rmSync(dataDir, { recursive: true, force: true });
  }
 });
});

describe("ranger run-node — research worker full loop (node #13 acceptance)", () => {
 test("worktree → research worker (findings branch pushed) → gated close (probe on pushed ref) → decisions --write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-run-"));
  try {
   // Seed a real git origin with a main branch, then a canonical clone.
   const seed = join(dir, "seed");
   mkdirSync(seed, { recursive: true });
   writeFileSync(join(seed, "README.md"), "# acme/widgets\n");
   await runCmd("git", ["init", "-b", "main"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["add", "-A"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["commit", "-m", "initial"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });

   const origin = join(dir, "origin.git");
   await runCmd("git", ["clone", "--bare", seed, origin], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
   });

   const canonical = join(dir, "canonical");
   await runCmd("git", ["clone", origin, canonical], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
   });

   const config = writeConfig(dir);
   // Node 10 is already claimed by the bot (walk claimed it in a prior tick).
   const statePath = writeState(dir, {
    "10": { ...RESEARCH_NODE_STATE, assignees: ["ivy-bot"] },
   });

   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    FAKE_SOMA_REPO_DIR: origin,
    RANGER_WRITE_TEST: "ghp_write",
    RANGER_WORKER_CMD: join(fixturesBin, "worker"),
    RANGER_DISCORD_TOKEN: "unused",
   };

   const result = await runCli(
    ["run-node", "10", "--map", "acme/widgets", "-c", config],
    env,
   );
   expect(result.code).toBe(0);

   const outcome = JSON.parse(result.stdout);
   expect(outcome.status).toBe("success");

   // The research branch was pushed to the origin (the close probe's ref).
   const refCheck = await runCmd(
    "git",
    [
     "--git-dir",
     origin,
     "rev-parse",
     "--verify",
     "--quiet",
     "refs/heads/research/api-survey",
    ],
    { env: { ...process.env, ...GIT_ENV } },
   );
   expect(refCheck.code).toBe(0);

   // The node was closed with a gist, decisions re-projected.
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].status).toBe("closed");
   expect(state.decisions).toHaveLength(1);
   expect(state.decisions[0].id).toBe("10");
   expect(state.decisions[0].closedBy).toBe("ivy-bot");

   // The close ran FROM the canonical checkout (design §4 / node #9: probes
   // resolve in the canonical checkout, never the supervisor's cwd). Found
   // live on node #19 — the first close was refused because the git-ref-exists
   // probe resolved against the walk's working tree instead.
   expect(state.lastCloseCwd).toBe(realpathSync(canonical));

   // The journal records the loop.
   const journal = new Journal(join(dir, "state.sqlite"));
   const kinds = journal.listEvents("acme/widgets").map((e) => e.kind);
   expect(kinds).toContain("worker-start");
   expect(kinds).toContain("closed");
   expect(kinds).toContain("decisions-written");
   expect(journal.getWorker("10")?.status).toBe("success");
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("worker crash with no findings → refused, dead-man increments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-run-"));
  try {
   const seed = join(dir, "seed");
   mkdirSync(seed, { recursive: true });
   writeFileSync(join(seed, "README.md"), "# acme/widgets\n");
   await runCmd("git", ["init", "-b", "main"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["add", "-A"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["commit", "-m", "initial"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   const origin = join(dir, "origin.git");
   await runCmd("git", ["clone", "--bare", seed, origin], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
   });
   const canonical = join(dir, "canonical");
   await runCmd("git", ["clone", origin, canonical], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
   });

   const config = writeConfig(dir);
   const statePath = writeState(dir, {
    "10": { ...RESEARCH_NODE_STATE, assignees: ["ivy-bot"] },
   });

   // A fake worker that exits 0 but writes nothing.
   const noopWorker = join(dir, "noop-worker");
   writeFileSync(
    noopWorker,
    "#!/usr/bin/env bash\necho 'noop worker; no findings'\n",
   );
   mkdirSync(dir, { recursive: true });
   // chmod handled below via runCmd-free approach
   const chmodResult = await runCmd("chmod", ["+x", noopWorker], {
    env: process.env,
   });
   expect(chmodResult.code).toBe(0);

   const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    FAKE_SOMA_STATE: statePath,
    FAKE_SOMA_REPO_DIR: origin,
    RANGER_WRITE_TEST: "ghp_write",
    RANGER_WORKER_CMD: noopWorker,
    RANGER_DISCORD_TOKEN: "unused",
   };

   const result = await runCli(
    ["run-node", "10", "--map", "acme/widgets", "-c", config],
    env,
   );
   expect(result.code).toBe(0);
   const outcome = JSON.parse(result.stdout);
   expect(outcome.status).toBe("failed");
   expect(outcome.detail).toContain("no findings.md");

   const journal = new Journal(join(dir, "state.sqlite"));
   expect(journal.deadmanCount()).toBe(1);
   expect(journal.getWorker("10")?.status).toBe("running"); // claim survives; no close attempted
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("ranger sweep — reconcile journal vs reality (design §7)", () => {
 test("respawns a crashed worker below max attempts; parks + releases at max", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-sweep-"));
  try {
   const configPath = writeConfig(dir);
   const { loadConfig } = await import("../src/config.ts");
   const { openJournal } = await import("../src/journal.ts");
   const { sweepMap } = await import("../src/sweep.ts");
   const loaded = loadConfig(configPath);
   const map = loaded.config.maps[0];
   const journal = openJournal(loaded.config);

   const statePath = writeState(dir, {
    "7": { assignees: ["ivy-bot"], status: "open" },
   });
   process.env.FAKE_SOMA_STATE = statePath;
   process.env.FAKE_SOMA_DIR = dataDir;
   process.env.PATH = `${fixturesBin}:${process.env.PATH ?? ""}`;
   process.env.GH_TOKEN = "ghp_write";

   // Crashed worker (dead pid) that has already crashed once → respawned
   // (attempt 1 < 2), then parked + released on the next crash (attempt 2 ≥ 2).
   journal.upsertWorker({
    nodeId: "7",
    repo: map.repo,
    status: "claimed",
    attempts: 1,
    pid: 2_147_483_647,
   });
   const respawned: string[] = [];
   const first = await sweepMap({
    config: loaded.config,
    journal,
    map,
    token: "ghp_write",
    botIdentity: "ivy-bot",
    respawn: async (nodeId) => {
     respawned.push(nodeId);
     return true;
    },
   });
   expect(first.crashed).toBe(1);
   expect(first.respawned).toEqual(["7"]);

   // Second crash at max attempts → parked + claim released.
   const second = await sweepMap({
    config: loaded.config,
    journal,
    map,
    token: "ghp_write",
    botIdentity: "ivy-bot",
    respawn: async () => true,
   });
   expect(second.parked).toEqual(["7"]);
   expect(second.released).toEqual(["7"]);
   expect(journal.getWorker("7")?.status).toBe("released");
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["7"].assignees).toEqual([]);

   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("researchCandidates — lane selection (design §3)", () => {
 test("only walkable research nodes are lane candidates", () => {
  const registry = loadProbeRegistry();
  const frontier = JSON.parse(
   readFileSync(join(dataDir, "acme__widgets-frontier.json"), "utf8"),
  ) as { frontier: FrontierEntry[] };
  const classified: ClassifiedNode[] = frontier.frontier.map((entry) =>
   classify(entry, "acme/widgets", "research-only", registry),
  );
  const candidates = researchCandidates(classified);
  expect(candidates.map((c) => c.id)).toEqual(["10"]);
 });
});

describe("bootstrapWorktree — orphaned branch (node #19 live finding)", () => {
 test("creates the worktree when the worktree branch already exists (no `-b` failure)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-wt-"));
  try {
   const seed = join(dir, "seed");
   mkdirSync(seed, { recursive: true });
   writeFileSync(join(seed, "README.md"), "# acme/widgets\n");
   await runCmd("git", ["init", "-b", "main"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["add", "-A"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["commit", "-m", "initial"], {
    cwd: seed,
    env: { ...process.env, ...GIT_ENV },
   });
   const origin = join(dir, "origin.git");
   await runCmd("git", ["clone", "--bare", seed, origin], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
   });
   const canonical = join(dir, "canonical");
   await runCmd("git", ["clone", origin, canonical], {
    cwd: dir,
    env: { ...process.env, ...GIT_ENV },
   });

   // Orphan the branch: create `node/10-test-node` but never attach a worktree
   // to it (the crash + prune case — the ref outlives its worktree).
   await runCmd("git", ["checkout", "-b", "node/10-test-node"], {
    cwd: canonical,
    env: { ...process.env, ...GIT_ENV },
   });
   await runCmd("git", ["checkout", "main"], {
    cwd: canonical,
    env: { ...process.env, ...GIT_ENV },
   });

   // Pre-fix this failed: `worktree add -b node/10-test-node` → "fatal: a
   // branch named 'node/10-test-node' already exists".
   const worktree = await bootstrapWorktree(
    canonical,
    "10",
    "test-node",
    "ghp_write",
   );
   expect(worktree).toBe(join(canonical, ".worktrees", "node-10"));
   const onBranch = await runCmd(
    "git",
    ["-C", worktree, "branch", "--show-current"],
    { env: { ...process.env, ...GIT_ENV } },
   );
   expect(onBranch.stdout.trim()).toBe("node/10-test-node");
   await runCmd("git", ["worktree", "remove", "--force", worktree], {
    cwd: canonical,
    env: { ...process.env, ...GIT_ENV },
   });
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

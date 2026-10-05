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
import { Journal } from "../src/journal.ts";
import { runCmd } from "../src/exec.ts";
import {
 classify,
 loadProbeRegistry,
 type ClassifiedNode,
} from "../src/route.ts";
import { planTick, researchCandidates } from "../src/walk.ts";
import { bootstrapWorktree } from "../src/worker.ts";
import type { FrontierEntry } from "../src/graph.ts";
import {
 baseConfigLines,
 createCanonicalRepo,
 fakeDiscord,
 GIT_ENV,
 bun,
 cliPath,
} from "./support.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");

function runCli(args: string[], env: NodeJS.ProcessEnv) {
 return runCmd(bun, ["--preload", join(import.meta.dir, "fixtures", "research-timing.ts"), cliPath, ...args], { env });
}

function writeConfig(dir: string, extra: string[] = []): string {
 const config = [
  ...baseConfigLines(dir, {
   map: [`    canonical: ${join(dir, "canonical")}`],
   auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'],
   state: [`  canonicalRoot: ${dir}`],
   workers: ["  wallClockMin: 1", "  maxAttempts: 2", "  deadmanThreshold: 3"],
  }),
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
 autonomy: "auto",
 assignees: [],
 status: "open",
 checkpoint: "api-surveyed",
 probes: [{ type: "git-ref-exists", ref: "research/api-survey" }],
};

for (const [name, tamper] of [
 ["workflow addition", "mkdir -p .github/workflows; printf 'forged CI' > .github/workflows/ci.yml"],
 ["tracked deletion", "git rm README.md"],
 ["tracked rename", "git mv README.md renamed.md"],
 ["base ref moved by worker", "printf 'forged CI' > README.md"],
] as const) {
 test(`research refuses ${name} before pushing or opening a draft`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-research-tamper-"));
  try {
   const { origin } = await createCanonicalRepo(dir);
   const config = writeConfig(dir);
   const statePath = writeState(dir, { "10": { ...RESEARCH_NODE_STATE, assignees: ["ivy-bot"] } });
   const worker = join(dir, "tamper-worker");
   writeFileSync(worker, [
    "#!/usr/bin/env bash", "set -euo pipefail",
    `bash '${join(fixturesBin, "worker")}' "$1"`,
    tamper, "git add -A", 'git commit -m "research extra changes"',
    ...(name === "base ref moved by worker" ? ["git update-ref refs/remotes/origin/main HEAD", "git update-ref refs/heads/main HEAD"] : []),
   ].join("\n"), { mode: 0o755 });
   const result = await runCli(["run-node", "10", "--map", "acme/widgets", "-c", config], {
    ...process.env, ...GIT_ENV, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir, FAKE_SOMA_STATE: statePath, FAKE_SOMA_REPO_DIR: origin,
    RANGER_WRITE_TEST: "ghp_write", RANGER_WORKER_CMD: worker, FAKE_RESEARCH_CI: "failure",
   });
   expect(result.code).toBe(0);
   expect(JSON.parse(result.stdout)).toMatchObject({ status: "failed" });
   expect(JSON.parse(result.stdout).detail).toContain("only findings.md");
   const remote = await runCmd("git", ["--git-dir", origin, "rev-parse", "--verify", "refs/heads/research/api-survey"]);
   expect(remote.code).not.toBe(0);
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.researchPr).toBeUndefined();
   expect(state.lastClose).toBeUndefined();
   expect(state.nodes["10"].status).toBe("open");
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 }, 30_000); // two real run-node CLI processes: under load they outlast 5s
}

test("research retry refuses an altered findings branch before citing CI", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-research-retry-tamper-"));
 try {
  const { origin, canonical } = await createCanonicalRepo(dir);
  const config = writeConfig(dir);
  const statePath = writeState(dir, { "10": { ...RESEARCH_NODE_STATE, assignees: ["ivy-bot"] } });
  const env = {
   ...process.env, ...GIT_ENV, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
   FAKE_SOMA_DIR: dataDir, FAKE_SOMA_STATE: statePath, FAKE_SOMA_REPO_DIR: origin,
   RANGER_WRITE_TEST: "ghp_write", RANGER_WORKER_CMD: join(fixturesBin, "worker"),
   FAKE_RESEARCH_CI: "failure",
  };
  const args = ["run-node", "10", "--map", "acme/widgets", "-c", config];
  const first = await runCli(args, env);
  expect(JSON.parse(first.stdout).status).toBe("parked");
  const originalSha = JSON.parse(readFileSync(statePath, "utf8")).researchPr.head.sha;
  const worktree = join(canonical, ".worktrees", "node-10");
  writeFileSync(join(worktree, "README.md"), "altered CI inputs\n");
  for (const command of [["add", "README.md"], ["commit", "-m", "research extra changes"]]) {
   expect((await runCmd("git", command, { cwd: worktree, env: { ...process.env, ...GIT_ENV } })).code).toBe(0);
  }
  const retry = await runCli(args, { ...env, FAKE_RESEARCH_CI: "success" });
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.stdout).status).toBe("failed");
  expect(JSON.parse(retry.stdout).detail).toContain("only findings.md");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  expect(state.lastClose).toBeUndefined();
  expect(state.researchPrCreates).toBe(1);
  expect(state.nodes["10"].status).toBe("open");
  const remote = await runCmd("git", ["--git-dir", origin, "rev-parse", "refs/heads/research/api-survey"]);
  expect(remote.stdout.trim()).toBe(originalSha);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
}, 30_000); // two real run-node CLI processes: under load they outlast 5s

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
   expect(discord.posts[0].url).toContain("/channels/1234567890/messages");

   // The journal recorded the claim.
   const journal = new Journal(join(dir, "state.sqlite"));
   const events = journal.listEvents("acme/widgets");
   const kinds = events.map((e) => e.kind);
   expect(kinds).toContain("announced");
   expect(kinds).toContain("claimed");
   expect(events.find((e) => e.kind === "claimed")?.detail).toContain(
    "ivy-bot",
   );
   const worker = journal.getWorker("10", "acme/widgets");
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
   const { origin, canonical } = await createCanonicalRepo(dir);

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
   expect(state.researchPr.draft).toBe(true);
   expect(state.researchPr.head.ref).toBe("research/api-survey");
   expect(state.lastClose.ci).toBe(`901@${refCheck.stdout.trim()}`);
   expect(state.researchPr.head.sha).toBe(refCheck.stdout.trim());

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
   expect(journal.getWorker("10", "acme/widgets")?.status).toBe("success");
   expect(journal.getWorker("10", "acme/widgets")?.prNumber).toBe(31);
   journal.close();
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 }, 10_000);

 // Node #81: with extensions.worktreeConfig on, git copies the main
 // config.worktree into the new worktree. The pre-worker snapshot is the
 // state read before the add, so the post-worker check must not see the copy.
 test("a checkout with per-worktree config runs its research node through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-run-worktree-config-"));
  try {
   const { origin, canonical } = await createCanonicalRepo(dir);
   const git = (args: string[]) => runCmd("git", args, { cwd: canonical, env: { ...process.env, ...GIT_ENV } });
   expect((await git(["config", "extensions.worktreeConfig", "true"])).code).toBe(0);
   expect((await git(["config", "--worktree", "ranger.probe", "kept"])).code).toBe(0);
   const config = writeConfig(dir);
   const statePath = writeState(dir, { "10": { ...RESEARCH_NODE_STATE, assignees: ["ivy-bot"] } });
   const result = await runCli(["run-node", "10", "--map", "acme/widgets", "-c", config], {
    ...process.env, ...GIT_ENV, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir, FAKE_SOMA_STATE: statePath, FAKE_SOMA_REPO_DIR: origin,
    RANGER_WRITE_TEST: "ghp_write", RANGER_WORKER_CMD: join(fixturesBin, "worker"), RANGER_DISCORD_TOKEN: "unused",
   });
   expect(result.code).toBe(0);
   expect(JSON.parse(result.stdout).status).toBe("success");
   expect(readFileSync(join(canonical, ".git", "worktrees", "node-10", "config.worktree"), "utf8")).toContain("probe = kept");
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 }, 10_000);

 for (const mode of ["failure", "skipped"]) {
  test(`research CI ${mode} preserves failure budget and resumes after ${mode === "failure" ? "base advancement" : "replace-ref tampering"}`, async () => {
   const dir = mkdtempSync(join(tmpdir(), "ranger-research-ci-"));
   try {
    const { origin, canonical } = await createCanonicalRepo(dir);
    const originalBase = await runCmd("git", ["rev-parse", "origin/main"], { cwd: canonical, env: GIT_ENV });
    const config = writeConfig(dir);
    const statePath = writeState(dir, { "10": { ...RESEARCH_NODE_STATE, assignees: ["ivy-bot"] } });
    const env = {
     ...process.env, ...GIT_ENV, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
     FAKE_SOMA_DIR: dataDir, FAKE_SOMA_STATE: statePath, FAKE_SOMA_REPO_DIR: origin,
     RANGER_WRITE_TEST: "ghp_write", RANGER_WORKER_CMD: join(fixturesBin, "worker"),
     FAKE_RESEARCH_CI: mode,
    };
    const args = ["run-node", "10", "--map", "acme/widgets", "-c", config];
    const failed = await runCli(args, env);
    expect(failed.code).toBe(0);
    expect(JSON.parse(failed.stdout).status).toBe("parked");
    const parked = JSON.parse(readFileSync(statePath, "utf8"));
    expect(parked.nodes["10"].status).toBe("open");
    expect(parked.lastClose).toBeUndefined();
    expect(parked.decisions).toEqual([]);
    const journal = new Journal(join(dir, "state.sqlite"));
    expect(journal.getWorker("10", "acme/widgets")?.status).toBe("parked");
    expect(journal.getWorker("10", "acme/widgets")?.prNumber).toBe(31);
    expect(journal.deadmanCount()).toBe(0);
    expect(journal.isPaused()).toBe(false);
    expect(journal.getWorker("10", "acme/widgets")?.researchBaseSha).toBe(originalBase.stdout.trim());
    journal.bumpDeadman();
    journal.bumpDeadman();
    journal.close();

    const unchanged = await runCli(args, env);
    expect(JSON.parse(unchanged.stdout).status).toBe("parked");
    expect(JSON.parse(readFileSync(statePath, "utf8")).lastClose).toBeUndefined();
    const retryJournal = new Journal(join(dir, "state.sqlite"));
    expect(retryJournal.deadmanCount()).toBe(2);
    expect(retryJournal.isPaused()).toBe(false);
    expect(retryJournal.listEvents("acme/widgets").filter((event) => event.kind === "deadman-paused")).toHaveLength(0);
    retryJournal.close();

    if (mode === "failure") {
     const legacyJournal = new Journal(join(dir, "state.sqlite"));
     legacyJournal.updateWorker("10", "acme/widgets", { researchBaseSha: null });
     legacyJournal.close();
     const missingAnchor = await runCli(args, { ...env, FAKE_RESEARCH_CI: "success" });
     expect(JSON.parse(missingAnchor.stdout)).toMatchObject({ status: "parked" });
     expect(JSON.parse(missingAnchor.stdout).detail).toContain("pre-worker base is missing");
     expect(JSON.parse(readFileSync(statePath, "utf8")).lastClose).toBeUndefined();
     const restoreJournal = new Journal(join(dir, "state.sqlite"));
     expect(restoreJournal.deadmanCount()).toBe(2);
     expect(restoreJournal.isPaused()).toBe(false);
     restoreJournal.updateWorker("10", "acme/widgets", { researchBaseSha: originalBase.stdout.trim() });
     restoreJournal.close();
    }

    const git = async (args: string[], cwd = canonical) => {
     const result = await runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
     expect(result.code).toBe(0);
     return result.stdout.trim();
    };
    if (mode === "failure") {
     writeFileSync(join(canonical, "README.md"), "# advanced main\n");
     await git(["add", "README.md"]);
     await git(["commit", "-m", "advance base"]);
     await git(["push", "origin", "main"]);
     await git(["fetch", "origin"]);
     expect(await git(["rev-parse", "origin/main"])).not.toBe(originalBase.stdout.trim());
    } else {
     const worktree = join(canonical, ".worktrees", "node-10");
     writeFileSync(join(worktree, "findings.md"), "# forged replacement findings\n");
     await git(["add", "findings.md"], worktree);
     await git(["commit", "-m", "replacement findings"], worktree);
     const replacement = await git(["rev-parse", "HEAD"], worktree);
     await git(["reset", "--hard", parked.researchPr.head.sha], worktree);
     await git(["replace", parked.researchPr.head.sha, replacement]);
     expect(await git(["show", `${parked.researchPr.head.sha}:findings.md`])).toContain("forged replacement findings");
    }

    // Simulate an operator rerunning CI successfully on the same head.
    // The fixture worker cannot recreate its branch, so success also proves
    // the supervisor resumed the tail without spawning another worker.
    const resumed = await runCli(args, { ...env, FAKE_RESEARCH_CI: "success" });
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "success", workerExit: null });
    const closed = JSON.parse(readFileSync(statePath, "utf8"));
    expect(closed.nodes["10"].status).toBe("closed");
    expect(closed.researchPrCreates).toBe(1);
    expect(closed.lastClose.ci).toBe(`901@${closed.researchPr.head.sha}`);
    const resolution = readFileSync(join(tmpdir(), "ranger-close-acme__widgets-10.md"), "utf8");
    expect(resolution).toContain("Surveyed the third-party API");
    expect(resolution).not.toContain("forged replacement findings");
    const resumedJournal = new Journal(join(dir, "state.sqlite"));
    expect(resumedJournal.listEvents("acme/widgets").filter((event) => event.kind === "pr-opened")).toHaveLength(1);
    resumedJournal.close();
   } finally {
    rmSync(dir, { recursive: true, force: true });
   }
  }, 30_000);
 }

 test("worker crash with no findings → refused, dead-man increments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-run-"));
  try {
   const { origin } = await createCanonicalRepo(dir);

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
   // The claim survives on the tracker; the row is terminal, not a "running"
   // row with no PID that sweep can never see (#23 F1).
   expect(journal.getWorker("10", "acme/widgets")?.status).toBe("failed");
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
   journal.upsertWorker({ root: 1,
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
     return 2_147_483_646; // the respawned supervisor's pid (dead too)
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
    respawn: async () => 2_147_483_646,
   });
   expect(second.parked).toEqual(["7"]);
   expect(second.released).toEqual(["7"]);
   expect(journal.getWorker("7", "acme/widgets")?.status).toBe("released");
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
   const { canonical } = await createCanonicalRepo(dir);

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

/**
 * #37: `ranger serve` names `planTick(...).take[0]` as the next job, so the
 * real walk must claim exactly `take` — checked by running it, not by reading
 * its source. Once with no veto, once with the only walkable node vetoed.
 */
describe("walk claims exactly planTick's take (#37)", () => {
 const frontier = (
  JSON.parse(
   readFileSync(join(dataDir, "acme__widgets-frontier.json"), "utf8"),
  ) as { frontier: FrontierEntry[] }
 ).frontier.map((e) =>
  classify(e, "acme/widgets", "research-only", loadProbeRegistry(), {
   botIdentity: "ivy-bot",
  }),
 );

 for (const vetoed of [[], ["10"]] as string[][]) {
  test(`vetoed: [${vetoed.join(", ")}]`, async () => {
   const dir = mkdtempSync(join(tmpdir(), "ranger-walk-plan-"));
   const discord = fakeDiscord();
   try {
    const config = writeConfig(dir);
    const statePath = writeState(dir, { "10": RESEARCH_NODE_STATE });
    const journal = new Journal(join(dir, "state.sqlite"));
    for (const id of vetoed) journal.recordVeto(id, `comment-${id}`);
    journal.close();

    const result = await runCli(["walk", "-c", config], {
     ...process.env,
     ...GIT_ENV,
     PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
     FAKE_SOMA_DIR: dataDir,
     FAKE_SOMA_STATE: statePath,
     RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
     RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
     RANGER_DISCORD_MIN_INTERVAL_MS: "5",
     RANGER_DISCORD_TOKEN: "fake-bot-token",
     RANGER_WRITE_TEST: "ghp_write",
     RANGER_NO_SPAWN: "1",
    });
    expect(result.code).toBe(0);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
     nodes: Record<string, { assignees: string[] }>;
    };
    const claimed = Object.entries(state.nodes)
     .filter(([, n]) => n.assignees.includes("ivy-bot"))
     .map(([id]) => id);
    const plan = planTick(frontier, {
     laneBusy: false,
     vetoed: (id) => vetoed.includes(id),
    });
    expect(claimed).toEqual(plan.take.map((n) => n.id));
   } finally {
    discord.stop();
    rmSync(dir, { recursive: true, force: true });
   }
  });
 }
});

describe("ranger walk — GitHub budget deferral (src/budget.ts)", () => {
 test("a rate-limited frontier read gates the map: nothing announced, nothing claimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-walk-budget-"));
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
    FAKE_SOMA_RATE_LIMITED: "1",
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5",
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_WRITE_TEST: "ghp_write",
    RANGER_NO_SPAWN: "1",
   };

   const result = await runCli(["walk", "-c", config], env);
   expect(result.code).toBe(0);
   const report = JSON.parse(result.stdout);
   expect(report.maps[0].gated).toBe(true);
   expect(report.maps[0].gateReason).toContain("secondary rate limit");
   expect(report.maps[0].errors).toEqual([]);
   expect(report.maps[0].claimed).toEqual([]);
   expect(discord.posts).toHaveLength(0);
   const state = JSON.parse(readFileSync(statePath, "utf8"));
   expect(state.nodes["10"].assignees ?? []).toEqual([]);
  } finally {
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

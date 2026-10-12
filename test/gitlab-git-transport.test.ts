import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig } from "../src/config.ts";
import { runCmd } from "../src/exec.ts";
import { parseForgeRef } from "../src/forge-ref.ts";
import {
 cloneUrl,
 fastForwardCanonical,
 gitAuthEnv,
 gitConfigSnapshot,
 gitCredential,
 GitSafetyError,
 vettedPush,
} from "../src/git-ops.ts";
import { gitlabCommitAuthor, WriteGateError } from "../src/identity.ts";
import { bootstrapCanonical, bootstrapWorktree } from "../src/worker.ts";
import { workerEnv } from "../src/worker-env.ts";
import { GIT_ENV } from "./support.ts";

/**
 * Node #127: ranger clones, fetches and pushes a GitLab map's canonical
 * checkout with the bot credential, scoped to the map's host, never persisted,
 * and commits under the bot's GitLab identity.
 */

const host = "gitlab.example.org";
const repo = `gitlab:${host}/claw/crisis-simulator`;
const sentinel = "glpat-node127-sentinel";
const basic = (userinfo: string) => `AUTHORIZATION: basic ${Buffer.from(userinfo).toString("base64")}`;

describe("gitAuthEnv: the header follows the forge", () => {
 test("GitHub keeps today's unscoped header, byte for byte", () => {
  const env = gitAuthEnv(gitCredential("acme/widgets", "ghp_write"), {});
  expect(env).toEqual({
   GIT_CONFIG_COUNT: "1",
   GIT_CONFIG_KEY_0: "http.extraheader",
   GIT_CONFIG_VALUE_0: basic("ghp_write:x-oauth-basic"),
  });
  expect(gitAuthEnv(gitCredential("github:github.com/acme/widgets", "ghp_write"), {})).toEqual(env);
 });

 test("GitLab scopes the header to the map's host with user oauth2", () => {
  const env = gitAuthEnv(gitCredential(repo, sentinel), { PATH: "/bin" });
  expect(env).toEqual({
   PATH: "/bin",
   GIT_CONFIG_COUNT: "1",
   GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
   GIT_CONFIG_VALUE_0: basic(`oauth2:${sentinel}`),
  });
  expect(Object.values(env)).not.toContain("http.extraheader");
 });

 test("git itself sends the GitLab header to the map's host and to no other", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranger-urlmatch-"));
  try {
   const env = gitAuthEnv(gitCredential(repo, sentinel), { PATH: process.env.PATH, HOME: home });
   const header = (url: string) =>
    runCmd("git", ["config", "--get-urlmatch", "http.extraheader", url], { cwd: home, env });
   const own = await header(`https://${host}/claw/crisis-simulator.git`);
   expect(own.code).toBe(0);
   expect(own.stdout.trim()).toBe(basic(`oauth2:${sentinel}`));
   for (const url of [
    "https://other.example.org/claw/crisis-simulator.git",
    `https://${host}.evil.example/claw/crisis-simulator.git`,
    `http://${host}/claw/crisis-simulator.git`,
    "https://github.com/claw/crisis-simulator.git",
   ]) {
    const other = await header(url);
    expect({ url, code: other.code, stdout: other.stdout.trim() }).toEqual({ url, code: 1, stdout: "" });
   }
  } finally {
   rmSync(home, { recursive: true, force: true });
  }
 });
});

describe("cloneUrl", () => {
 test("GitHub's clone URL is unchanged; GitLab's is the map's host and full path", () => {
  expect(cloneUrl(parseForgeRef("acme/widgets"))).toBe("https://github.com/acme/widgets.git");
  expect(cloneUrl(parseForgeRef(repo))).toBe(`https://${host}/claw/crisis-simulator.git`);
  expect(cloneUrl(parseForgeRef(`gitlab:${host}/a/b/c`))).toBe(`https://${host}/a/b/c.git`);
 });
});

describe("no write credential for the map: clone, fetch and push refuse before git runs", () => {
 let dir: string;
 beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ranger-no-cred-"));
 });
 afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
 });

 test("an empty or blank token is no credential", () => {
  for (const token of ["", "  "]) {
   expect(() => gitCredential(repo, token)).toThrow(GitSafetyError);
   expect(() => gitCredential(repo, token)).toThrow(/no write credential/);
  }
 });

 test("clone refuses an empty credential and another map's credential", async () => {
  const target = join(dir, "canonical");
  const forge = parseForgeRef(repo);
  await expect(bootstrapCanonical(target, repo, { token: "", forge })).rejects.toThrow(/no write credential/);
  await expect(bootstrapCanonical(target, repo, gitCredential(`gitlab:other.example.org/claw/crisis-simulator`, sentinel)))
   .rejects.toThrow(/no write credential/);
  await expect(bootstrapCanonical(target, repo, gitCredential("claw/crisis-simulator", sentinel)))
   .rejects.toThrow(/no write credential/);
  expect(existsSync(target)).toBeFalse();
 });

 test("fetch and push refuse an empty credential, not with a git error", async () => {
  // Neither path exists: had git run, it would have failed some other way.
  const missing = join(dir, "missing");
  const credential = { token: " ", forge: parseForgeRef(repo) };
  await expect(fastForwardCanonical(missing, "main", credential, { attempts: 1 })).rejects.toThrow(/no write credential/);
  await expect(vettedPush({ worktree: missing, canonical: missing, branch: "node/1-x", credential, configSnapshot: "x" }))
   .rejects.toThrow(/no write credential/);
 });
});

/** Every file under `root`, recursively (the checkout, its .git and worktrees). */
function filesUnder(root: string): string[] {
 const out: string[] = [];
 for (const name of readdirSync(root)) {
  const path = join(root, name);
  const st = statSync(path);
  if (st.isDirectory()) out.push(...filesUnder(path));
  else if (st.isFile()) out.push(path);
 }
 return out;
}

describe("a GitLab map's canonical checkout against a local bare repo", () => {
 let dir: string;
 let origin: string;
 let savedHome: string | undefined;

 beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-gitlab-git-"));
  const seed = join(dir, "seed");
  mkdirSync(seed);
  writeFileSync(join(seed, "README.md"), "# crisis-simulator\n");
  const git = (args: string[], cwd: string) => runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
  await git(["init", "-b", "main"], seed);
  await git(["add", "-A"], seed);
  await git(["commit", "-m", "initial"], seed);
  origin = join(dir, "origin.git");
  await git(["clone", "--bare", seed, origin], dir);
  // The supervisor's git reads only $HOME's config: point the map's https
  // URL at the bare repo, so the real clone/fetch/push run offline.
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), `[url "file://${origin}"]\n\tinsteadOf = https://${host}/claw/crisis-simulator.git\n`);
  savedHome = process.env.HOME;
  process.env.HOME = home;
 });

 afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
 });

 test("clone, fetch and push leave no credential in .git/config or the worktree", async () => {
  const canonical = join(dir, "canonical");
  const credential = gitCredential(repo, sentinel);
  expect(await bootstrapCanonical(canonical, repo, credential)).toBeTrue();

  const config = (...args: string[]) =>
   runCmd("git", ["config", "--file", join(canonical, ".git", "config"), ...args], { cwd: canonical });
  expect((await config("--get", "remote.origin.url")).stdout.trim()).toBe(`https://${host}/claw/crisis-simulator.git`);

  await fastForwardCanonical(canonical, "main", credential, { attempts: 1 });
  const worktree = await bootstrapWorktree(canonical, "127", "transport", credential);
  writeFileSync(join(worktree, "built.txt"), "built\n");
  const git = (args: string[]) => runCmd("git", args, { cwd: worktree, env: { ...process.env, ...GIT_ENV } });
  await git(["add", "built.txt"]);
  expect((await git(["commit", "-m", "build"])).code).toBe(0);
  await vettedPush({ worktree, canonical, branch: "node/127-transport", credential, configSnapshot: gitConfigSnapshot(canonical) });
  const pushed = await runCmd("git", ["for-each-ref", "--format=%(refname)", "refs/heads/node/127-transport"], { cwd: origin });
  expect(pushed.stdout.trim()).toBe("refs/heads/node/127-transport");

  const files = filesUnder(canonical);
  expect(files).toContain(join(canonical, ".git", "config"));
  expect(files).toContain(join(worktree, "built.txt"));
  const needles = [sentinel, Buffer.from(`oauth2:${sentinel}`).toString("base64"), "oauth2:", "extraheader"];
  for (const file of files) {
   const contents = readFileSync(file).toString("latin1");
   for (const needle of needles) {
    expect({ file, needle, found: contents.includes(needle) }).toEqual({ file, needle, found: false });
   }
  }
  expect((await config("--get-regexp", "^http\\.")).stdout).toBe("");
 });
});

describe("GitLab commit identity", () => {
 const bot = "project_123_bot_a1b2c3";

 test("the bot's commit_email when GitLab reports one", () => {
  expect(gitlabCommitAuthor({ id: 456, username: bot, commit_email: "bot@example.org" }, host))
   .toEqual({ name: bot, email: "bot@example.org" });
 });

 test("the private noreply address when commit_email is empty or absent", () => {
  for (const commit_email of ["", "   ", null, undefined]) {
   expect(gitlabCommitAuthor({ id: 456, username: bot, commit_email }, host))
    .toEqual({ name: bot, email: `456-${bot}@users.noreply.${host}` });
  }
 });

 test("refuses an identity git could not write", () => {
  for (const user of [
   { id: 456, username: bot, commit_email: "bot@example.org\nX-Evil: 1" },
   { id: 456, username: bot, commit_email: "Bot <bot@example.org>" },
   { id: 456, username: bot, commit_email: " bot@example.org" },
   { username: bot },
   { id: "456", username: bot },
   { id: 0, username: bot },
   { id: 456, username: "two words" },
   { id: 456 },
   null,
  ]) {
   expect(() => gitlabCommitAuthor(user, host)).toThrow(WriteGateError);
  }
 });
});

describe("workerEnv: the map's commit author", () => {
 const config = {
  auth: { readOnlyTokens: {}, writeTokens: {} },
  principal: { login: { "github:github.com": "boss-gh", [`gitlab:${host}`]: "boss-gl" } },
  bot: { identity: "ivy-agent" },
 } as unknown as RangerConfig;
 const author = { name: "project_123_bot_a1b2c3", email: `456-project_123_bot_a1b2c3@users.noreply.${host}` };

 test("a GitLab map commits as the bot's GitLab identity, author and committer", () => {
  const env = workerEnv(config, repo, "/tmp/session-journal", author);
  expect(env.GIT_AUTHOR_NAME).toBe(author.name);
  expect(env.GIT_AUTHOR_EMAIL).toBe(author.email);
  expect(env.GIT_COMMITTER_NAME).toBe(author.name);
  expect(env.GIT_COMMITTER_EMAIL).toBe(author.email);
 });

 test("a GitLab map without its commit identity refuses, never GitHub's noreply", () => {
  expect(() => workerEnv(config, repo, "/tmp/session-journal")).toThrow(/no GitLab commit identity/);
 });

 test("a GitHub map is unchanged: bot.identity at users.noreply.github.com", () => {
  const env = workerEnv(config, "acme/widgets", "/tmp/session-journal");
  expect(env.GIT_AUTHOR_NAME).toBe("ivy-agent");
  expect(env.GIT_AUTHOR_EMAIL).toBe("ivy-agent@users.noreply.github.com");
  expect(env.GIT_COMMITTER_NAME).toBe("ivy-agent");
  expect(env.GIT_COMMITTER_EMAIL).toBe("ivy-agent@users.noreply.github.com");
 });
});

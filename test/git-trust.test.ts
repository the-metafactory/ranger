import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { gitConfigSnapshot, gitStateChanges, keyLabel, readGitState } from "../src/git-ops.ts";
import {
 checkKnownGood,
 recordIfUnchanged,
 recordKnownGood,
 tamperOutcome,
 trustCurrentGitState,
 trustedSnapshot,
 trustFreshClone,
} from "../src/git-trust.ts";
import { Journal } from "../src/journal.ts";
import { bootstrapWorktree } from "../src/worker.ts";
import { addTrackedWorktree, createCanonicalRepo, GIT_ENV } from "./support.ts";

/** Node #81: a known-good git state that every run compares against. */

let dir: string;
let canonical: string;
let journal: Journal;
const at = { repo: "acme/widgets", nodeId: "81" };

const config = async (...args: string[]) => {
 const r = await runCmd("git", ["config", "--file", join(canonical, ".git", "config"), ...args], {
  cwd: canonical,
  env: { ...process.env, ...GIT_ENV },
 });
 if (r.code !== 0) throw new Error(`git config ${args.join(" ")}: ${r.stderr}`);
};

beforeEach(async () => {
 dir = mkdtempSync(join(tmpdir(), "ranger-git-trust-"));
 ({ canonical } = await createCanonicalRepo(dir));
 journal = new Journal(":memory:");
});

afterEach(() => {
 journal.close();
 rmSync(dir, { recursive: true, force: true });
});

describe("readGitState: the hash gates, the entries name", () => {
 test("its hash is the tamper snapshot", async () => {
  expect(readGitState(canonical).hash).toBe(gitConfigSnapshot(canonical));
 });

 test("a changed config key, a new key and a new hook are named; no value is kept", async () => {
  const before = readGitState(canonical);
  await config("core.filemode", "false");
  await config("http.sslVerify", "false");
  writeFileSync(join(canonical, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho owned\n");
  const after = readGitState(canonical);
  expect(gitStateChanges(before.entries, after.entries)).toEqual([
   "core.filemode",
   "hooks/post-checkout (new)",
   "http.sslverify (new)",
  ]);
  expect(JSON.stringify(after.entries)).not.toContain("false");
 });

 test("a key that carries a credential is named by digest, never by its text", async () => {
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://github.com/");
  await config("http.https://host/?access_token=QUERYTOKEN.sslVerify", "false");
  const state = readGitState(canonical);
  const names = Object.keys(state.entries);
  expect(JSON.stringify(state)).not.toContain("SECRETTOKEN");
  expect(JSON.stringify(state)).not.toContain("QUERYTOKEN");
  expect(names.filter((n) => /^url\.<[0-9a-f]{12}>\.insteadof$/.test(n))).toHaveLength(1);
  expect(names.filter((n) => /^http\.<[0-9a-f]{12}>\.sslverify$/.test(n))).toHaveLength(1);
  // Ref-name subsections stay readable.
  expect(keyLabel("branch.feature/x.remote")).toBe("branch.feature/x.remote");
  expect(keyLabel("remote.origin.url")).toBe("remote.origin.url");
 });

 test("two credential keys on one host stay two entries, and a change names exactly one", async () => {
  await config("url.https://bot:TOKEN_A@github.com/.insteadOf", "https://github.com/a/");
  await config("url.https://bot:TOKEN_B@github.com/.insteadOf", "https://github.com/b/");
  const before = readGitState(canonical);
  expect(Object.keys(before.entries).filter((n) => n.startsWith("url."))).toHaveLength(2);
  await config("url.https://bot:TOKEN_B@github.com/.insteadOf", "https://evil.example/");
  const changed = gitStateChanges(before.entries, readGitState(canonical).entries);
  expect(changed).toEqual([keyLabel("url.https://bot:TOKEN_B@github.com/.insteadof")]);
  expect(changed.join()).not.toContain("TOKEN");
 });

 test("a removed key is named gone", async () => {
  await config("core.sshCommand", "ssh -i /tmp/k");
  const before = readGitState(canonical);
  await config("--unset", "core.sshCommand");
  expect(gitStateChanges(before.entries, readGitState(canonical).entries)).toEqual(["core.sshcommand (gone)"]);
 });
});

describe("checkKnownGood", () => {
 test("no record: the current state becomes it, and the journal says so", async () => {
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("first");
  expect(JSON.parse(journal.knownGoodGitState(canonical) as string).hash).toBe(
   gitConfigSnapshot(canonical),
  );
  const events = journal.listEvents("acme/widgets");
  expect(events[0].kind).toBe("git-trust");
  expect(events[0].detail).toContain("no known-good git state recorded");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("a credential key present at first sight never reaches the journal", async () => {
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://github.com/");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("first");
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://evil.example/");
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && tamperOutcome(check, canonical, "acme/widgets#1")).toMatch(/url\.<[0-9a-f]{12}>\.insteadof/);
  const { hash } = await trustCurrentGitState(journal, canonical, "acme/widgets");
  await trustCurrentGitState(journal, canonical, "acme/widgets", hash);
  expect(journal.knownGoodGitState(canonical)).not.toContain("SECRETTOKEN");
  for (const event of journal.listEvents("acme/widgets", 500)) expect(JSON.stringify(event)).not.toContain("SECRETTOKEN");
 });

 test("a change since the record is a mismatch naming the key, and is not adopted", async () => {
  await checkKnownGood(journal, canonical, at);
  await config("http.sslVerify", "false");
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toEqual(["http.sslverify (new)"]);
  // Still a mismatch on the next look: the record kept the vetted state.
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("mismatch");
  expect(trustedSnapshot(journal, canonical, at, "acme/widgets#1")).rejects.toThrow(/http\.sslverify/);
 });

 test("another node's worktree between runs matches (node #63's tracking lines stay out)", async () => {
  await checkKnownGood(journal, canonical, at);
  await addTrackedWorktree(canonical, "663", "stations-are-solid");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("a worktree ranger adds under branch.autoSetupRebase=always between runs matches", async () => {
  await config("branch.autoSetupRebase", "always");
  await checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("a worktree on a probe-named branch (not node/<N>-<slug>) between runs matches", async () => {
  await checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "64", "x", "tok", "feature/other", "main");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("records reordered across keys still mismatch, as record order", async () => {
  await config("aaa.one", "1");
  await config("zzz.two", "2");
  await checkKnownGood(journal, canonical, at);
  const file = join(canonical, ".git", "config");
  const text = await Bun.file(file).text();
  const swapped = text.replace("[aaa]\n\tone = 1\n[zzz]\n\ttwo = 2\n", "[zzz]\n\ttwo = 2\n[aaa]\n\tone = 1\n");
  expect(swapped).not.toBe(text);
  writeFileSync(file, swapped);
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["(config record order)"]);
 });

 test("an unreadable record fails closed", async () => {
  journal.setKnownGoodGitState(canonical, "{not json");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("mismatch");
 });

 // A record per base let a map whose base the checkout had not run before
 // take a changed state on first sight, past another map's record.
 test("the record is one per checkout: a change before another map's first run on it is a mismatch", async () => {
  await checkKnownGood(journal, canonical, at); // a map on main
  await config("remote.origin.url", "https://evil.example/acme/widgets.git");
  const check = await checkKnownGood(journal, canonical, { repo: "acme/widgets", nodeId: "90" }); // a map on develop
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toEqual(["remote.origin.url"]);
 });

 test("another map's tracked node branch between runs matches", async () => {
  const git = (args: string[]) => runCmd("git", args, { cwd: canonical, env: { ...process.env, ...GIT_ENV } });
  await git(["push", "origin", "HEAD:refs/heads/develop"]);
  await git(["fetch", "origin"]);
  await checkKnownGood(journal, canonical, at);
  await addTrackedWorktree(canonical, "90", "on-develop", "develop");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });
});

/**
 * Git copies the adding worktree's `config.worktree` into each new worktree
 * when `extensions.worktreeConfig` is on (less `core.worktree` and a true
 * `core.bare`). These run real `git worktree add`, so a git whose copy rule
 * differs fails here.
 */
describe("per-worktree config: git's copy of the main config.worktree", () => {
 const git = async (args: string[], cwd = canonical) => {
  const r = await runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
 };
 const worktreeConfig = async () => {
  await config("extensions.worktreeConfig", "true");
  await git(["config", "--worktree", "core.sparseCheckout", "false"]);
  await git(["config", "--worktree", "core.bare", "false"]);
  await git(["config", "--worktree", "ranger.probe", "kept"]);
 };
 const copy = (name: string) => join(canonical, ".git", "worktrees", name, "config.worktree");

 test("a worktree ranger adds between runs matches", async () => {
  await worktreeConfig();
  await checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(await Bun.file(copy("node-663")).text()).toContain("probe = kept");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("a scratch worktree added from a linked one, then removed, matches throughout", async () => {
  await worktreeConfig();
  const worktree = await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  await checkKnownGood(journal, canonical, at);
  const scratch = join(dir, "scratch");
  await git(["worktree", "add", "--detach", scratch, "HEAD"], worktree);
  expect(await Bun.file(copy("scratch")).exists()).toBe(true);
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
  await git(["worktree", "remove", "--force", scratch], worktree);
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("the copy git makes of a main file with core.bare=true and core.worktree is left out", async () => {
  await config("extensions.worktreeConfig", "true");
  writeFileSync(join(canonical, ".git", "config.worktree"), "[core]\n\tbare = true\n\tworktree = /elsewhere\n\tsparseCheckout = false\n");
  const before = readGitState(canonical);
  mkdirSync(join(canonical, ".git", "worktrees", "w1"), { recursive: true });
  writeFileSync(copy("w1"), "[core]\n\tsparseCheckout = false\n");
  expect(readGitState(canonical).hash).toBe(before.hash);
 });

 test("with a main file that sets nothing, an empty or missing linked file is left out", async () => {
  await config("extensions.worktreeConfig", "true");
  const before = readGitState(canonical);
  mkdirSync(join(canonical, ".git", "worktrees", "w1"), { recursive: true });
  mkdirSync(join(canonical, ".git", "worktrees", "w2"), { recursive: true });
  writeFileSync(copy("w1"), "");
  expect(readGitState(canonical).hash).toBe(before.hash);
 });

 // A main http.sslVerify=true over a shared false: emptying or deleting the
 // copy turns TLS checks off for that worktree's push.
 test("an emptied copy is named", async () => {
  await worktreeConfig();
  await config("http.sslVerify", "false");
  await git(["config", "--worktree", "http.sslVerify", "true"]);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  await checkKnownGood(journal, canonical, at);
  writeFileSync(copy("node-663"), "");
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["worktrees/node-663/config.worktree (new)"]);
 });

 test("a deleted copy is named", async () => {
  await worktreeConfig();
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  await checkKnownGood(journal, canonical, at);
  rmSync(copy("node-663"));
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["worktrees/node-663/config.worktree (new)"]);
 });

 test("a worktree caught midway through git adding it settles to a match", async () => {
  await worktreeConfig();
  await checkKnownGood(journal, canonical, at);
  mkdirSync(join(canonical, ".git", "worktrees", "w1"), { recursive: true });
  writeFileSync(copy("w1"), "");
  // git fills the copy while the check waits: on the check's first wait, not
  // after a wall-clock delay that a loaded host can outlast.
  const wait = spyOn(Bun, "sleep").mockImplementation(async () => {
   copyFileSync(join(canonical, ".git", "config.worktree"), copy("w1"));
  });
  try {
   expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
   expect(wait).toHaveBeenCalledTimes(1);
  } finally {
   wait.mockRestore();
  }
 });

 test("a copy with a key the main file lacks is named", async () => {
  await worktreeConfig();
  await checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  writeFileSync(copy("node-663"), `${await Bun.file(copy("node-663")).text()}[http]\n\tsslVerify = false\n`);
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["worktrees/node-663/config.worktree (new)"]);
 });

 test("a changed main file is named, and its old copies with it", async () => {
  await worktreeConfig();
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  await checkKnownGood(journal, canonical, at);
  await git(["config", "--worktree", "http.sslVerify", "false"]);
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual([
   "config.worktree",
   "worktrees/node-663/config.worktree (new)",
  ]);
 });

 test("two linked files that copy each other but not the main file stay in", async () => {
  await worktreeConfig();
  const before = readGitState(canonical);
  for (const name of ["a", "b"]) {
   mkdirSync(join(canonical, ".git", "worktrees", name), { recursive: true });
   writeFileSync(copy(name), "[http]\n\tsslVerify = false\n");
  }
  expect(gitStateChanges(before.entries, readGitState(canonical).entries)).toEqual([
   "worktrees/a/config.worktree (new)",
   "worktrees/b/config.worktree (new)",
  ]);
 });
});

/**
 * Node #86: with `extensions.worktreeConfig` off git reads no
 * `config.worktree` and copies none into a new worktree, so none is in the
 * state; turning the extension on or off changes what git reads, and is.
 */
describe("per-worktree config with extensions.worktreeConfig off", () => {
 const leftover = () =>
  writeFileSync(join(canonical, ".git", "config.worktree"), "[http]\n\tsslVerify = false\n");
 const linked = (name: string) => join(canonical, ".git", "worktrees", name, "config.worktree");

 for (const [what, off] of [
  ["set false", () => config("extensions.worktreeConfig", "false")],
  ["unset", async () => {}],
 ] as const) {
  test(`a worktree ranger adds over a populated leftover main file matches (${what})`, async () => {
   await off();
   leftover();
   await checkKnownGood(journal, canonical, at);
   await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
   expect(await Bun.file(linked("node-663")).exists()).toBe(false);
   expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
  });
 }

 test("a leftover main file, its change and an include in it are not in the state", async () => {
  await config("extensions.worktreeConfig", "false");
  const before = readGitState(canonical);
  leftover();
  appendFileSync(join(canonical, ".git", "config.worktree"), "[include]\n\tpath = /tmp/x.conf\n");
  const after = readGitState(canonical);
  expect(after.hash).toBe(before.hash);
  expect(after.includes).toEqual([]);
  expect(Object.keys(after.entries).filter((n) => n.includes("config.worktree"))).toEqual([]);
 });

 test("turning the extension on between runs is a mismatch naming it", async () => {
  await config("extensions.worktreeConfig", "false");
  leftover();
  await checkKnownGood(journal, canonical, at);
  await config("extensions.worktreeConfig", "true");
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["config.worktree (new)", "extensions.worktreeconfig"]);
 });

 test("turning the extension off between runs is a mismatch naming it", async () => {
  await config("extensions.worktreeConfig", "true");
  leftover();
  await checkKnownGood(journal, canonical, at);
  await config("extensions.worktreeConfig", "false");
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["config.worktree (gone)", "extensions.worktreeconfig"]);
 });

 test("a value git cannot read as a bool keeps every config.worktree in the state", async () => {
  await config("extensions.worktreeConfig", "maybe");
  const before = readGitState(canonical);
  leftover();
  expect(gitStateChanges(before.entries, readGitState(canonical).entries)).toEqual(["config.worktree (new)"]);
 });
});

/**
 * Includes fail closed (node #81, decided 2026-10-05): any include key in the
 * shared config or a `config.worktree` refuses the state, named, and no code
 * follows the path it holds.
 */
describe("include keys are refused", () => {
 const gitDir = () => join(canonical, ".git");
 const git = async (args: string[], cwd = canonical) => {
  const r = await runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
 };
 const includesOf = async () => {
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("includes");
  return check.state.includes;
 };

 test("an include.path in the shared config refuses the state on first sight, and nothing is recorded", async () => {
  await config("include.path", "extra.conf");
  expect(await includesOf()).toEqual(["include.path in config"]);
  expect(journal.knownGoodGitState(canonical)).toBeNull();
  expect(journal.listEvents("acme/widgets")).toEqual([]);
 });

 test("an include beside a value past spawnSync's 1 MiB output cap is still found (sage round 1, node #86)", async () => {
  // Appended, not `git config`: a 1.1 MB argument would pass ARG_MAX.
  appendFileSync(join(canonical, ".git", "config"), `[big]\n\tvalue = ${"x".repeat(1_100_000)}\n[include]\n\tpath = extra.conf\n`);
  expect(readGitState(canonical).includes).toEqual(["include.path in config"]);
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("includes");
  expect(journal.knownGoodGitState(canonical)).toBeNull();
 });

 test("an include added after the record refuses the state, naming the key", async () => {
  await checkKnownGood(journal, canonical, at);
  await config("includeIf.onbranch:main.path", "extra.conf");
  expect(await includesOf()).toEqual([`${keyLabel("includeif.onbranch:main.path")} in config`]);
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "includes" && tamperOutcome(check, canonical, "acme/widgets#1")).toMatch(
   /^git config include refused: includeif\.<[0-9a-f]{12}>\.path in config/,
  );
  await expect(trustedSnapshot(journal, canonical, at, "acme/widgets#1")).rejects.toThrow(/include refused/);
 });

 test("an include key of any variable counts, and no included file is ever read", async () => {
  // A FIFO target: reading it would block the check forever.
  const fifo = join(dir, "never-read.conf");
  const made = Bun.spawnSync(["mkfifo", fifo]);
  expect(made.exitCode).toBe(0);
  appendFileSync(join(gitDir(), "config"), `[include]\n\tpath = ${fifo}\n\tother = x\n`);
  expect(await includesOf()).toEqual(["include.other in config", "include.path in config"]);
 });

 test("an include in the main config.worktree, and in every worktree's copy, is named", async () => {
  await config("extensions.worktreeConfig", "true");
  await git(["config", "--worktree", "include.path", "wt.conf"]);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(await includesOf()).toEqual([
   "include.path in config.worktree",
   "include.path in worktrees/node-663/config.worktree",
  ]);
 });

 test("an include planted in a linked config.worktree alone is named", async () => {
  await config("extensions.worktreeConfig", "true");
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  await checkKnownGood(journal, canonical, at);
  writeFileSync(join(gitDir(), "worktrees", "node-663", "config.worktree"), "[includeIf \"gitdir:/x/\"]\n\tpath = /tmp/x.conf\n");
  expect(await includesOf()).toEqual([`${keyLabel("includeif.gitdir:/x/.path")} in worktrees/node-663/config.worktree`]);
 });

 test("trust-git refuses while an include is present, and so does a fresh clone's record", async () => {
  await checkKnownGood(journal, canonical, at);
  const record = journal.knownGoodGitState(canonical);
  await config("include.path", "extra.conf");
  await expect(trustCurrentGitState(journal, canonical, "acme/widgets")).rejects.toThrow(/include refused/);
  expect(trustFreshClone(journal, canonical).kind).toBe("includes");
  expect(journal.knownGoodGitState(canonical)).toBe(record);
 });
});

describe("a path that is not a regular file is never read", () => {
 test("a FIFO in place of the shared config is hashed as not a file, and the check returns", async () => {
  await checkKnownGood(journal, canonical, at);
  const config = join(canonical, ".git", "config");
  rmSync(config);
  expect(Bun.spawnSync(["mkfifo", config]).exitCode).toBe(0);
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toContain("config (not a file) (new)");
 });

 test("a FIFO or a directory among the hooks is named, not read", async () => {
  const hooks = join(canonical, ".git", "hooks");
  await checkKnownGood(journal, canonical, at);
  expect(Bun.spawnSync(["mkfifo", join(hooks, "pre-push")]).exitCode).toBe(0);
  mkdirSync(join(hooks, "post-checkout"));
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["hooks/post-checkout (new)", "hooks/pre-push (new)"]);
  expect(readGitState(canonical).entries["hooks/pre-push"]).toBe("(not a file)");
 });
});

describe("recording the known-good state", () => {
 test("recordIfUnchanged never adopts a state that moved after it was verified", async () => {
  const verified = readGitState(canonical);
  recordKnownGood(journal, canonical, verified, "test");
  await config("http.sslVerify", "false");
  recordIfUnchanged(journal, canonical, verified, "worktree created");
  expect(JSON.parse(journal.knownGoodGitState(canonical) as string).hash).toBe(verified.hash);
 });

 test("trust-git lists every change and the hash, and records nothing", async () => {
  await checkKnownGood(journal, canonical, at);
  const record = journal.knownGoodGitState(canonical);
  await config("http.sslVerify", "false");
  const preview = await trustCurrentGitState(journal, canonical, "acme/widgets");
  expect(preview).toMatchObject({ recorded: false, hash: readGitState(canonical).hash, changed: ["http.sslverify (new)"] });
  expect(journal.knownGoodGitState(canonical)).toBe(record);
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("mismatch");
 });

 test("trust-git --hash adopts exactly the previewed state and journals what changed", async () => {
  await checkKnownGood(journal, canonical, at);
  await config("http.sslVerify", "false");
  const { hash } = await trustCurrentGitState(journal, canonical, "acme/widgets");
  const result = await trustCurrentGitState(journal, canonical, "acme/widgets", hash);
  expect(result).toMatchObject({ recorded: true, hash, changed: ["http.sslverify (new)"] });
  expect(journal.listEvents("acme/widgets")[0].detail).toContain("http.sslverify (new)");
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
 });

 test("trust-git --hash refuses a state that changed after the preview", async () => {
  await checkKnownGood(journal, canonical, at);
  const record = journal.knownGoodGitState(canonical);
  await config("http.sslVerify", "false");
  const { hash } = await trustCurrentGitState(journal, canonical, "acme/widgets");
  await config("core.sshCommand", "ssh -o ProxyCommand=evil");
  await expect(trustCurrentGitState(journal, canonical, "acme/widgets", hash)).rejects.toThrow(/no longer hashes to/);
  expect(journal.knownGoodGitState(canonical)).toBe(record);
 });
});

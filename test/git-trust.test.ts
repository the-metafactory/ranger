import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { gitConfigSnapshot, gitStateChanges, keyLabel, readGitState } from "../src/git-ops.ts";
import {
 checkKnownGood,
 knownGoodKey,
 recordIfUnchanged,
 recordKnownGood,
 tamperOutcome,
 trustCurrentGitState,
 trustedSnapshot,
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
 test("its hash is the tamper snapshot", () => {
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
 test("no record: the current state becomes it, and the journal says so", () => {
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("first");
  expect(JSON.parse(journal.getHealth(knownGoodKey(canonical)) as string).hash).toBe(
   gitConfigSnapshot(canonical),
  );
  const events = journal.listEvents("acme/widgets");
  expect(events[0].kind).toBe("git-trust");
  expect(events[0].detail).toContain("no known-good git state recorded");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
 });

 test("a credential key present at first sight never reaches the journal", async () => {
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://github.com/");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("first");
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://evil.example/");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && tamperOutcome(check, canonical, "acme/widgets#1")).toMatch(/url\.<[0-9a-f]{12}>\.insteadof/);
  trustCurrentGitState(journal, canonical, "acme/widgets");
  expect(journal.getHealth(knownGoodKey(canonical))).not.toContain("SECRETTOKEN");
  for (const event of journal.listEvents("acme/widgets", 500)) expect(JSON.stringify(event)).not.toContain("SECRETTOKEN");
 });

 test("a change since the record is a mismatch naming the key, and is not adopted", async () => {
  checkKnownGood(journal, canonical, at);
  await config("http.sslVerify", "false");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toEqual(["http.sslverify (new)"]);
  // Still a mismatch on the next look: the record kept the vetted state.
  expect(checkKnownGood(journal, canonical, at).kind).toBe("mismatch");
  expect(() => trustedSnapshot(journal, canonical, at, "acme/widgets#1")).toThrow(/http\.sslverify/);
 });

 test("another node's worktree between runs matches (node #63's tracking lines stay out)", async () => {
  checkKnownGood(journal, canonical, at);
  await addTrackedWorktree(canonical, "663", "stations-are-solid");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
 });

 test("a worktree ranger adds under branch.autoSetupRebase=always between runs matches", async () => {
  await config("branch.autoSetupRebase", "always");
  checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
 });

 test("a worktree on a probe-named branch (not node/<N>-<slug>) between runs matches", async () => {
  checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "64", "x", "tok", "feature/other", "main");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
 });

 test("records reordered across keys still mismatch, as record order", async () => {
  await config("aaa.one", "1");
  await config("zzz.two", "2");
  checkKnownGood(journal, canonical, at);
  const file = join(canonical, ".git", "config");
  const text = await Bun.file(file).text();
  const swapped = text.replace("[aaa]\n\tone = 1\n[zzz]\n\ttwo = 2\n", "[zzz]\n\ttwo = 2\n[aaa]\n\tone = 1\n");
  expect(swapped).not.toBe(text);
  writeFileSync(file, swapped);
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["(config record order)"]);
 });

 test("an unreadable record fails closed", () => {
  journal.setHealth(knownGoodKey(canonical), "{not json");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("mismatch");
 });

 // A record per base let a map whose base the checkout had not run before
 // take a changed state on first sight, past another map's record.
 test("the record is one per checkout: a change before another map's first run on it is a mismatch", async () => {
  checkKnownGood(journal, canonical, at); // a map on main
  await config("remote.origin.url", "https://evil.example/acme/widgets.git");
  const check = checkKnownGood(journal, canonical, { repo: "acme/widgets", nodeId: "90" }); // a map on develop
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toEqual(["remote.origin.url"]);
  expect(knownGoodKey(canonical)).toBe(`git.known-good.${canonical}`);
 });

 test("another map's tracked node branch between runs matches", async () => {
  const git = (args: string[]) => runCmd("git", args, { cwd: canonical, env: { ...process.env, ...GIT_ENV } });
  await git(["push", "origin", "HEAD:refs/heads/develop"]);
  await git(["fetch", "origin"]);
  checkKnownGood(journal, canonical, at);
  await addTrackedWorktree(canonical, "90", "on-develop", "develop");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
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
  checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(await Bun.file(copy("node-663")).text()).toContain("probe = kept");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
 });

 test("a scratch worktree added from a linked one, then removed, matches throughout", async () => {
  await worktreeConfig();
  const worktree = await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  checkKnownGood(journal, canonical, at);
  const scratch = join(dir, "scratch");
  await git(["worktree", "add", "--detach", scratch, "HEAD"], worktree);
  expect(await Bun.file(copy("scratch")).exists()).toBe(true);
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
  await git(["worktree", "remove", "--force", scratch], worktree);
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
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
  checkKnownGood(journal, canonical, at);
  writeFileSync(copy("node-663"), "");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["worktrees/node-663/config.worktree (new)"]);
 });

 test("a deleted copy is named", async () => {
  await worktreeConfig();
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  checkKnownGood(journal, canonical, at);
  rmSync(copy("node-663"));
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["worktrees/node-663/config.worktree (new)"]);
 });

 test("a worktree caught midway through git adding it settles to a match", async () => {
  await worktreeConfig();
  checkKnownGood(journal, canonical, at);
  mkdirSync(join(canonical, ".git", "worktrees", "w1"), { recursive: true });
  writeFileSync(copy("w1"), "");
  // Another process fills the copy while the check reads; the check blocks.
  const writer = Bun.spawn(["sh", "-c", `sleep 0.1 && cp "$0" "$1"`, join(canonical, ".git", "config.worktree"), copy("w1")]);
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
  expect(await writer.exited).toBe(0);
 });

 test("a copy with a key the main file lacks is named", async () => {
  await worktreeConfig();
  checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  writeFileSync(copy("node-663"), `${await Bun.file(copy("node-663")).text()}[http]\n\tsslVerify = false\n`);
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["worktrees/node-663/config.worktree (new)"]);
 });

 test("a changed main file is named, and its old copies with it", async () => {
  await worktreeConfig();
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  checkKnownGood(journal, canonical, at);
  await git(["config", "--worktree", "http.sslVerify", "false"]);
  const check = checkKnownGood(journal, canonical, at);
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
 * Git reads the files a config includes as if their lines stood in it, so
 * an included file is part of the state (a worker editing one could set
 * http.sslVerify=false past an unchanged include line).
 */
describe("included config files", () => {
 const gitDir = () => join(canonical, ".git");
 const includeName = /^include <[0-9a-f]{12}>$/;

 test("an edited include target is named", async () => {
  writeFileSync(join(gitDir(), "extra.conf"), "[core]\n\tfilemode = false\n");
  await config("include.path", "extra.conf");
  checkKnownGood(journal, canonical, at);
  writeFileSync(join(gitDir(), "extra.conf"), "[http]\n\tsslVerify = false\n");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toHaveLength(1);
  expect(check.kind === "mismatch" && check.changed[0]).toMatch(includeName);
 });

 test("a missing target that appears is new", async () => {
  await config("include.path", "missing.conf");
  checkKnownGood(journal, canonical, at);
  writeFileSync(join(gitDir(), "missing.conf"), "[http]\n\tsslVerify = false\n");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed[0]).toMatch(/^include <[0-9a-f]{12}> \(new\)$/);
 });

 test("an includeIf target is hashed whatever its condition, and so is a file it includes", async () => {
  const outer = join(dir, "outer.conf");
  const inner = join(dir, "inner.conf");
  writeFileSync(outer, "[include]\n\tpath = inner.conf\n");
  writeFileSync(inner, "[core]\n\tfilemode = false\n");
  await config("includeIf.gitdir:/nowhere/.path", outer);
  checkKnownGood(journal, canonical, at);
  writeFileSync(inner, "[core]\n\tsshCommand = ssh -o ProxyCommand=evil\n");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toHaveLength(1);
 });

 test("a ~/ include resolves against HOME", async () => {
  const home = process.env.HOME;
  process.env.HOME = dir;
  try {
   writeFileSync(join(dir, "home.conf"), "[core]\n\tfilemode = false\n");
   await config("include.path", "~/home.conf");
   checkKnownGood(journal, canonical, at);
   writeFileSync(join(dir, "home.conf"), "[http]\n\tsslVerify = false\n");
   expect(checkKnownGood(journal, canonical, at).kind).toBe("mismatch");
  } finally {
   process.env.HOME = home;
  }
 });

 test("a UTF-8 include path names the file git reads, and an edit to it is named", async () => {
  writeFileSync(join(gitDir(), "vérifié.conf"), "[core]\n\tfilemode = false\n");
  await config("include.path", "vérifié.conf");
  checkKnownGood(journal, canonical, at);
  writeFileSync(join(gitDir(), "vérifié.conf"), "[http]\n\tsslVerify = false\n");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toHaveLength(1);
  expect(check.kind === "mismatch" && check.changed[0]).toMatch(includeName);
 });

 test("a ~user/ include is resolved as git resolves it; one git cannot expand adds no target", () => {
  const includes = () => Object.keys(readGitState(canonical).entries).filter((n) => includeName.test(n));
  // Appended raw: git refuses to write a config holding either line.
  const add = (line: string) => appendFileSync(join(gitDir(), "config"), `[include]\n\tpath = ${line}\n`);
  expect(includes()).toEqual([]);
  // The user's home directory: it exists, so it is a target (not a file, so hashed absent).
  add(`~${userInfo().username}/`);
  expect(includes()).toHaveLength(1);
  const before = readGitState(canonical);
  add("~no-such-ranger-user/x.conf");
  const after = readGitState(canonical);
  expect(Object.keys(after.entries).filter((n) => includeName.test(n))).toHaveLength(1);
  expect(after.hash).not.toBe(before.hash);
 });

 test("a relative include in the main config.worktree:a worktree ranger adds matches, a target planted beside its copy does not", async () => {
  await config("extensions.worktreeConfig", "true");
  const r = await runCmd("git", ["config", "--worktree", "include.path", "wt.conf"], {
   cwd: canonical,
   env: { ...process.env, ...GIT_ENV },
  });
  expect(r.code).toBe(0);
  writeFileSync(join(gitDir(), "wt.conf"), "[core]\n\tfilemode = false\n");
  checkKnownGood(journal, canonical, at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
  writeFileSync(join(gitDir(), "worktrees", "node-663", "wt.conf"), "[http]\n\tsslVerify = false\n");
  const check = checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed[0]).toMatch(/^include <[0-9a-f]{12}> \(new\)$/);
 });
});

describe("recording the known-good state", () => {
 test("recordIfUnchanged never adopts a state that moved after it was verified", async () => {
  const verified = readGitState(canonical);
  recordKnownGood(journal, canonical, verified, "test");
  await config("http.sslVerify", "false");
  recordIfUnchanged(journal, canonical, verified, "worktree created");
  expect(JSON.parse(journal.getHealth(knownGoodKey(canonical)) as string).hash).toBe(verified.hash);
 });

 test("trust-git adopts the current state and journals what changed", async () => {
  checkKnownGood(journal, canonical, at);
  await config("http.sslVerify", "false");
  const result = trustCurrentGitState(journal, canonical, "acme/widgets");
  expect(result.changed).toEqual(["http.sslverify (new)"]);
  expect(journal.listEvents("acme/widgets")[0].detail).toContain("http.sslverify (new)");
  expect(checkKnownGood(journal, canonical, at).kind).toBe("match");
 });
});

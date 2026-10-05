import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const check = checkKnownGood(journal, canonical, "main", at);
  expect(check.kind).toBe("first");
  expect(JSON.parse(journal.getHealth(knownGoodKey(canonical, "main")) as string).hash).toBe(
   gitConfigSnapshot(canonical),
  );
  const events = journal.listEvents("acme/widgets");
  expect(events[0].kind).toBe("git-trust");
  expect(events[0].detail).toContain("no known-good git state recorded");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("match");
 });

 test("a credential key present at first sight never reaches the journal", async () => {
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://github.com/");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("first");
  await config("url.https://bot:SECRETTOKEN@github.com/.insteadOf", "https://evil.example/");
  const check = checkKnownGood(journal, canonical, "main", at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && tamperOutcome(check, canonical, "acme/widgets#1")).toMatch(/url\.<[0-9a-f]{12}>\.insteadof/);
  trustCurrentGitState(journal, canonical, "main", "acme/widgets");
  expect(journal.getHealth(knownGoodKey(canonical, "main"))).not.toContain("SECRETTOKEN");
  for (const event of journal.listEvents("acme/widgets", 500)) expect(JSON.stringify(event)).not.toContain("SECRETTOKEN");
 });

 test("a change since the record is a mismatch naming the key, and is not adopted", async () => {
  checkKnownGood(journal, canonical, "main", at);
  await config("http.sslVerify", "false");
  const check = checkKnownGood(journal, canonical, "main", at);
  expect(check.kind).toBe("mismatch");
  expect(check.kind === "mismatch" && check.changed).toEqual(["http.sslverify (new)"]);
  // Still a mismatch on the next look: the record kept the vetted state.
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("mismatch");
  expect(() => trustedSnapshot(journal, canonical, "main", at, "acme/widgets#1")).toThrow(/http\.sslverify/);
 });

 test("another node's worktree between runs matches (node #63's tracking lines stay out)", async () => {
  checkKnownGood(journal, canonical, "main", at);
  await addTrackedWorktree(canonical, "663", "stations-are-solid");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("match");
 });

 test("a worktree ranger adds under branch.autoSetupRebase=always between runs matches", async () => {
  await config("branch.autoSetupRebase", "always");
  checkKnownGood(journal, canonical, "main", at);
  await bootstrapWorktree(canonical, "663", "stations-are-solid", "tok");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("match");
 });

 test("a worktree on a probe-named branch (not node/<N>-<slug>) between runs matches", async () => {
  checkKnownGood(journal, canonical, "main", at);
  await bootstrapWorktree(canonical, "64", "x", "tok", "feature/other", "main");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("match");
 });

 test("records reordered across keys still mismatch, as record order", async () => {
  await config("aaa.one", "1");
  await config("zzz.two", "2");
  checkKnownGood(journal, canonical, "main", at);
  const file = join(canonical, ".git", "config");
  const text = await Bun.file(file).text();
  const swapped = text.replace("[aaa]\n\tone = 1\n[zzz]\n\ttwo = 2\n", "[zzz]\n\ttwo = 2\n[aaa]\n\tone = 1\n");
  expect(swapped).not.toBe(text);
  writeFileSync(file, swapped);
  const check = checkKnownGood(journal, canonical, "main", at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["(config record order)"]);
 });

 test("an unreadable record fails closed", () => {
  journal.setHealth(knownGoodKey(canonical, "main"), "{not json");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("mismatch");
 });

 test("the record is per base: the node-branch filter depends on it", () => {
  checkKnownGood(journal, canonical, "main", at);
  expect(journal.getHealth(knownGoodKey(canonical, "develop"))).toBeNull();
 });
});

describe("recording the known-good state", () => {
 test("recordIfUnchanged never adopts a state that moved after it was verified", async () => {
  const verified = readGitState(canonical);
  recordKnownGood(journal, canonical, "main", verified, "test");
  await config("http.sslVerify", "false");
  recordIfUnchanged(journal, canonical, "main", verified, "worktree created");
  expect(JSON.parse(journal.getHealth(knownGoodKey(canonical, "main")) as string).hash).toBe(verified.hash);
 });

 test("trust-git adopts the current state and journals what changed", async () => {
  checkKnownGood(journal, canonical, "main", at);
  await config("http.sslVerify", "false");
  const result = trustCurrentGitState(journal, canonical, "main", "acme/widgets");
  expect(result.changed).toEqual(["http.sslverify (new)"]);
  expect(journal.listEvents("acme/widgets")[0].detail).toContain("http.sslverify (new)");
  expect(checkKnownGood(journal, canonical, "main", at).kind).toBe("match");
 });
});

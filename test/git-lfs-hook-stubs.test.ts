import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { assertGitUntouched, gitConfigSnapshot, readGitState } from "../src/git-ops.ts";
import { checkKnownGood, recordKnownGood } from "../src/git-trust.ts";
import { Journal } from "../src/journal.ts";
import { createCanonicalRepo, GIT_ENV } from "./support.ts";

const STUBBED = ["pre-push", "post-checkout", "post-commit", "post-merge"];

const gitLfs381Stub = (hook: string): string =>
 `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '${hook}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks')."; exit 2; }\ngit lfs ${hook} "$@"\n`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

let dir: string;
let canonical: string;
let hooks: string;
let journal: Journal;
const at = { repo: "acme/widgets", nodeId: "484" };

const install = (name: string, body: string) => writeFileSync(join(hooks, name), body, { mode: 0o755 });

beforeEach(async () => {
 dir = mkdtempSync(join(tmpdir(), "ranger-lfs-stubs-"));
 ({ canonical } = await createCanonicalRepo(dir));
 hooks = join(canonical, ".git", "hooks");
 journal = new Journal(":memory:");
});

afterEach(() => {
 journal.close();
 rmSync(dir, { recursive: true, force: true });
});

describe("the stubs git-lfs writes", () => {
 test("leave the hash unchanged and pass both the known-good check and the post-worker check", async () => {
  await checkKnownGood(journal, canonical, at);
  const snapshot = gitConfigSnapshot(canonical);
  for (const hook of STUBBED) install(hook, gitLfs381Stub(hook));
  expect(gitConfigSnapshot(canonical)).toBe(snapshot);
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
  await assertGitUntouched(canonical, snapshot);
 });

 test.skipIf(Bun.which("git-lfs") === null)("a real filter-process run installs hooks the check does not count", async () => {
  await checkKnownGood(journal, canonical, at);
  const snapshot = gitConfigSnapshot(canonical);
  writeFileSync(join(canonical, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(canonical, "model.bin"), "a study binary\n");
  const added = await runCmd(
   "git",
   ["-c", "filter.lfs.process=git-lfs filter-process", "-c", "filter.lfs.required=true", "add", "model.bin"],
   { cwd: canonical, env: { ...process.env, ...GIT_ENV, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  expect(added.code).toBe(0);
  for (const hook of STUBBED) expect(existsSync(join(hooks, hook))).toBe(true);
  expect(gitConfigSnapshot(canonical)).toBe(snapshot);
 });
});

describe("anything else in a stub's place still parks", () => {
 const cases: [string, string, () => void][] = [
  ["a stub with a byte added", "pre-push", () => install("pre-push", `${gitLfs381Stub("pre-push")}\n`)],
  ["a stub that also runs something", "pre-push", () => install("pre-push", gitLfs381Stub("pre-push").replace('"$@"', '"$@"; /tmp/evil'))],
  ["a stub without its final newline", "post-merge", () => install("post-merge", gitLfs381Stub("post-merge").slice(0, -1))],
  ["another hook's stub", "pre-push", () => install("pre-push", gitLfs381Stub("post-merge"))],
  ["a stub at a name git-lfs does not write", "pre-commit", () => install("pre-commit", gitLfs381Stub("pre-commit"))],
  ["a NUL byte at a name git-lfs does not write", "evil", () => install("evil", "\0")],
  ["a directory", "pre-push", () => mkdirSync(join(hooks, "pre-push"))],
  ["a FIFO", "post-commit", () => expect(Bun.spawnSync(["mkfifo", join(hooks, "post-commit")]).exitCode).toBe(0)],
 ];
 for (const [label, hook, plant] of cases) {
  test(`${label} is named`, async () => {
   await checkKnownGood(journal, canonical, at);
   plant();
   const check = await checkKnownGood(journal, canonical, at);
   expect(check.kind).toBe("mismatch");
   expect(check.kind === "mismatch" && check.changed).toEqual([`hooks/${hook} (new)`]);
  });
 }
});

describe("a known-good record from before this exemption", () => {
 const recordNaming = (extra: Record<string, string>) => {
  const state = readGitState(canonical);
  recordKnownGood(journal, canonical, { ...state, hash: "0".repeat(64), entries: { ...state.entries, ...extra } }, "trusted by the operator");
 };

 test("naming the stubs is re-recorded without parking, and the journal says so", async () => {
  for (const hook of STUBBED) install(hook, gitLfs381Stub(hook));
  recordNaming(Object.fromEntries(STUBBED.map((hook) => [`hooks/${hook}`, sha256(gitLfs381Stub(hook))])));
  expect((await checkKnownGood(journal, canonical, at)).kind).toBe("match");
  expect(JSON.parse(journal.knownGoodGitState(canonical)!).hash).toBe(gitConfigSnapshot(canonical));
  expect(journal.listEvents("acme/widgets")[0].detail).toContain("no longer hashed");
 });

 test("naming another hook at a stub's name parks when that hook is removed", async () => {
  install("pre-push", "#!/bin/sh\nexit 0\n");
  await checkKnownGood(journal, canonical, at);
  rmSync(join(hooks, "pre-push"));
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["hooks/pre-push (gone)"]);
 });

 test("naming another hook at a stub's name parks when a stub replaces it", async () => {
  install("pre-push", "#!/bin/sh\nexit 0\n");
  await checkKnownGood(journal, canonical, at);
  install("pre-push", gitLfs381Stub("pre-push"));
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toEqual(["hooks/pre-push (gone)"]);
 });

 test("stubs gone plus any other change still parks", async () => {
  recordNaming({ "hooks/pre-push": sha256(gitLfs381Stub("pre-push")) });
  install("post-commit", "#!/bin/sh\necho owned\n");
  const check = await checkKnownGood(journal, canonical, at);
  expect(check.kind === "mismatch" && check.changed).toContain("hooks/post-commit (new)");
 });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalCheckout, findCanonicalWrite, guardedRoots } from "../src/canonical-guard.ts";
import { loadConfig } from "../src/config.ts";

const ROOT = resolve(homedir(), "work/ranger-repos");
const SEELITE = join(ROOT, "jcfischer/seelite");
const OWN_CLONE = resolve(homedir(), "work/cyphr/spark/seelite");
const PINNED = "/srv/clones/threva";
const ROOTS = [ROOT, PINNED];

const writes = (command: string, cwd = OWN_CLONE) => findCanonicalWrite(command, cwd, ROOTS, ROOT);

describe("a git write to a canonical checkout is found", () => {
 test.each([
  ["the 2026-11-18 worktree add", "cd ~/work/ranger-repos/jcfischer/seelite && git fetch -q origin && git worktree add -q ~/work/cyphr/spark/seelite-probe-conc -b chore/local-probe-concurrency-2 origin/main"],
  ["the 2026-11-18 cleanup", "cd ~/work/ranger-repos/jcfischer/seelite && git worktree remove ~/work/cyphr/spark/seelite-probe-conc && git branch -D chore/local-probe-concurrency-2"],
  ["git -C into the checkout", `git -C ${SEELITE} checkout -b side`],
  ["a subshell cd", `(cd ${SEELITE}; git commit -qam wip)`],
  ["a config write", `git -C ${SEELITE} config branch.x.remote origin`],
  ["a tag", `git -C ${SEELITE} tag v1`],
  ["a branch rename", `git -C ${SEELITE} branch -m old new`],
  ["a stash", `git -C ${SEELITE} stash push -m tmp`],
  ["a pinned canonical outside the root", `cd ${PINNED} && git pull`],
  ["a relative cd from the root", "cd jcfischer/seelite && git reset --hard origin/main"],
 ])("%s", (_name, command) => {
  expect(writes(command, ROOT)?.checkout).toBe(command.includes(PINNED) ? PINNED : SEELITE);
 });
});

describe("read-only git and other places pass", () => {
 test.each([
  ["status, log and fetch", `cd ${SEELITE} && git status --short && git log --oneline -3 && git fetch -q origin`, OWN_CLONE],
  ["listing branches and worktrees", `git -C ${SEELITE} branch -a && git -C ${SEELITE} worktree list`, OWN_CLONE],
  ["branches containing a commit", `git -C ${SEELITE} branch -r --contains 34240413`, OWN_CLONE],
  ["reading config", `cd ${SEELITE}; git config --get-regexp '^branch\\.'; git config user.name`, OWN_CLONE],
  ["listing tags", `git -C ${SEELITE} tag -l 'v*'`, OWN_CLONE],
  ["the principal's own clone", "git worktree add ../seelite-1198 -b feat/x origin/main && git branch -D old", OWN_CLONE],
  ["a ranger worker in its worktree", "git commit -qam fix && git push -u origin node/1049-x", join(SEELITE, ".worktrees/node-1049")],
  ["the root's owner directory", "git init", join(ROOT, "jcfischer")],
 ])("%s", (_name, command, cwd) => {
  expect(writes(command, cwd)).toBeUndefined();
 });
});

test("a checkout is the owner/name directory below the canonical root, or a pinned canonical itself", () => {
 expect(canonicalCheckout(join(SEELITE, "src/game"), ROOTS, ROOT)).toBe(SEELITE);
 expect(canonicalCheckout(join(PINNED, "src"), ROOTS, ROOT)).toBe(PINNED);
 expect(canonicalCheckout(join(PINNED, ".worktrees/node-3"), ROOTS, ROOT)).toBeUndefined();
});

test("the guarded roots are the canonical root and each map's pinned canonical", () => {
 const dir = mkdtempSync(join(tmpdir(), "canonical-guard-"));
 try {
  const path = join(dir, "ranger.yaml");
  writeFileSync(path, `state:\n  canonicalRoot: ~/work/ranger-repos\nmaps:\n  - repo: jcfischer/threva-app\n    root: 1\n    canonical: ${PINNED}\n  - repo: jcfischer/seelite\n    root: 1\n`);
  expect(guardedRoots(loadConfig(path, {}, () => undefined).config).sort()).toEqual([PINNED, ROOT].sort());
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("the hook denies a canonical write with Claude Code's PreToolUse decision and passes anything else", async () => {
 const dir = mkdtempSync(join(tmpdir(), "canonical-guard-"));
 try {
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, `state:\n  canonicalRoot: ${join(dir, "repos")}\nmaps:\n  - repo: acme/widgets\n    root: 1\n`);
  const run = async (command: string) => {
   const proc = Bun.spawn(["bun", resolve(import.meta.dir, "../src/hooks/canonical-guard.hook.ts")], {
    stdin: new Blob([JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir })]),
    stdout: "pipe",
    env: { ...process.env, RANGER_CONFIG: configPath },
   });
   const out = await new Response(proc.stdout).text();
   expect(await proc.exited).toBe(0);
   return out;
  };
  const denied = JSON.parse(await run("cd repos/acme/widgets && git checkout -b side"));
  expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(denied.hookSpecificOutput.permissionDecisionReason).toContain(join(dir, "repos/acme/widgets"));
  expect(await run("cd repos/acme/widgets && git status")).toBe("");
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { runNode } from "../src/worker.ts";
import { restoreEnv, rig, type Rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const BRANCH = "node/20-add-the-feature-module";

function reclaim(r: Rig): void {
 r.journal.updateWorker("20", REPO, { status: "claimed", startedAt: null, pid: null });
}

async function dropWorktree(r: Rig): Promise<void> {
 const removed = await runCmd("git", ["worktree", "remove", "--force", join(r.canonical, ".worktrees", "node-20")], { cwd: r.canonical });
 expect(removed.code).toBe(0);
}

describe("a resumed worktree installs its dependencies before its tests", () => {
 const cleanup: string[] = [];
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  restoreEnv();
 });

 test("a review-phase resume on a re-created worktree runs the install before the checkpoint's tests", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
  const pushed = await r.github.sha(BRANCH);
  await dropWorktree(r);
  const installs = join(r.dir, "installs");
  writeFileSync(installs, "");
  r.ctx.map.commands.install = `echo "$PWD" >> ${installs}`;
  r.ctx.map.commands.test = `grep -qxF "$PWD" ${installs}`;
  r.ctx.worker = async () => { throw new Error("no worker session on this resume"); };
  reclaim(r);
  expect(await runNode("20", r.ctx)).toMatchObject({ status: "awaiting-merge" });
  expect(await r.github.sha(BRANCH)).toBe(pushed);
  expect(readFileSync(installs, "utf8").trim().split("\n")).toHaveLength(1);
 }, 60_000);
});

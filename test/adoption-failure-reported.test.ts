import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runCmd, type RunResult } from "../src/exec.ts";
import { runNode } from "../src/worker.ts";
import { implementWorker, loadSequence, restoreEnv, rig, type Rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const BRANCH = "node/20-add-the-feature-module";
const FAILED: RunResult = { code: 1, stdout: "(fail) widgets > renders the feature [1.00ms]\n 1 fail\n", stderr: "" };
const TIMED_OUT: RunResult = { code: -1, stdout: "(pass) widgets > renders the feature [1.00ms]\n", stderr: "", timedOut: true };
const PASSED: RunResult = { code: 0, stdout: "", stderr: "" };

function scriptedTests(r: Rig, runs: RunResult[]): { calls: number } {
 const seen = { calls: 0 };
 r.ctx.shellRun = async (command, opts) => {
  if (command !== r.ctx.map.commands.test) return runCmd("/bin/sh", ["-c", command], opts);
  seen.calls += 1;
  return runs[Math.min(seen.calls, runs.length) - 1];
 };
 return seen;
}

function quietHost(r: Rig): void {
 r.ctx.hostLoad = loadSequence(Array(20).fill(0), 1);
 r.ctx.quietHost = { pollMs: 1, maxMs: 1 };
}

function reclaim(r: Rig): void {
 r.journal.updateWorker("20", REPO, { status: "claimed", startedAt: null, pid: null });
}

const events = (r: Rig) => r.journal.listEvents(REPO, 300, "20").map((e) => e.detail ?? "");

describe("a failed adoption is reported as its test failure (node #568)", () => {
 const cleanup: string[] = [];
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  restoreEnv();
 });

 test("a build pass that commits nothing names the adoption's failing test, not 'nothing to push'", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  const tests = scriptedTests(r, [FAILED, FAILED]);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  const pushed = await r.github.sha(BRANCH);
  expect(tests.calls).toBe(1);
  r.ctx.workerCommand = [implementWorker, "noop"];
  reclaim(r);
  const outcome = await runNode("20", r.ctx);
  expect(tests.calls).toBe(2);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("widgets > renders the feature");
  expect(outcome.detail).toContain("the build pass after it committed nothing");
  expect(outcome.detail).not.toContain("nothing to push");
  const row = r.journal.getWorker("20", REPO);
  expect(row?.outcome).toContain("widgets > renders the feature");
  expect(await r.github.sha(BRANCH)).toBe(pushed);
  expect(r.github.prs.size).toBe(0);
  expect(events(r).some((d) => d.includes("widgets > renders the feature") && d.endsWith("— the worker continues"))).toBe(true);
 }, 120_000);

 test("an adoption whose timed-out test run passes on the retry is pushed and opens its draft PR", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  scriptedTests(r, [FAILED, TIMED_OUT, PASSED]);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  r.ctx.workerCommand = [implementWorker, "noop"];
  reclaim(r);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("awaiting-merge");
  const head = await r.github.sha(BRANCH);
  expect(head).not.toBe("");
  expect(r.github.prs.size).toBe(1);
  const [pr] = [...r.github.prs.values()];
  expect(pr.head).toBe(BRANCH);
  expect(events(r).some((d) => d.startsWith("adoption tests timed out") && d.includes("retrying once"))).toBe(true);
  expect(events(r).some((d) => d.startsWith(`adopting ${head.slice(0, 8)}`))).toBe(true);
 }, 120_000);

 test("a build pass that commits nothing on a branch with no work of its own still reports nothing to push", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  const tests = scriptedTests(r, [FAILED]);
  r.ctx.workerCommand = [implementWorker, "noop"];
  const outcome = await runNode("20", r.ctx);
  expect(tests.calls).toBe(0);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("worker exited 0 but committed nothing — nothing to push");
  expect(outcome.detail).not.toContain("the build pass after it committed nothing");
  expect(r.github.prs.size).toBe(0);
 }, 120_000);
});

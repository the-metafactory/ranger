import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCmd, type RunResult } from "../src/exec.ts";
import { workerLogFile } from "../src/worker-log.ts";
import { runNode } from "../src/worker.ts";
import { loadSequence, restoreEnv, rig, implementWorker, type Rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const TIMED_OUT: RunResult = { code: -1, stdout: "(pass) widgets > renders [1.00ms]\n", stderr: "", timedOut: true };
const PASSED: RunResult = { code: 0, stdout: "", stderr: "" };
const NAMED_FAILURE: RunResult = { code: 1, stdout: "(fail) widgets > renders [1.00ms]\n 1 fail\n", stderr: "" };

function scriptedTests(r: Rig, runs: RunResult[]): { calls: number } {
 const seen = { calls: 0 };
 r.ctx.shellRun = async (command, opts) => {
  if (command !== r.ctx.map.commands.test) return runCmd("/bin/sh", ["-c", command], opts);
  seen.calls += 1;
  return runs[Math.min(seen.calls, runs.length) - 1];
 };
 return seen;
}

function quietHost(r: Rig) {
 r.ctx.hostLoad = loadSequence(Array(20).fill(0), 1);
 r.ctx.quietHost = { pollMs: 1, maxMs: 1 };
}

const details = (r: Rig) => r.journal.listEvents(REPO, 300, "20").map((e) => e.detail ?? "");
const workerLog = (r: Rig) => readFileSync(workerLogFile(r.journal.path, REPO, "20", 1), "utf8");

describe("a supervisor test run that hits its timeout (node #476)", () => {
 const cleanup: string[] = [];
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  restoreEnv();
 });

 test("a timeout on a quiet host retries once in a fresh checkout, and a passing retry passes the gate", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  const tests = scriptedTests(r, [TIMED_OUT, PASSED]);
  const outcome = await runNode("20", r.ctx);
  expect(tests.calls).toBe(2);
  expect(outcome.status).toBe("awaiting-merge");
  expect(details(r).some((d) => d.includes("timed out after 1200 s on a quiet host — retrying once, in a fresh checkout"))).toBe(true);
  expect(details(r).some((d) => d.includes("passed on the retry in a fresh checkout"))).toBe(true);
 }, 120_000);

 test("a recovered timeout cannot waive a later no-commit fix failure", async () => {
  const r = await rig({ blockers: [1, 0] });
  cleanup.push(r.dir); quietHost(r);
  const tests = scriptedTests(r, [TIMED_OUT, PASSED]);
  let workers = 0;
  r.ctx.worker = (prompt, opts) => runCmd(implementWorker, [workers++ === 0 ? "build" : "noop", prompt], opts);
  const outcome = await runNode("20", r.ctx);
  expect(tests.calls).toBeGreaterThanOrEqual(2);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("committed nothing");
  expect(r.journal.deadmanCount()).toBe(1);
 }, 120_000);

 test("a second timeout parks with bounded infrastructure recovery and no code strike", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  const tests = scriptedTests(r, [TIMED_OUT]);
  const outcome = await runNode("20", r.ctx);
  expect(tests.calls).toBe(2);
  expect(outcome.status).toBe("parked");
  expect(r.journal.deadmanCount()).toBe(0);
  expect(outcome.detail).toContain("next retry");
  expect(workerLog(r)).toContain("timed out after 1200 s");
  expect(outcome.detail).not.toContain("exit -1");
 }, 120_000);

 test("a run that fails by itself on a quiet host is not retried and still reads as its exit code", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  const tests = scriptedTests(r, [NAMED_FAILURE]);
  const outcome = await runNode("20", r.ctx);
  expect(tests.calls).toBe(1);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("failed after the worker (exit 1) — failing: widgets > renders");
  expect(workerLog(r)).toMatch(/supervisor tests \(.*\) — exit 1\n/);
 }, 120_000);

 test("a real hung test command is killed, its processes are in the worker log, and the retry passes", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  quietHost(r);
  const marker = join(r.dir, "second-run");
  r.ctx.map.commands.test = `test -f '${marker}' && exit 0; touch '${marker}'; sleep 31.7`;
  r.ctx.map.commands.testTimeoutMin = 0.05;
  await runNode("20", r.ctx);
  const log = workerLog(r);
  expect(log).toMatch(/supervisor tests \(.*\) — timed out after 3 s\n/);
  expect(log).toContain("----- timeout capture");
  expect(log).toContain("sleep 31.7");
  expect(details(r).some((d) => d.includes("passed on the retry in a fresh checkout"))).toBe(true);
 }, 120_000);
});

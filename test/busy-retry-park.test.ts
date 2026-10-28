import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runCmd } from "../src/exec.ts";
import { HOST_LOAD_OUTCOME } from "../src/outcomes.ts";
import { runNode } from "../src/worker.ts";
import { implementWorker, loadSequence, restoreEnv, rig, type Rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const LOAD_FLAKE = "(fail) ConfigWatcher > reloads on change [5001.00ms]";
const quietStartBusyEnd = [0, 20, 0, 20];

function failingTests(r: Rig, code: number, stdout: string) {
 r.ctx.shellRun = async (command, opts) => command === r.ctx.map.commands.test
  ? { code, stdout, stderr: "" }
  : runCmd("/bin/sh", ["-c", command], opts);
}

function hostLoads(r: Rig, loads: number[]) {
 r.ctx.hostLoad = loadSequence([...loads], 1);
 r.ctx.quietHost = { pollMs: 1, maxMs: 1 };
}

function resumeAfterPark(r: Rig, loads: number[]) {
 const [queued] = r.journal.listResumeQueue();
 r.journal.removeResume(queued, "resume-cancelled", "test");
 r.journal.updateWorker("20", REPO, { status: "claimed" });
 r.ctx.workerCommand = [implementWorker, "add-fixed"];
 hostLoads(r, loads);
}

const events = (r: Rig) => r.journal.listEvents(REPO, 300, "20");

const adoptionThenSupervisorRetry = [0, 0, ...quietStartBusyEnd];

describe("a supervisor test retry that ends on a busy host (node #430)", () => {
 const cleanup: string[] = [];
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  restoreEnv();
 });

 test("a retry that started quiet, failed, and ended on a busy host parks for a quiet host, naming both loads", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  failingTests(r, 1, `${LOAD_FLAKE}\n 1 fail\n`);
  hostLoads(r, quietStartBusyEnd);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toMatch(HOST_LOAD_OUTCOME);
  expect(outcome.detail).toContain("the retry started on a quiet host (load 0.0 on 1 cores), failed, and the host read busy as it ended (failing: ConfigWatcher > reloads on change)");
  expect(r.journal.listResumeQueue().map((q) => [q.nodeId, q.reason])).toEqual([["20", "host-load"]]);
  expect(r.journal.deadmanCount()).toBe(0);
  expect(r.github.prs.size).toBe(0);
  const park = events(r).filter((e) => e.kind === "host-busy-end");
  expect(park).toHaveLength(1);
  expect(park[0].detail).toContain("started on a quiet host (load 0.0 on 1 cores) and ended on a busy one (load 20.0 on 1 cores)");
  expect(events(r).some((e) => (e.detail ?? "").includes("failed after the worker"))).toBe(false);
 }, 120_000);

 test("a second such park within 24 hours is the node's failure", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  failingTests(r, 1, `${LOAD_FLAKE}\n 1 fail\n`);
  hostLoads(r, quietStartBusyEnd);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  expect(r.journal.deadmanCount()).toBe(0);
  resumeAfterPark(r, adoptionThenSupervisorRetry);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).not.toMatch(HOST_LOAD_OUTCOME);
  expect(r.journal.listResumeQueue()).toEqual([]);
  expect(r.journal.deadmanCount()).toBe(1);
  expect(events(r).filter((e) => e.kind === "host-busy-end")).toHaveLength(1);
  expect(events(r).some((e) => (e.detail ?? "").includes("ended on a busy one (load 20.0 on 1 cores) for the second time in 24h — it counts as the node's failure"))).toBe(true);
 }, 240_000);

 test("a retry killed on a busy host earlier the same day uses up the node's one park", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  failingTests(r, -1, "(pass) widgets > renders [1.00ms]\n");
  hostLoads(r, quietStartBusyEnd);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  expect(events(r).filter((e) => e.kind === "host-killed")).toHaveLength(1);
  failingTests(r, 1, `${LOAD_FLAKE}\n 1 fail\n`);
  resumeAfterPark(r, adoptionThenSupervisorRetry);
  expect((await runNode("20", r.ctx)).status).toBe("failed");
  expect(r.journal.listResumeQueue()).toEqual([]);
  expect(r.journal.deadmanCount()).toBe(1);
  expect(events(r).filter((e) => e.kind === "host-busy-end")).toHaveLength(0);
  expect(events(r).some((e) => (e.detail ?? "").includes("ended on a busy one (load 20.0 on 1 cores) for the second time in 24h"))).toBe(true);
 }, 240_000);

 test("a retry that started quiet and failed on a host still quiet as it ends fails the node, as before", async () => {
  const r = await rig({});
  cleanup.push(r.dir);
  failingTests(r, 1, `${LOAD_FLAKE}\n 1 fail\n`);
  hostLoads(r, [0, 20, 0]);
  const outcome = await runNode("20", r.ctx);
  expect(outcome.status).toBe("failed");
  expect(outcome.detail).toContain("failed after the worker");
  expect(r.journal.listResumeQueue()).toEqual([]);
  expect(r.journal.deadmanCount()).toBe(1);
  expect(events(r).some((e) => e.kind === "host-busy-end")).toBe(false);
 }, 120_000);
});

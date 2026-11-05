import { describe, expect, test } from "bun:test";
import { pidAlive, runCmd } from "../src/exec.ts";
import { captureProcessGroup, processTree } from "../src/timeout-capture.ts";

const HANGS = "sleep 37.3 & wait";

describe("runCmd timeoutCapture (node #476)", () => {
 test("the capture runs while the group is alive, then the group is killed and the text is on the result", async () => {
  let aliveDuringCapture = false;
  const result = await runCmd("/bin/sh", ["-c", HANGS], {
   timeoutMs: 100,
   processGroup: true,
   timeoutCapture: {
    limitMs: 2_000,
    capture: async (pgid) => {
     aliveDuringCapture = pidAlive(pgid);
     return "what was running";
    },
   },
  });
  expect(aliveDuringCapture).toBe(true);
  expect(result.timedOut).toBe(true);
  expect(result.timeoutCapture).toBe("what was running");
 });

 test("a capture that hangs still kills the group within its limit", async () => {
  const started = Date.now();
  const result = await runCmd("/bin/sh", ["-c", HANGS], {
   timeoutMs: 100,
   processGroup: true,
   timeoutCapture: { limitMs: 200, capture: () => new Promise(() => undefined) },
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.timedOut).toBe(true);
  expect(result.timeoutCapture).toContain("did not finish within 200 ms");
 });

 test("a capture that throws still kills the group and leaves the result otherwise unchanged", async () => {
  const result = await runCmd("/bin/sh", ["-c", `echo out; ${HANGS}`], {
   timeoutMs: 200,
   processGroup: true,
   timeoutCapture: { limitMs: 2_000, capture: async () => { throw new Error("ps is gone"); } },
  });
  expect(result.timedOut).toBe(true);
  expect(result.code).toBe(-1);
  expect(result.stdout).toBe("out\n");
  expect(result.timeoutCapture).toContain("ps is gone");
 });

 test("a process that exits during the capture is not timed out and carries no capture", async () => {
  const result = await runCmd("/bin/sh", ["-c", "sleep 0.3; exit 7"], {
   timeoutMs: 100,
   processGroup: true,
   timeoutCapture: { limitMs: 3_000, capture: () => new Promise((resolve) => setTimeout(() => resolve("late"), 1_000)) },
  });
  expect(result.code).toBe(7);
  expect(result.timedOut).toBeUndefined();
  expect(result.timeoutCapture).toBeUndefined();
 });

 test("without a capture the timeout kills at once, as before", async () => {
  const result = await runCmd("/bin/sh", ["-c", HANGS], { timeoutMs: 100, processGroup: true });
  expect(result.timedOut).toBe(true);
  expect(result.timeoutCapture).toBeUndefined();
 });
});

describe("processTree", () => {
 const row = (pid: number, ppid: number, pgid: number, command: string) => `${pid} ${ppid} ${pgid} S 00:10 0:01.00 0.0 ${command}`;
 const listing = [
  row(10, 1, 10, "sh -c tests"),
  row(11, 10, 10, "bun test"),
  row(12, 11, 12, "nats-server left the group"),
  row(13, 12, 13, "its child"),
  row(20, 1, 20, "unrelated"),
 ].join("\n");

 test("keeps the group and every descendant, even one that left the group, and nothing else", () => {
  expect(processTree(listing, 10).map((p) => p.pid)).toEqual([10, 11, 12, 13]);
 });

 test("an empty group has no processes", () => {
  expect(processTree(listing, 99)).toEqual([]);
 });
});

describe("captureProcessGroup", () => {
 test("names the real processes of a live group", async () => {
  let text = "";
  await runCmd("/bin/sh", ["-c", HANGS], {
   timeoutMs: 100,
   processGroup: true,
   timeoutCapture: { limitMs: 20_000, capture: async (pgid) => (text = await captureProcessGroup(pgid, "linux")) },
  });
  expect(text).toContain("sleep 37.3");
  expect(text).toContain("sample: not available on linux");
 });

 test.if(process.platform === "darwin")("samples the group's processes where sample exists", async () => {
  let text = "";
  await runCmd("/bin/sh", ["-c", HANGS], {
   timeoutMs: 100,
   processGroup: true,
   timeoutCapture: { limitMs: 20_000, capture: async (pgid) => (text = await captureProcessGroup(pgid)) },
  });
  expect(text).toMatch(/----- sample \d+/);
  expect(text).toContain("Call graph:");
 }, 30_000);
});

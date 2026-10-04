import { describe, expect, test } from "bun:test";
import { caffeinateArgs, holdAwake } from "../src/awake.ts";
import { isReadRequest } from "../src/github.ts";
import { parseFailedProbes, probeRetryCommandFor } from "../src/implement.ts";
import { isTransientGitHubError, runReadRetryingTransient } from "../src/transient.ts";

/** The two errors that ended #45 and #663 on 2026-10-03, verbatim in shape. */
const GRAPHQL_TIMEOUT =
 "sage review the-metafactory/ranger#50 exited 1: at. Please try resubmitting your request and contact us if the problem persists. (https://api.github.com/graphql) — gh: We couldn't respond to your request in time. Sorry about that.";
const REST_TIMEOUT =
 "gh api GET repos/jcfischer/seelite/issues/1/dependencies/blocked_by failed (exit 1): gh: We couldn't respond to your request in time. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (HTTP 504)";

describe("transient GitHub errors (found live on #45 and #663)", () => {
 test("the live timeouts and 5xx responses are transient", () => {
  expect(isTransientGitHubError(GRAPHQL_TIMEOUT)).toBe(true);
  expect(isTransientGitHubError(REST_TIMEOUT)).toBe(true);
  expect(isTransientGitHubError("gh: Server Error (HTTP 502)")).toBe(true);
  expect(isTransientGitHubError("read ECONNRESET")).toBe(true);
 });
 test("node faults and auth failures are not", () => {
  expect(isTransientGitHubError("gh: Not Found (HTTP 404)")).toBe(false);
  expect(isTransientGitHubError("gh: Bad credentials (HTTP 401)")).toBe(false);
  expect(isTransientGitHubError("worker exited 1: tests failed")).toBe(false);
  expect(isTransientGitHubError("worker produced no commits — committed nothing")).toBe(false);
 });

 const noSleep = { backoffMs: [0, 0], sleep: async () => {} };

 test("a read that hits a transient error is retried until it succeeds", async () => {
  // The script fails transiently twice, then succeeds, counting runs in a temp file.
  const counter = `${process.env.TMPDIR ?? "/tmp"}/ranger-transient-${process.pid}-${Date.now()}`;
  const script = `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; if [ $n -lt 3 ]; then echo "gh: We couldn't respond to your request in time." >&2; exit 1; fi; echo ok`;
  const retries: number[] = [];
  const r = await runReadRetryingTransient("/bin/sh", ["-c", script], {}, { ...noSleep, onRetry: (a) => retries.push(a) });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("ok");
  expect(retries).toEqual([2, 3]);
 });
 test("a non-transient failure returns at once", async () => {
  const retries: number[] = [];
  const r = await runReadRetryingTransient("/bin/sh", ["-c", "echo 'HTTP 404' >&2; exit 1"], {}, { ...noSleep, onRetry: (a) => retries.push(a) });
  expect(r.code).toBe(1);
  expect(retries).toEqual([]);
 });
 test("retries stop after the backoff list, returning the last failure", async () => {
  const r = await runReadRetryingTransient("/bin/sh", ["-c", "echo 'HTTP 503' >&2; exit 1"], {}, noSleep);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("503");
 });
 test("shouldRetry can veto (a sage run that carries a verdict is never repeated)", async () => {
  const retries: number[] = [];
  const r = await runReadRetryingTransient(
   "/bin/sh",
   ["-c", "printf 'HTTP 503 handling\\n```json\\n{}\\n```\\n'; exit 1"],
   {},
   { ...noSleep, shouldRetry: (res) => !res.stdout.includes("```json"), onRetry: (a) => retries.push(a) },
  );
  expect(r.code).toBe(1);
  expect(retries).toEqual([]);
 });
});

describe("only GET requests are retried", () => {
 test("plain paths and an explicit GET are reads", () => {
  expect(isReadRequest(["repos/a/b/pulls/1"])).toBe(true);
  expect(isReadRequest(["-X", "GET", "repos/a/b/pulls"])).toBe(true);
  expect(isReadRequest(["repos/a/b/issues/1/comments", "--paginate"])).toBe(true);
 });
 test("a body or another method is a write", () => {
  expect(isReadRequest(["-X", "POST", "repos/a/b/pulls", "-f", "title=x"])).toBe(false);
  expect(isReadRequest(["repos/a/b/issues/1/comments", "-f", "body=x"])).toBe(false);
  expect(isReadRequest(["--method", "PUT", "repos/a/b/pulls/1/merge"])).toBe(false);
  expect(isReadRequest(["--method=PATCH", "repos/a/b/pulls/1"])).toBe(false);
  expect(isReadRequest(["repos/a/b/pulls", "--input", "body.json"])).toBe(false);
 });
});

describe("a failed probe run retries only its failures", () => {
 const OUT = "ok   probe-a.mjs (2.0s)\nFAIL probe-commander.mjs (43.0s) exit=1 crash\nFAILED: probe-commander.mjs · probe-music.mjs\n";
 test("the runner's FAILED line names the probes", () => {
  expect(parseFailedProbes(OUT)).toEqual(["probe-commander.mjs", "probe-music.mjs"]);
  expect(parseFailedProbes("all ok\n")).toEqual([]);
 });
 test("a name that is not a plain probe file voids the list (full rerun)", () => {
  expect(parseFailedProbes("FAILED: probe-a.mjs · $(rm -rf ~).mjs\n")).toEqual([]);
  expect(parseFailedProbes("FAILED: ../escape.mjs\n")).toEqual([]);
 });
 test("the retry template gets the comma-separated failures and the node id", () => {
  expect(probeRetryCommandFor("PROBE_SELECTION=1 PROBE_FILES={failed} npm run probe # {node}", "433", ["probe-a.mjs", "probe-b.mjs"]))
   .toBe("PROBE_SELECTION=1 PROBE_FILES=probe-a.mjs,probe-b.mjs npm run probe # 433");
  expect(() => probeRetryCommandFor("x {failed}", "1", ["a;b.mjs"])).toThrow();
 });
});

describe("the host stays awake while run-node lives (found live on #658)", () => {
 test("caffeinate holds idle sleep until the supervisor exits", () => {
  expect(caffeinateArgs(4242)).toEqual(["-i", "-w", "4242"]);
 });
 test("macOS spawns caffeinate detached; other platforms do nothing", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fake = ((bin: string, args: string[]) => {
   calls.push({ bin, args });
   return { on: () => {}, unref: () => {} };
  }) as unknown as typeof import("node:child_process").spawn;
  expect(holdAwake(77, "darwin", fake)).toBe(true);
  expect(calls).toEqual([{ bin: "caffeinate", args: ["-i", "-w", "77"] }]);
  expect(holdAwake(77, "linux", fake)).toBe(false);
  expect(calls.length).toBe(1);
 });
});

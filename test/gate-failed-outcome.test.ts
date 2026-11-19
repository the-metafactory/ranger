import { expect, test } from "bun:test";
import { isGateFailedOutcome, journalOutcome, MERGE_GATE_PROBES_FAILED_OUTCOME, mergeGateFailedOutcome, PROBES_FAILED_OUTCOME, probesFailedOutcome, TESTS_FAILED_OUTCOME, testsFailedOutcome } from "../src/outcomes.ts";

test.each(["acme/widgets", "gitlab:gitlab.com/acme/widgets"])("gate producers match their shared classifiers after journal truncation: %s", repo => {
 const probes = probesFailedOutcome({ repo, sha: "abcdef123456", pr: 1, exit: 1, failed: ["probe.mjs"], tail: "failure output".repeat(100) });
 const mergeGate = mergeGateFailedOutcome({ check: "probes", reason: "no passing probe run recorded" });
 expect(PROBES_FAILED_OUTCOME.test(probes)).toBe(true);
 expect(MERGE_GATE_PROBES_FAILED_OUTCOME.test(mergeGate)).toBe(true);
 for (const outcome of [probes, mergeGate]) {
  expect(isGateFailedOutcome(journalOutcome(outcome))).toBe(true);
 }
});

test.each([{ names: [] }, { names: ["suite > fails"] }])("a supervisor test outcome preserves its text and matches the gate classifier: %j", ({ names }) => {
 const outcome = testsFailedOutcome({ command: "bun test && (bun run lint)", after: "after the worker", exit: "exit 1", names, tail: "failure output".repeat(100) });
 const failing = names.length > 0 ? " — failing: suite > fails" : " — failing test names unavailable";
 expect(outcome).toBe(`tests (bun test && (bun run lint)) failed after the worker (exit 1)${failing} — output tail: ${"failure output".repeat(100)}`);
 expect(TESTS_FAILED_OUTCOME.test(outcome)).toBe(true);
 expect(isGateFailedOutcome(journalOutcome(outcome))).toBe(true);
});

test.each(["ci-green", "review-clean", "mergeable"])("another merge-gate producer does not match a probe park: %s", check => {
 const outcome = mergeGateFailedOutcome({ check, reason: "browser probes failed twice\ntests (bun test) failed after the worker" });
 expect(MERGE_GATE_PROBES_FAILED_OUTCOME.test(outcome)).toBe(false);
 expect(isGateFailedOutcome(outcome)).toBe(false);
});

test.each([
 "browser probes failed twice at abcdef12 on PR #1 (exit 1)",
 "browser probes failed twice at abcdef12 on PR #1 (exit 1)\nFAILED: probe.mjs",
 "merge gate failed (probes): no passing probe record",
 "tests (bun run test && bun run lint) failed after the worker (exit 1)",
 "tests (test -f base-1.txt) failed on the resumed worktree (exit 1)",
])("a gate failure matches its first line: %s", outcome => {
 expect(isGateFailedOutcome(outcome)).toBe(true);
});

test.each([
 "review cap reached: 2 sage round(s)",
 "PR #1 conflicts with main again after 2 base merge pass(es)",
 "worker budget spent",
 "waiting for a quiet host: load 20 on 1 cores — tests (bun test) failed",
 "worker exited 1\ntests (bun test) failed after the worker (exit 1)",
 "worker exited 1\nbrowser probes failed twice",
 "tests (bun test) passed after the worker",
 "",
])("another park does not match a gate failure: %s", outcome => {
 expect(isGateFailedOutcome(outcome)).toBe(false);
});

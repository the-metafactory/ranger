import { expect, test } from "bun:test";
import { isGateFailedOutcome } from "../src/outcomes.ts";

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

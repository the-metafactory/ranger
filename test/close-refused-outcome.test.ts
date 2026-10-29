import { expect, test } from "bun:test";
import { closeRefusalHead, closeRefusedOutcome, journalOutcome } from "../src/outcomes.ts";

const HEAD = "probe command:bun run test|/repo|1800|0 on node 1002 ran and failed";

test("a failed probe's park carries its output, so the refusal can be diagnosed (soma #1002)", () => {
 expect(closeRefusedOutcome(`${HEAD}: exit 1: (fail) the vent test`)).toBe(`close refused after merge: ${HEAD}: exit 1: (fail) the vent test`);
});

test("a long tail keeps its end, where a test run names its failures", () => {
 const outcome = closeRefusedOutcome(`${HEAD}: exit 1: ${"x".repeat(2000)}(fail) the vent test`);
 expect(outcome).toStartWith(`close refused after merge: ${HEAD}: …`);
 expect(outcome).toEndWith("(fail) the vent test");
 expect(outcome.length).toBeLessThan(800);
});

test("a refusal without probe output reads as before", () => {
 expect(closeRefusedOutcome(HEAD)).toBe(`close refused after merge: ${HEAD}`);
 expect(closeRefusedOutcome("Close refused.\n\nno CI")).toBe("close refused after merge: Close refused.\n\nno CI");
});

test("journal storage preserves a refused close's bounded head and bun failure tail", () => {
 const failures = "(fail) close gate > preserves names\n(fail) journal > preserves counts\n 1234 pass\n 2 fail\nRan 1236 tests across 150 files.";
 const outcome = closeRefusedOutcome(`probe command:${"long-command".repeat(200)} ran and failed: exit 1:\n${"passing output\n".repeat(200)}${failures}`);
 expect(outcome.length).toBeGreaterThan(400);
 expect(outcome.length).toBeLessThanOrEqual(1300);
 expect(outcome).toContain(failures);
 expect(journalOutcome(outcome)).toBe(outcome);
});

test("journal storage caps even an oversized refused-close outcome", () => {
 const outcome = `close refused after merge: ${"x".repeat(4000)}`;
 expect(journalOutcome(outcome)).toBe(outcome.slice(0, 1300));
});

test("journal storage keeps the 400-character bound for other outcomes", () => {
 for (const head of ["success: ", "failed: ", "blocked: ", "browser probes failed twice: "]) {
  const outcome = head + "x".repeat(2000);
  expect(journalOutcome(outcome)).toBe(outcome.slice(0, 400));
 }
 expect(journalOutcome("short outcome")).toBe("short outcome");
});

test("the head leaves out the probe's output", () => {
 expect(closeRefusalHead(`${HEAD}: exit 1: error connecting to api.github.com`)).toBe(HEAD);
 expect(closeRefusalHead("gh api failed: error connecting to api.github.com")).toBe("gh api failed: error connecting to api.github.com");
});

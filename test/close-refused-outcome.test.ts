import { expect, test } from "bun:test";
import { closeRefusalHead, closeRefusedOutcome } from "../src/outcomes.ts";

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

test("the head leaves out the probe's output", () => {
 expect(closeRefusalHead(`${HEAD}: exit 1: error connecting to api.github.com`)).toBe(HEAD);
 expect(closeRefusalHead("gh api failed: error connecting to api.github.com")).toBe("gh api failed: error connecting to api.github.com");
});

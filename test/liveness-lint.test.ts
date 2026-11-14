import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { LIVENESS } from "../eslint.config.ts";

const linter = new Linter({ configType: "flat" });
const flagged = (code: string) =>
 linter
  .verify(code, [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, rules: { "no-restricted-syntax": ["error", LIVENESS] } }], "x.ts")
  .map((m) => m.line);

describe("worker liveness has one owner", () => {
 test("flags the inline status checks that drifted in #65 and #481", () => {
  const code = [
   'const inFlight = workers.filter((w) => w.status === "claimed" || w.status === "running");',
   'const status = row.status === "claimed" || row.status === "running" ? "parked" : row.status;',
   'if (row.status !== "claimed" && row.status !== "running") stop();',
   'const stale = (status: string) => status === "released" || status === "claimed";',
  ].join("\n");
  expect(flagged(code)).toEqual([1, 2, 3, 4]);
 });

 test("leaves job runs and other kinds alone", () => {
  const code = [
   'if (run.status !== "running") skip();',
   'if (e.kind === "claimed") stop();',
  ].join("\n");
  expect(flagged(code)).toEqual([]);
 });
});

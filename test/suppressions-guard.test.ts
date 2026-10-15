import { describe, expect, test } from "bun:test";
import { grownRules } from "../eslint/suppressions-guard.ts";

const base = {
 "src/a.ts": { "ranger/no-comments": { count: 3 }, "no-empty": { count: 1 } },
 "src/b.ts": { "ranger/no-comments": { count: 2 } },
};

describe("suppressions guard", () => {
 test("passes when the baseline shrinks", () => {
  expect(grownRules(base, { "src/a.ts": { "ranger/no-comments": { count: 1 } } })).toEqual([]);
 });

 test("passes a rename that moves counts to a new path", () => {
  const head = { "src/a-moved.ts": base["src/a.ts"], "src/b.ts": base["src/b.ts"] };
  expect(grownRules(base, head)).toEqual([]);
 });

 test("fails when --suppress-all adds violations", () => {
  const head = { ...base, "src/c.ts": { "ranger/no-comments": { count: 4 } } };
  expect(grownRules(base, head)).toEqual(["ranger/no-comments: 5 -> 9"]);
 });

 test("fails on a rule the base never suppressed", () => {
  const head = { ...base, "src/b.ts": { "ranger/no-comments": { count: 2 }, "@typescript-eslint/no-explicit-any": { count: 1 } } };
  expect(grownRules(base, head)).toEqual(["@typescript-eslint/no-explicit-any: 0 -> 1"]);
 });
});

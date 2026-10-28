import { describe, expect, test } from "bun:test";
import { bunTestChain } from "../src/implement.ts";

const command = "bun run test && bunx tsc --noEmit && bun run lint";
const script = "bun test --parallel=4 --timeout=60000";

describe("bun test package-script resolution", () => {
 test("resolves Ranger's test script and keeps the remaining steps", () => {
  expect(bunTestChain(command, () => script)).toEqual({
   bun: script,
   rest: "bunx tsc --noEmit && bun run lint",
  });
 });

 test("resolves a script alone or between other steps", () => {
  expect(bunTestChain("bun run test", () => ` ${script} `)).toEqual({ bun: script, rest: "" });
  expect(bunTestChain("bun run lint && bun run test && bunx tsc --noEmit", () => script)).toEqual({
   bun: script,
   rest: "bun run lint && bunx tsc --noEmit",
  });
 });

 test.each(["npm test", "npm run test"])("resolves %s through the package's test script", (step) => {
  expect(bunTestChain(step, () => "bun test tests/")).toEqual({ bun: "bun test tests/", rest: "" });
  expect(bunTestChain(`${step} && bunx tsc --noEmit`, () => script)).toEqual({
   bun: script,
   rest: "bunx tsc --noEmit",
  });
 });

 test.each(["npm test", "npm run test"])("%s refuses a script that is not a plain bun test step", (step) => {
  for (const value of [undefined, "vitest run", "bun test && eslint .", "bun run test", "npm test"]) {
   expect(bunTestChain(`${step} && bunx tsc --noEmit`, () => value)).toBeNull();
  }
  expect(bunTestChain(step, () => { throw new Error("unreadable package.json"); })).toBeNull();
  expect(bunTestChain(step)).toBeNull();
 });

 test.each([
  "npm test && bun test", "npm test && bun run test", "npm run test && npm test", "npm test --coverage",
 ])("rejects npm commands with more than one test step or extra arguments: %s", (value) => {
  expect(bunTestChain(value, () => script)).toBeNull();
 });

 test.each([
  undefined, null, 12, {}, "", "bun tester", "npm test", "bun run test", "bun run other",
  "bun test && eslint .", "bun test; eslint .", "bun test || true", "bun test | tee log",
  "bun test > log", "bun test &", "bun test $(echo test)", "bun test -t 'a b'", "bun test\neslint .",
 ])("rejects a missing or non-plain bun test script: %p", (value) => {
  expect(bunTestChain(command, () => value)).toBeNull();
 });

 test("an unreadable package script refuses the chain", () => {
  expect(bunTestChain(command, () => { throw new Error("unreadable package.json"); })).toBeNull();
 });

 test.each([
  "bun run test && bun test", "bun run test && bun run test", "bun run test --coverage",
  "bun run other", "bun run test; true", "bun run test || true", "bun run test && echo $(true)",
 ])("rejects ambiguous commands even with a plain script: %s", (value) => {
  expect(bunTestChain(value, () => script)).toBeNull();
 });

 test("literal bun test commands need no package reader", () => {
  expect(bunTestChain("bun test && bun run lint", () => { throw new Error("must not read"); })).toEqual({
   bun: "bun test",
   rest: "bun run lint",
  });
  expect(bunTestChain(command)).toBeNull();
 });
});

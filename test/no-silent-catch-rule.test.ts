import { describe, expect, test } from "bun:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { ranger } from "../eslint/plugin.ts";

const linter = new Linter({ configType: "flat" });
const flagged = (code: string) =>
 linter
  .verify(code, [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { ranger }, rules: { "ranger/no-silent-catch": "error" } }], "x.ts")
  .map((m) => m.line);

describe("ranger/no-silent-catch", () => {
 test("flags a failure returned as an empty answer: #515's catch and #221's .catch", () => {
  const code = [
   "async function open(id: string) {",
   " try { return await read(id); }",
   " catch {",
   "  return null;",
   " }",
   "}",
   "const ref = readReference(path).catch(() => null);",
   "const labels = load().catch((_e) => []);",
   "function f() { try { return go(); } catch (error) { return false; } }",
   "const g = p.catch(function () { return {}; });",
  ].join("\n");
  expect(flagged(code)).toEqual([4, 7, 8, 9, 10]);
 });

 test("keeps a catch that reads its error, rethrows, or returns a real value", () => {
  const code = [
   "function a() { try { return go(); } catch (error) { if (isEnoent(error)) return null; throw error; } }",
   "function b() { try { return go(); } catch { throw new Error('read failed'); } }",
   "function c() { try { return go(); } catch { return { ok: false } as const; } }",
   "const d = p.catch((error: unknown) => ({ ok: false, error }));",
   "function e() { try { go(); } catch { const inner = () => null; inner(); return 1; } }",
   "void Promise.resolve(1).catch();",
  ].join("\n");
  expect(flagged(code)).toEqual([]);
 });
});

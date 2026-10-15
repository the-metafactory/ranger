// ESLint 10 flat config, ported from cortex's eslint.config.js
// (typescript-eslint strictTypeChecked + stylisticTypeChecked, same rule set).
//
// Ranger additions:
//   - ranger/no-comments (eslint/no-comments.ts): code says it, comments don't.
//   - it also bans @ts-ignore / @ts-expect-error / @ts-nocheck outright
//     (ban-ts-comment is off: its message points at @ts-expect-error).
//   - noInlineConfig: `eslint-disable` comments do nothing; the only way to
//     carry a violation is eslint-suppressions.json, which shows in the diff.
//
// Existing violations live in eslint-suppressions.json. ESLint fails when a
// suppressed violation is fixed but still listed, so the file only shrinks:
//   bun run lint                       # CI gate
//   bun run lint --prune-suppressions  # after fixing suppressed violations
//   bun run lint:fix

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { ranger } from "./eslint/no-comments.ts";

export default defineConfig(
 js.configs.recommended,
 tseslint.configs.strictTypeChecked,
 tseslint.configs.stylisticTypeChecked,
 {
  linterOptions: { noInlineConfig: true },
  languageOptions: {
   parserOptions: {
    projectService: true,
    tsconfigRootDir: import.meta.dirname,
   },
  },
  plugins: { ranger },
  rules: {
   "ranger/no-comments": "error",
   "@typescript-eslint/ban-ts-comment": "off",

   "@typescript-eslint/no-floating-promises": "error",
   "@typescript-eslint/no-misused-promises": "error",
   "@typescript-eslint/no-deprecated": "error",
   "@typescript-eslint/no-redundant-type-constituents": "error",
   "@typescript-eslint/no-unused-vars": [
    "error",
    {
     argsIgnorePattern: "^_",
     varsIgnorePattern: "^_",
     caughtErrorsIgnorePattern: "^_",
    },
   ],
   "@typescript-eslint/restrict-plus-operands": "error",
   "no-useless-escape": "error",
   "no-useless-assignment": "error",
   "no-control-regex": "error",
   "@typescript-eslint/no-require-imports": "error",
   "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
   "@typescript-eslint/require-await": "error",
   "@typescript-eslint/no-unnecessary-condition": "error",
   "@typescript-eslint/await-thenable": "error",
   "@typescript-eslint/no-empty-function": "error",
   "@typescript-eslint/no-non-null-assertion": "error",
   "@typescript-eslint/prefer-nullish-coalescing": "error",
   "@typescript-eslint/no-explicit-any": "error",
   "@typescript-eslint/no-unsafe-assignment": "error",
   "@typescript-eslint/no-unsafe-member-access": "error",
   "@typescript-eslint/no-unsafe-call": "error",
   "@typescript-eslint/no-unsafe-argument": "error",
   "@typescript-eslint/no-unsafe-return": "error",
   "@typescript-eslint/no-base-to-string": "error",
   "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
   "@typescript-eslint/return-await": "error",
   "@typescript-eslint/no-unused-expressions": "error",
   "@typescript-eslint/unbound-method": "error",
   "@typescript-eslint/no-confusing-void-expression": "error",
  },
 },
 {
  // Same test-file carve-out as cortex: tests build any-typed mocks and
  // inject failures through unsafe casts.
  files: ["test/**/*.ts"],
  rules: {
   "@typescript-eslint/no-explicit-any": "off",
   "@typescript-eslint/no-non-null-assertion": "off",
   "@typescript-eslint/no-unsafe-assignment": "off",
   "@typescript-eslint/no-unsafe-member-access": "off",
   "@typescript-eslint/no-unsafe-call": "off",
   "@typescript-eslint/no-unsafe-argument": "off",
   "@typescript-eslint/no-unsafe-return": "off",
   "@typescript-eslint/no-floating-promises": "off",
   "@typescript-eslint/no-misused-promises": "off",
   "@typescript-eslint/restrict-template-expressions": "off",
   "@typescript-eslint/no-unused-vars": "off",
   "@typescript-eslint/no-deprecated": "off",
   "@typescript-eslint/require-await": "off",
   "@typescript-eslint/no-confusing-void-expression": "off",
   "@typescript-eslint/await-thenable": "off",
   "@typescript-eslint/no-unnecessary-condition": "off",
   "@typescript-eslint/no-empty-function": "off",
   "@typescript-eslint/unbound-method": "off",
  },
 },
 {
  // Outside tsconfig's include, so projectService cannot type them.
  ignores: ["node_modules/", "scripts/", "drizzle/", "design/", "docs/", "ops/", ".claude/", ".claude-wt/", "drizzle.config.ts", "eslint.config.ts"],
 },
);

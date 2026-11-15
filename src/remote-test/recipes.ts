export const MYELIN_REPOSITORY = "github:github.com/the-metafactory/myelin";
export const RANGER_REPOSITORY = "github:github.com/the-metafactory/ranger";
export const CORTEX_REPOSITORY = "github:github.com/the-metafactory/cortex";
export const RANGER_OPT_IN_TEST_FILES = [
 "test/remote-test-executor-integration.test.ts",
 "test/remote-test-profiles-integration.test.ts",
 "test/remote-test-ssh-integration.test.ts",
 "test/remote-test-bus-worker-transport.test.ts",
] as const;
const RANGER_BUN = ["bun", "--config=/dev/null", "--no-env-file"] as const;

/** Cortex's reviewed gates from scripts/check.ts at 4b79b01a, minus `up-to-date`
 * (localOnly: it needs origin/main, which an immutable bundle does not carry).
 * The three base-ref ratchets read the submitted commit's parent through their
 * own documented override because the bundle has no remote refs. */
export const CORTEX_GATES = [
 "lint", "duplication", "unused-exports", "typecheck", "vocab", "sdk", "shippable", "xdg",
] as const;
/** scripts/check.ts runs the `test` gate as these steps; the suite is the only
 * step that takes the reviewed exclusions, so the steps stay separate commands. */
export const CORTEX_TEST_STEPS = ["test-wake", "test-wake-cache", "test-desk-probes", "test-conversation-tools", "test"] as const;
export const CORTEX_CHECKS = [...CORTEX_GATES, ...CORTEX_TEST_STEPS] as const;

/** A skip or todo fails a reviewed receipt, so a file whose tests gate
 * themselves on a capability this lane does not provide is excluded whole.
 * Each exclusion names the gate; anything else needs renewed review. */
export const CORTEX_EXCLUDED_TESTS = [
 { file: "src/runner/__tests__/session-sandbox-macos.test.ts",
  reason: "every test runs under macOS sandbox-exec" },
 { file: "src/runner/__tests__/session-sandbox-macos-strict.test.ts",
  reason: "a sandbox-exec describe block and one skipIf(!isDarwin) test are skipped off Darwin" },
 { file: "src/runner/__tests__/cc-session-macos-sandbox-e2e.test.ts",
  reason: "the end-to-end block needs macOS sandbox-exec and a real claude binary" },
 { file: "src/runner/__tests__/cc-plugin-dir-pin.integration.test.ts",
  reason: "skips unless CLAUDE_BIN names a claude binary, and the container environment is fixed" },
 { file: "src/runner/__tests__/cc-session.test.ts",
  reason: "five testClaude cases skip without the claude binary" },
 { file: "src/runner/__tests__/agent-team.test.ts",
  reason: "three testClaude cases skip without the claude binary" },
 { file: "scripts/__tests__/systemd-render-e2e.test.ts",
  reason: "skips unless SYSTEMD_E2E=1 runs on a host with a systemd user session" },
 { file: "scripts/__tests__/systemd-remove-e2e.test.ts",
  reason: "skips unless SYSTEMD_E2E=1 runs on a host with a systemd user session" },
 { file: "scripts/__tests__/scan-deploy-surface.test.ts",
  reason: "six testEngine cases skip without the arc metafactory-actions pack in HOME" },
 { file: "src/surface/mc/__tests__/ui-dir.test.ts",
  reason: "one case skips without a built dist/dashboard-v2/index.html, which no gate builds" },
 { file: "src/conversations/__tests__/pi.test.ts",
  reason: "testSkipIf cases need a real pi binary on PATH" },
 { file: "src/conversations/__tests__/repository-files-pi.test.ts",
  reason: "testSkipIf cases need a real pi binary on PATH" },
 { file: "src/conversations/__tests__/repository-git-pi.test.ts",
  reason: "testSkipIf cases need a real pi binary on PATH" },
 { file: "src/conversations/__tests__/tools-history-pi.test.ts",
  reason: "testSkipIf cases need a real pi binary on PATH" },
 { file: "src/conversations/__tests__/tools-pi.test.ts",
  reason: "testSkipIf cases need a real pi binary on PATH" },
] as const;

/** connection.test.ts keeps one empty test.skip placeholder inside a live
 * describe; a name filter drops it without dropping the file's other tests. */
export const CORTEX_SKIPPED_TEST_NAME = "__bounded-statusLoop-tests-placeholder__";
export const CORTEX_TEST_NAME_PATTERN = `^(?!.*${CORTEX_SKIPPED_TEST_NAME})`;

export interface ReviewedRecipe {
 packageName: string;
 scripts: Readonly<Record<string, string>>;
 testRoots: readonly string[];
 checks: Readonly<Record<string, readonly [string, ...string[]]>>;
 needsNats: boolean;
}
export type ReviewedRecipeRegistry = Readonly<Record<string, Readonly<Record<string, ReviewedRecipe>>>>;

const CORTEX_BUN = ["bun", "--no-env-file"] as const;

export const REVIEWED_RECIPES: ReviewedRecipeRegistry = {
 [MYELIN_REPOSITORY]: { "myelin-v1": {
  packageName: "@the-metafactory/myelin",
  scripts: { test: "bun test", typecheck: "bunx tsc --noEmit", lint: "eslint ." },
  testRoots: ["src/", "scripts/", "tools/", "tests/integration/", "tests/package-exports.smoke.test.ts"],
  needsNats: true, checks: {
   unit: ["bun", "--config=/dev/null", "--no-env-file", "test", "./src", "./scripts", "./tools", "./tests/package-exports.smoke.test.ts"],
   integration: ["bun", "--config=/dev/null", "--no-env-file", "test", "./tests/integration"],
   typecheck: ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/typescript/bin/tsc", "--noEmit"],
   lint: ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/eslint/bin/eslint.js", "."],
  } } },
 [RANGER_REPOSITORY]: { "ranger-v1": {
  packageName: "@the-metafactory/ranger", scripts: {}, testRoots: ["test/"], needsNats: false, checks: {
   unit: [...RANGER_BUN, "test", "--preload=./test/preload.ts", "--randomize", "--parallel=2", "--timeout=60000", ...RANGER_OPT_IN_TEST_FILES.flatMap(file => ["--path-ignore-patterns", file])] as [string, ...string[]],
   typecheck: [...RANGER_BUN, "./node_modules/typescript/bin/tsc", "--noEmit"],
   lint: [...RANGER_BUN, "./node_modules/eslint/bin/eslint.js", "."],
  } } },
 [CORTEX_REPOSITORY]: { "cortex-v1": {
  packageName: "@the-metafactory/cortex",
  scripts: {
   test: "bun scripts/test.ts",
   "lint:errors": "bun eslint/suppressions-guard.ts && bun --bun eslint --quiet .",
   "sdk:dts:check": "bun scripts/gen-surface-sdk-dts.ts --check",
   "desk:dts:check": "bun scripts/gen-desk-sdk-dts.ts --check",
  },
  testRoots: ["src/", "scripts/", "eslint/"], needsNats: false, checks: {
   lint: ["env", "LINT_BASE_REF=HEAD^", ...CORTEX_BUN, "scripts/check.ts", "lint"],
   duplication: [...CORTEX_BUN, "scripts/check.ts", "duplication"],
   "unused-exports": [...CORTEX_BUN, "scripts/check.ts", "unused-exports"],
   typecheck: [...CORTEX_BUN, "scripts/check.ts", "typecheck"],
   vocab: [...CORTEX_BUN, "scripts/check.ts", "vocab"],
   sdk: ["env", "RELEASE_PINS_BASE_REF=HEAD^", "DESK_SDK_BASE_REF=HEAD^", ...CORTEX_BUN, "scripts/check.ts", "sdk"],
   shippable: [...CORTEX_BUN, "scripts/check.ts", "shippable"],
   xdg: [...CORTEX_BUN, "scripts/check.ts", "xdg"],
   "test-wake": [...CORTEX_BUN, "scripts/build-desk-wake.ts"],
   "test-wake-cache": [...CORTEX_BUN, "scripts/desk-wake/probe-build-cache.ts"],
   "test-desk-probes": [...CORTEX_BUN, "scripts/check-desk-probes.ts"],
   "test-conversation-tools": [...CORTEX_BUN, "scripts/probe-conversation-tools.ts"],
   test: [...CORTEX_BUN, "run", "test", "--parallel=2", ...CORTEX_EXCLUDED_TESTS.flatMap(({ file }) => ["--path-ignore-patterns", file]),
    `--test-name-pattern=${CORTEX_TEST_NAME_PATTERN}`],
  } } },
};

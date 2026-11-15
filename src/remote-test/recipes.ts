import type { ReviewedPolicy } from "./profiles.ts";

export const MYELIN_REPOSITORY = "github:github.com/the-metafactory/myelin";
export const RANGER_REPOSITORY = "github:github.com/the-metafactory/ranger";
export const RANGER_OPT_IN_TEST_FILES = [
 "test/remote-test-executor-integration.test.ts",
 "test/remote-test-profiles-integration.test.ts",
 "test/remote-test-ssh-integration.test.ts",
 "test/remote-test-bus-worker-transport.test.ts",
] as const;
const RANGER_BUN = ["bun", "--config=/dev/null", "--no-env-file"] as const;
export interface ReviewedRecipe {
 checks: Readonly<Partial<Record<ReviewedPolicy["checks"][number], readonly [string, ...string[]]>>>;
 needsNats: boolean;
}
export type ReviewedRecipeRegistry = Readonly<Record<string, Readonly<Record<string, ReviewedRecipe>>>>;
export const REVIEWED_RECIPES: ReviewedRecipeRegistry = {
 [MYELIN_REPOSITORY]: { "myelin-v1": { needsNats: true, checks: {
  unit: ["bun", "--config=/dev/null", "--no-env-file", "test", "./src", "./scripts", "./tools", "./tests/package-exports.smoke.test.ts"],
  integration: ["bun", "--config=/dev/null", "--no-env-file", "test", "./tests/integration"],
  typecheck: ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/typescript/bin/tsc", "--noEmit"],
  lint: ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/eslint/bin/eslint.js", "."],
 } } },
 [RANGER_REPOSITORY]: { "ranger-v1": { needsNats: false, checks: {
  unit: [...RANGER_BUN, "test", "--preload=./test/preload.ts", "--randomize", "--parallel=2", "--timeout=60000", ...RANGER_OPT_IN_TEST_FILES.flatMap(file => ["--path-ignore-patterns", file])] as [string, ...string[]],
  typecheck: [...RANGER_BUN, "./node_modules/typescript/bin/tsc", "--noEmit"],
  lint: [...RANGER_BUN, "./node_modules/eslint/bin/eslint.js", "."],
 } } },
};

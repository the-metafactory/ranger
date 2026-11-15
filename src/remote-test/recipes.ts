import type { ReviewedPolicy } from "./profiles.ts";

export const MYELIN_REPOSITORY = "github:github.com/the-metafactory/myelin";
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
};

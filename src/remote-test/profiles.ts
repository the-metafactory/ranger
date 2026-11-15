import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProfileManifest } from "./contract.ts";

/** Recipes are code-reviewed policy, not submitter-supplied commands or env. */
export const ReviewedPolicySchema = z.object({
 recipe: z.string().min(1).max(128),
 runtime: z.literal("bun-1.3.14").default("bun-1.3.14"),
 cache: z.literal("disabled"),
 install: z.literal("frozen-offline-copy"),
 checks: z.array(z.enum(["unit", "integration", "typecheck", "lint"])).min(1).max(4)
  .refine(a => new Set(a).size === a.length),
 sidecars: z.array(z.object({ kind: z.literal("nats"),
  imageReference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
 }).strict()).max(1),
}).strict();
export type ReviewedPolicy = z.infer<typeof ReviewedPolicySchema>;
export const MYELIN_REPOSITORY = "github:github.com/the-metafactory/myelin";
export const FROZEN_INSTALL = ["bun", "--config=/dev/null", "--no-env-file", "install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/tmp/ranger-install"] as [string, ...string[]];

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

export function reviewedRecipe(recipeId: string, registry: ReviewedRecipeRegistry = REVIEWED_RECIPES): { repositoryId: string; recipe: ReviewedRecipe } {
 const matches = Object.entries(registry).filter(([, recipes]) => Object.hasOwn(recipes, recipeId));
 if (matches.length !== 1) throw Error("Unknown or ambiguous reviewed recipe");
 const [repositoryId, recipes] = matches[0];
 return { repositoryId, recipe: recipes[recipeId] };
}

export function reviewedCommands(input: unknown, registry: ReviewedRecipeRegistry = REVIEWED_RECIPES): [string, ...string[]][] {
 const p = ReviewedPolicySchema.parse(input);
 const { recipe } = reviewedRecipe(p.recipe, registry);
 if (p.checks.length !== Object.keys(recipe.checks).length || p.checks.some(check => !Object.hasOwn(recipe.checks, check))) throw Error("Reviewed recipe checks mismatch");
 if (p.sidecars.length !== (recipe.needsNats ? 1 : 0)) throw Error("Reviewed recipe sidecars mismatch");
 return [[...FROZEN_INSTALL], ...p.checks.map(check => {
  const command = recipe.checks[check];
  if (!command) throw Error("Reviewed recipe check command missing");
  return [...command] as [string, ...string[]];
 })];
}

function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
 if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
 return JSON.stringify(value);
}
function manifestDigest(profile: Omit<ProfileManifest, "profileDigest">): string {
 return `sha256:${createHash("sha256").update(canonical(profile)).digest("hex")}`;
}
export function createReviewedProfile(input: { profileId: string; lockDigest: string; imageDigest: string; reviewed: unknown }, registry: ReviewedRecipeRegistry = REVIEWED_RECIPES): ProfileManifest & { reviewed: ReviewedPolicy } {
 const reviewed = ReviewedPolicySchema.parse(input.reviewed);
 const profile = { version: 1 as const, platform: "linux-arm64" as const, profileId: input.profileId,
  lockDigest: input.lockDigest, imageDigest: input.imageDigest, reviewed, commands: reviewedCommands(reviewed, registry) };
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profile.profileId) || ![profile.lockDigest, profile.imageDigest].every(s => /^sha256:[a-f0-9]{64}$/.test(s))) throw Error("Invalid reviewed profile identity");
 return { ...profile, profileDigest: manifestDigest(profile) };
}
export function validateReviewedManifest(profile: ProfileManifest, registry: ReviewedRecipeRegistry = REVIEWED_RECIPES): ProfileManifest {
 if (!profile.reviewed) return profile; // Previously approved V1 operator manifests remain readable.
 const expected = createReviewedProfile(profile as ProfileManifest & { reviewed: ReviewedPolicy }, registry);
 if (canonical(profile) !== canonical(expected)) throw Error("Reviewed profile content/digest mismatch");
 return profile;
}
export interface ContainerBudget { cpuCores: number; memoryBytes: number; pids: number }
export const REMOTE_TEST_LIMITS = { cpuCores: 2, memoryBytes: 1610612736, pids: 256, timeoutMs: 600_000 } as const;
export function profileBudgets(reviewed?: ReviewedPolicy): { test: ContainerBudget; nats?: ContainerBudget } {
 const nats = { cpuCores: 0.25, memoryBytes: 268435456, pids: 32 };
 return reviewed?.sidecars.length ? { test: { cpuCores: REMOTE_TEST_LIMITS.cpuCores - nats.cpuCores, memoryBytes: REMOTE_TEST_LIMITS.memoryBytes - nats.memoryBytes, pids: REMOTE_TEST_LIMITS.pids - nats.pids }, nats }
  : { test: { cpuCores: REMOTE_TEST_LIMITS.cpuCores, memoryBytes: REMOTE_TEST_LIMITS.memoryBytes, pids: REMOTE_TEST_LIMITS.pids } };
}

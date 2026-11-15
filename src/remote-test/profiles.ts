import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProfileManifest } from "./contract.ts";
import { MYELIN_REPOSITORY, REVIEWED_RECIPES, type ReviewedRecipe } from "./recipes.ts";
export { MYELIN_REPOSITORY } from "./recipes.ts";

/** Recipes are code-reviewed policy, not submitter-supplied commands or env. */
export const ReviewedPolicySchema = z.object({
 recipe: z.string().min(1).max(128),
 repositoryId: z.string().min(1).max(512).optional(),
 runtime: z.literal("bun-1.3.14").default("bun-1.3.14"),
 cache: z.literal("disabled"),
 install: z.literal("frozen-offline-copy"),
 checks: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).min(1).max(32)
  .refine(a => new Set(a).size === a.length),
 sidecars: z.array(z.object({ kind: z.literal("nats"),
  imageReference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
 }).strict()).max(1),
}).strict();
export type ReviewedPolicy = z.infer<typeof ReviewedPolicySchema>;
export const FROZEN_INSTALL = ["bun", "--config=/dev/null", "--no-env-file", "install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/tmp/ranger-install"] as [string, ...string[]];

export function reviewedRecipe(policy: Pick<ReviewedPolicy, "recipe" | "repositoryId">): { repositoryId: string; recipe: ReviewedRecipe } {
 const repositoryId = policy.repositoryId ?? MYELIN_REPOSITORY;
 if (!Object.hasOwn(REVIEWED_RECIPES, repositoryId) || !Object.hasOwn(REVIEWED_RECIPES[repositoryId], policy.recipe)) throw Error("Unknown reviewed recipe");
 return { repositoryId, recipe: REVIEWED_RECIPES[repositoryId][policy.recipe] };
}

export function reviewedCommands(input: unknown): [string, ...string[]][] {
 const p = ReviewedPolicySchema.parse(input);
 const { recipe } = reviewedRecipe(p);
 if (p.checks.length !== Object.keys(recipe.checks).length || p.checks.some(check => !Object.hasOwn(recipe.checks, check))) throw Error("Reviewed recipe checks mismatch");
 if (p.sidecars.length !== (recipe.needsNats ? 1 : 0)) throw Error("Reviewed recipe sidecars mismatch");
 return [[...FROZEN_INSTALL], ...p.checks.map(check => {
  return [...recipe.checks[check]] as [string, ...string[]];
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
export function createReviewedProfile(input: { profileId: string; lockDigest: string; imageDigest: string; reviewed: unknown }): ProfileManifest & { reviewed: ReviewedPolicy } {
 const reviewed = ReviewedPolicySchema.parse(input.reviewed);
 const profile = { version: 1 as const, platform: "linux-arm64" as const, profileId: input.profileId,
  lockDigest: input.lockDigest, imageDigest: input.imageDigest, reviewed, commands: reviewedCommands(reviewed) };
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profile.profileId) || ![profile.lockDigest, profile.imageDigest].every(s => /^sha256:[a-f0-9]{64}$/.test(s))) throw Error("Invalid reviewed profile identity");
 return { ...profile, profileDigest: manifestDigest(profile) };
}
export function validateReviewedManifest(profile: ProfileManifest): ProfileManifest {
 if (!profile.reviewed) return profile; // Previously approved V1 operator manifests remain readable.
 const expected = createReviewedProfile(profile as ProfileManifest & { reviewed: ReviewedPolicy });
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

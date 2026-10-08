import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProfileManifest } from "./contract.ts";

/** Recipes are code-reviewed policy, not submitter-supplied commands or env. */
export const ReviewedPolicySchema = z.object({
 recipe: z.literal("myelin-v1"),
 runtime: z.literal("bun-1.3.14").default("bun-1.3.14"),
 cache: z.literal("disabled"),
 install: z.literal("frozen-offline-copy"),
 checks: z.array(z.enum(["unit", "integration", "typecheck", "lint"])).length(4)
  .refine(a => new Set(a).size === 4),
 sidecars: z.tuple([z.object({ kind: z.literal("nats"),
  imageReference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
 }).strict()]),
}).strict();
export type ReviewedPolicy = z.infer<typeof ReviewedPolicySchema>;
export const MYELIN_REPOSITORY = "github:github.com/the-metafactory/myelin";
export const FROZEN_INSTALL = ["bun", "--config=/dev/null", "--no-env-file", "install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/tmp/ranger-install"] as [string, ...string[]];

export function reviewedCommands(input: unknown): [string, ...string[]][] {
 const p = ReviewedPolicySchema.parse(input);
 const recipes: Record<ReviewedPolicy["checks"][number], [string, ...string[]]> = {
  unit: ["bun", "--config=/dev/null", "--no-env-file", "test", "./src", "./scripts", "./tools", "./tests/package-exports.smoke.test.ts"],
  integration: ["bun", "--config=/dev/null", "--no-env-file", "test", "./tests/integration"],
  typecheck: ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/typescript/bin/tsc", "--noEmit"],
  lint: ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/eslint/bin/eslint.js", "."],
 };
 return [[...FROZEN_INSTALL], ...p.checks.map(check => [...recipes[check]] as [string, ...string[]])];
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
 return reviewed ? { test: { cpuCores: REMOTE_TEST_LIMITS.cpuCores - nats.cpuCores, memoryBytes: REMOTE_TEST_LIMITS.memoryBytes - nats.memoryBytes, pids: REMOTE_TEST_LIMITS.pids - nats.pids }, nats }
  : { test: { cpuCores: REMOTE_TEST_LIMITS.cpuCores, memoryBytes: REMOTE_TEST_LIMITS.memoryBytes, pids: REMOTE_TEST_LIMITS.pids } };
}

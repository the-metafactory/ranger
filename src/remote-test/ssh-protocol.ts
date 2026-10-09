import { z } from "zod";
import { Sha256Schema, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";

export const SSH_LIMITS = { bundleBytes: 64 * 1024 ** 2, responseBytes: 65_536, headerBytes: 65_536 } as const;
export const SshRequestSchema = z.discriminatedUnion("operation", [
 z.object({ version: z.union([z.literal(1), z.literal(2)]), operation: z.literal("submit"), job: z.unknown(), bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes) }).strict(),
 z.object({ version: z.union([z.literal(1), z.literal(2)]), operation: z.literal("status"), job: z.unknown() }).strict(),
 // Additive V3: stage-only source transfer. V1/V2 never carry it, and V3 carries nothing else.
 z.object({ version: z.literal(3), operation: z.literal("stage"), job: z.unknown(), bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes) }).strict(),
]);
export const SshResponseSchema = z.union([
 z.object({ version: z.literal(1), receipt: z.unknown().nullable() }).strict(),
 z.object({ version: z.literal(2), receipt: z.unknown().nullable(), state: z.enum(["active", "interrupted", "revoked", "busy"]).optional() }).strict()
  .refine(r => !r.state || (r.state === "revoked" ? r.receipt !== null : r.receipt === null)),
 z.object({ version: z.union([z.literal(1), z.literal(2)]), error: z.enum(["invalid_receipt", "receiver_failed"]) }).strict(),
]);
export type SshResponse = { version: 1 | 2; receipt: RemoteTestReceipt | null; state?: "active" | "interrupted" | "revoked" | "busy" } | { version: 1 | 2; error: "invalid_receipt" | "receiver_failed" };
/** Separate from SshResponseSchema: a stage reply is never a receipt or a test outcome. */
export const SshStageResponseSchema = z.union([
 z.object({ version: z.literal(3), staged: z.object({
  job: z.unknown(), executorId: z.string().max(128),
  bundleDigest: Sha256Schema, bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes),
 }).strict() }).strict(),
 z.object({ version: z.literal(3), error: z.literal("receiver_failed") }).strict(),
]);
export type SshStageResponse = { version: 3; staged: { job: RemoteTestJob; executorId: string; bundleDigest: string; bundleBytes: number } } | { version: 3; error: "receiver_failed" };

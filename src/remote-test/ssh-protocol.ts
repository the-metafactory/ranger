import { z } from "zod";
import { NameSchema, Sha256Schema, type RemoteTestJob, type RemoteTestReceipt } from "./contract.ts";

/** `timeoutSeconds` is the client SSH ceiling; the receiver sizes pending-upload expiry from it. */
export const SSH_LIMITS = { bundleBytes: 64 * 1024 ** 2, responseBytes: 65_536, headerBytes: 65_536, timeoutSeconds: 900,
 receiptPage: 256, receiptBytes: 16_384 } as const;
export const SshRequestSchema = z.discriminatedUnion("operation", [
 z.object({ version: z.union([z.literal(1), z.literal(2)]), operation: z.literal("submit"), job: z.unknown(), bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes) }).strict(),
 z.object({ version: z.union([z.literal(1), z.literal(2)]), operation: z.literal("status"), job: z.unknown() }).strict(),
 // Additive V3: V1/V2 never carry `stage`; V3 currently admits only `stage`. The
 // receiver keys reply shapes on the operation, so later V3 operations stay additive.
 z.object({ version: z.literal(3), operation: z.literal("stage"), job: z.unknown(), bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes) }).strict(),
 z.object({ version: z.literal(4), operation: z.literal("receipt-list"), after: NameSchema.optional() }).strict(),
 z.object({ version: z.literal(4), operation: z.literal("receipt-get"), jobId: NameSchema }).strict(),
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

export const OUTBOX_STATES = ["pending", "delivered", "withheld"] as const;
/** What the executor host recorded for one terminal receipt. The bytes are untrusted until the client hashes them against `evidence`. */
export const SshReceiptRecordSchema = z.object({
 jobId: NameSchema, job: z.unknown(), evidence: Sha256Schema, state: z.enum(OUTBOX_STATES),
 receiptBytes: z.string().max(SSH_LIMITS.receiptBytes).nullable(), authorized: z.boolean(),
}).strict();
export type SshReceiptRecord = z.infer<typeof SshReceiptRecordSchema>;
/** Separate from SshResponseSchema: a V4 reply lists or returns recorded evidence and is never a test outcome. */
export const SshReceiptResponseSchema = z.union([
 z.object({ version: z.literal(4), executorId: NameSchema, jobIds: z.array(NameSchema).max(SSH_LIMITS.receiptPage), more: z.boolean() }).strict(),
 z.object({ version: z.literal(4), executorId: NameSchema, receipt: SshReceiptRecordSchema.nullable() }).strict(),
 z.object({ version: z.literal(4), error: z.literal("receiver_failed") }).strict(),
]);
export type SshReceiptResponse = z.infer<typeof SshReceiptResponseSchema>;

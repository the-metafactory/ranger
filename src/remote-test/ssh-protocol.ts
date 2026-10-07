import { z } from "zod";
import type { RemoteTestReceipt } from "./contract.ts";

export const SSH_LIMITS = { bundleBytes: 64 * 1024 ** 2, responseBytes: 65_536, headerBytes: 65_536 } as const;
export const SshRequestSchema = z.discriminatedUnion("operation", [
 z.object({ version: z.literal(1), operation: z.literal("submit"), job: z.unknown(), bundleBytes: z.number().int().min(1).max(SSH_LIMITS.bundleBytes) }).strict(),
 z.object({ version: z.literal(1), operation: z.literal("status"), job: z.unknown() }).strict(),
]);
export const SshResponseSchema = z.union([
 z.object({ version: z.literal(1), receipt: z.unknown().nullable() }).strict(),
 z.object({ version: z.literal(1), error: z.enum(["invalid_receipt", "receiver_failed"]) }).strict(),
]);
export type SshResponse = { version: 1; receipt: RemoteTestReceipt | null } | { version: 1; error: "invalid_receipt" | "receiver_failed" };

import { z } from "zod";

/** V1 is deliberately limited to the first non-graphical Linux ARM64 lane. */
const PlatformSchema = z.literal("linux-arm64");
const VersionSchema = z.literal(1);
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// Full Git object IDs: SHA-1 or SHA-256, never an abbreviated revision.
const GitDigestSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const UuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const NameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const TimestampSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const GenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Located repository identity, without URLs, credentials, refs or path traversal.
const RepositoryIdSchema = z.string().max(512).regex(
 /^(?:github|gitlab):[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)+$/,
);

const ProfileBindingShape = {
 profileId: NameSchema,
 profileDigest: Sha256Schema,
 lockDigest: Sha256Schema,
 imageDigest: Sha256Schema,
 platform: PlatformSchema,
};

const IdentitySchema = z.object({
 version: VersionSchema,
 jobId: UuidSchema,
 correlationId: UuidSchema,
 repositoryId: RepositoryIdSchema,
 commitDigest: GitDigestSchema,
 treeDigest: GitDigestSchema,
 bundleDigest: Sha256Schema,
 ...ProfileBindingShape,
 /** Absolute Unix time in milliseconds. Admission checks expiry separately. */
 deadline: TimestampSchema,
 /** Must match the current admitted attempt/fencing generation supplied by the caller. */
 generation: GenerationSchema,
}).strict().refine((value) => value.commitDigest.length === value.treeDigest.length, {
 message: "Commit and tree must use the same Git object format",
});

const ArgumentSchema = z.string().max(4096).refine((value) => !value.includes("\0"), {
 message: "Command arguments cannot contain NUL",
});
const CommandSchema = z.tuple([ArgumentSchema.refine((value) => value.length > 0)]).rest(ArgumentSchema);
const ProfileManifestSchema = z.object({
 version: VersionSchema,
 ...ProfileBindingShape,
 /** Ordered argv vectors, never interpolated shell text supplied by a job. */
 commands: z.array(CommandSchema).min(1).max(32),
}).strict();

export const REMOTE_TEST_STATUSES = [
 "passed", "test_failed", "infra_failed", "timed_out", "cancelled", "rejected",
] as const;

export const ResourceObservationSchema = z.object({
 state: z.enum(["observed", "unavailable", "skipped"]),
 cpuTimeMicros: z.number().int().nonnegative().safe().nullable(),
 peakMemoryBytes: z.number().int().nonnegative().safe().nullable(),
}).strict().refine(r => r.state === "observed" ? r.cpuTimeMicros !== null && r.peakMemoryBytes !== null : r.cpuTimeMicros === null && r.peakMemoryBytes === null);
export type ResourceObservation = z.infer<typeof ResourceObservationSchema>;
const EvidenceSchema = z.object({
 startedAt: TimestampSchema,
 durationMs: z.number().int().nonnegative().safe(),
 resources: ResourceObservationSchema,
 output: z.object({
  state: z.enum(["captured", "unavailable", "skipped"]), truncated: z.boolean(),
  artifact: z.object({ path: z.literal("test.log"), bytes: z.number().int().nonnegative().safe(), checksum: Sha256Schema }).strict().nullable(),
 }).strict().refine(o => o.state === "captured" ? o.artifact !== null : o.artifact === null && !o.truncated),
}).strict();

const ReceiptSchema = z.object({
 version: VersionSchema,
 identity: IdentitySchema,
 executorId: NameSchema,
 status: z.enum(REMOTE_TEST_STATUSES),
 completedAt: TimestampSchema,
 /** Observed test process exit; null when no test exit was obtained.
  * Infra failure or cancellation can still occur after a test exits zero. */
 exitCode: z.number().int().min(0).max(255).nullable(),
 /** Older V1 producers remain readable; the durable executor always adds evidence. */
 evidence: EvidenceSchema.optional(),
}).strict().superRefine((value, ctx) => {
 if (value.evidence && value.evidence.startedAt + value.evidence.durationMs !== value.completedAt) {
  ctx.addIssue({ code: "custom", path: ["evidence"], message: "Receipt timing is inconsistent" });
 }
 if (value.status === "passed" && value.exitCode !== 0) {
  ctx.addIssue({ code: "custom", path: ["exitCode"], message: "Passed requires test exit zero" });
 }
 if (value.status === "test_failed" && (value.exitCode === null || value.exitCode === 0)) {
  ctx.addIssue({ code: "custom", path: ["exitCode"], message: "Test failure requires a nonzero test exit" });
 }
 if (value.status === "passed" && value.completedAt > value.identity.deadline) {
  ctx.addIssue({ code: "custom", path: ["completedAt"], message: "Passed cannot complete after the deadline" });
 }
});

export type RemoteTestJob = z.infer<typeof IdentitySchema>;
export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;
export type RemoteTestReceipt = z.infer<typeof ReceiptSchema>;
export type RemoteTestStatus = RemoteTestReceipt["status"];

/** Structural validation only. Approval, digest verification and provenance are
 * caller responsibilities: load this from an operator-owned allow-list, never
 * from the job or its submitter. A claimed digest does not authenticate content. */
export function validateProfileManifest(input: unknown): ProfileManifest {
 return ProfileManifestSchema.parse(input);
}

/** Pure admission shape check against an already selected trusted profile.
 * Returns a detached validated job; never executes commands or reads config.
 * Throws ZodError for malformed input, Error for profile mismatch. */
export function validateRemoteTestJob(input: unknown, operatorProfile: unknown): RemoteTestJob {
 const profile = validateProfileManifest(operatorProfile);
 const request = IdentitySchema.parse(input);
 const fields = Object.keys(ProfileBindingShape) as (keyof typeof ProfileBindingShape)[];
 for (const field of fields) {
  if (request[field] !== profile[field]) throw new Error(`Remote-test job does not match operator profile: ${field}`);
 }
 return request;
}

/** The fixed typed tuple is compared structurally. Object property order and
 * delimiter encodings cannot collapse two identities into one. This Record
 * forces a new identity field to be accounted for by the compiler. */
const IDENTITY_FIELDS = {
 version: true, jobId: true, correlationId: true, repositoryId: true,
 commitDigest: true, treeDigest: true, bundleDigest: true,
 profileId: true, profileDigest: true, lockDigest: true, imageDigest: true,
 platform: true, deadline: true, generation: true,
} satisfies Record<keyof RemoteTestJob, true>;

function sameIdentity(receipt: RemoteTestReceipt, request: RemoteTestJob): boolean {
 return (Object.keys(IDENTITY_FIELDS) as (keyof RemoteTestJob)[])
  .every((field) => receipt.identity[field] === request[field]);
}

/** False for malformed or mismatched inputs. True only establishes attribution;
 * it says nothing about success, transport authentication or current gate state. */
export function receiptMatchesJob(input: unknown, expectedJob: unknown): boolean {
 const receipt = ReceiptSchema.safeParse(input);
 const job = IdentitySchema.safeParse(expectedJob);
 return receipt.success && job.success && sameIdentity(receipt.data, job.data);
}

/** Validate a terminal receipt and bind it to the exact admitted request.
 * The caller must authenticate its producer and check current HEAD/generation
 * before using a passed receipt as gate evidence. Completion is never success.
 * Throws ZodError for malformed input, Error for identity mismatch. */
export function validateRemoteTestReceipt(input: unknown, expectedJob: unknown): RemoteTestReceipt {
 const receipt = ReceiptSchema.parse(input);
 const job = IdentitySchema.parse(expectedJob);
 if (!sameIdentity(receipt, job)) throw new Error("Remote-test receipt identity does not match request");
 return receipt;
}

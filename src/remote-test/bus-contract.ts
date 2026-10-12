import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { NameSchema, RemoteTestJobSchema, RepositoryIdSchema, Sha256Schema, type RemoteTestJob } from "./contract.ts";
import { SSH_LIMITS } from "./ssh-protocol.ts";

/** The encoded request is refused before decoding or parsing beyond this size.
 * Bundle bytes never travel on the bus; the existing receiver ceiling bounds them. */
export const BUS_LIMITS = { requestBytes: 128 * 1024, bundleBytes: SSH_LIMITS.bundleBytes } as const;

export type BusRefusalCode = "too_large" | "malformed" | "invalid" | "digest_mismatch" | "unauthorized" | "actor_mismatch";
/** Fixed refusal code and message; no request content is echoed. */
export class BusContractRefusal extends Error {
 constructor(readonly code: BusRefusalCode, message: string) { super(message); }
}

// NATS stream/durable/account/domain and subject tokens: no separators,
// wildcards (`*`, `>`), whitespace or path characters.
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const OperatorPathSchema = z.string().max(4096).refine(
 p => isAbsolute(p) && normalize(p) === p && !p.endsWith("/") && !p.includes("\0") && !/[\r\n]/.test(p),
 { message: "Expected a normalized absolute operator path" },
);
// Fixed locator: scheme, host and explicit port only. Credentials stay in the
// operator credentials file, never in a URL.
const ServerSchema = z.string().max(512).refine(value => {
 if (!/^(?:nats|tls):\/\/[^/?#@\s]+$/.test(value)) return false;
 try {
  const url = new URL(value);
  return url.hostname !== "" && url.port !== "" && value === `${url.protocol}//${url.host}`;
 } catch { return false; }
}, { message: "Expected nats://host:port or tls://host:port" });
// A concrete Myelin issuer identity; wildcard and pattern characters are not DID syntax.
const IssuerSchema = z.string().max(512).regex(/^did:[a-z0-9]+(?::[A-Za-z0-9._-]+)+$/);

const BindingSchema = z.object({
 repositoryId: RepositoryIdSchema,
 profileId: NameSchema,
 profileDigest: Sha256Schema,
}).strict();
const IssuerBindingsSchema = z.object({
 issuer: IssuerSchema,
 bindings: z.array(BindingSchema).min(1).max(64)
  .refine(b => new Set(b.map(e => `${e.repositoryId}\n${e.profileId}`)).size === b.length, { message: "Duplicate repository/profile binding" }),
}).strict();

const BusConfigSchema = z.object({
 version: z.literal(1),
 /** Explicit JetStream domain and account; never the default domain. */
 target: z.object({ domain: TokenSchema, account: TokenSchema }).strict(),
 /** Private routing only. Federated and public classifications are unsupported. */
 routing: z.object({ classification: z.literal("local"), principal: TokenSchema, stack: TokenSchema }).strict(),
 streams: z.object({
  request: z.object({ stream: TokenSchema, durable: TokenSchema }).strict(),
  result: z.object({ stream: TokenSchema }).strict(),
 }).strict().refine(s => s.request.stream !== s.result.stream, { message: "Request and result streams must be disjoint" }),
 transport: z.object({
  servers: z.array(ServerSchema).min(1).max(8).refine(s => new Set(s).size === s.length, { message: "Duplicate server" }),
  credentialsFile: OperatorPathSchema,
 }).strict(),
 /** The existing reviewed SSH JSON; source staging reuses that fixed boundary. */
 ssh: z.object({ configFile: OperatorPathSchema }).strict(),
 /** One job: one outstanding delivery and one handler. Progress precedes ack expiry. */
 execution: z.object({
  maxAckPending: z.literal(1),
  maxConcurrentJobs: z.literal(1),
  ackWaitSeconds: z.number().int().min(10).max(3600),
  progressIntervalSeconds: z.number().int().min(1),
  maxDeliver: z.number().int().min(1).max(10),
 }).strict().refine(e => e.progressIntervalSeconds < e.ackWaitSeconds, { message: "Progress must precede ack expiry" }),
 /** Private Myelin identity registry used to verify origin signatures. */
 registry: z.object({ file: OperatorPathSchema }).strict(),
 /** Operator-owned permissions: exact issuer to repository/profile-digest bindings. */
 issuers: z.array(IssuerBindingsSchema).min(1).max(32)
  .refine(i => new Set(i.map(e => e.issuer)).size === i.length, { message: "Duplicate issuer" }),
}).strict();

const BusRequestSchema = z.object({
 version: z.literal(1),
 job: RemoteTestJobSchema,
 /** A content digest and size, never a path, URL or command. */
 source: z.object({
  bundleDigest: Sha256Schema,
  bundleBytes: z.number().int().positive().safe().max(BUS_LIMITS.bundleBytes),
 }).strict(),
}).strict();

export type BusConfig = z.infer<typeof BusConfigSchema>;
export type BusRequest = z.infer<typeof BusRequestSchema>;
export type BusBinding = z.infer<typeof BindingSchema>;

/** Structural validation of private operator configuration. Every field is
 * required; nothing is inferred. Inert: no Ranger command loads it yet.
 * Throws ZodError for missing, wildcard or malformed entries. */
export function validateBusConfig(input: unknown): BusConfig { return BusConfigSchema.parse(input); }

/** Validate one encoded bus request. Size is checked before decoding, so an
 * oversized payload is never parsed. Returns a detached request whose job keeps
 * every V1 identity field and whose source digest equals the job's. */
export function validateBusRequest(bytes: Uint8Array): BusRequest {
 if (!(bytes instanceof Uint8Array)) throw new BusContractRefusal("malformed", "Bus request must be bytes");
 if (bytes.byteLength > BUS_LIMITS.requestBytes) throw new BusContractRefusal("too_large", "Bus request exceeds limit");
 let input: unknown;
 try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
 catch { throw new BusContractRefusal("malformed", "Malformed bus request"); }
 const parsed = BusRequestSchema.safeParse(input);
 if (!parsed.success) throw new BusContractRefusal("invalid", "Invalid bus request");
 if (parsed.data.source.bundleDigest !== parsed.data.job.bundleDigest) throw new BusContractRefusal("digest_mismatch", "Bus source does not match job bundle");
 return parsed.data;
}

/** Permission lookup for an already verified origin. The caller supplies the
 * issuer from Myelin signature verification; this performs no cryptography.
 * The actor (envelope originator) must be absent or the issuer itself: delegated
 * actors are unsupported. Permission comes only from the operator binding and is
 * never derived from job fields; the job must match one binding exactly. */
export function authorizeBusProducer(config: BusConfig, origin: { issuer: string; actor?: string }, job: RemoteTestJob): BusBinding {
 if (origin.actor !== undefined && origin.actor !== origin.issuer) throw new BusContractRefusal("actor_mismatch", "Actor must be the verified issuer");
 const binding = config.issuers.find(e => e.issuer === origin.issuer)?.bindings.find(b =>
  b.repositoryId === job.repositoryId && b.profileId === job.profileId && b.profileDigest === job.profileDigest);
 if (!binding) throw new BusContractRefusal("unauthorized", "Issuer is not bound to this repository/profile");
 return { ...binding };
}

import { MyelinDurablePublishError, startMyelinRuntime } from "@the-metafactory/cortex/bus";
import { createEnvelope, validateEnvelope, type MyelinEnvelope } from "@the-metafactory/myelin";
import { subjectFor, taskSubjectAndType } from "@the-metafactory/myelin/subjects";
import { z } from "zod";
import { publishReceiptFile } from "./artifacts.ts";
import { BUS_TEST_CAPABILITY } from "./bus-admission.ts";
import { authorizeBusProducer, BUS_LIMITS, validateBusConfig, validateBusRequest, type BusConfig } from "./bus-contract.ts";
import type { DurablePublisher } from "./bus-outbox.ts";
import { Sha256Schema, type RemoteTestJob } from "./contract.ts";
import { readPrivateJson, reserve, saveJob } from "./private-io.ts";
import { selectSshJob, stageCommittedSource, statusSshRemoteTest, validateSshConfig, type SshConfig, type SshOptions, type SshOutcome, type SshStageOutcome } from "./ssh-client.ts";

const SOURCE_FIELDS = ["commitDigest", "treeDigest", "bundleDigest"] as const;
const SIGNATURE_ALLOWANCE_BYTES = 4096;
const NOT_SENT_KINDS: ReadonlySet<string> = new Set(["disabled", "stopped", "no-signer", "sign-failed", "unroutable"]);

export type BusRefusalStage = "config" | "signer" | "request" | "unauthorized" | "binding" | "expired" | "envelope" | "record";
/** Fixed refusal raised before anything reaches the bus. No input is echoed. */
export class BusProducerRefusal extends Error {
 constructor(readonly stage: BusRefusalStage, message: string) { super(message); }
}

const SignerFileSchema = z.object({
 version: z.literal(1),
 issuer: z.string().min(1).max(512),
 seed: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
}).strict();
const SourceSchema = z.object({ bundleDigest: Sha256Schema, bundleBytes: z.number().int().positive().safe().max(BUS_LIMITS.bundleBytes) }).strict();
const RecordSchema = z.object({
 version: z.literal(1),
 issuer: z.string().min(1).max(512),
 subject: z.string().min(1).max(512),
 executorId: z.string().min(1).max(128),
 stream: z.string().min(1).max(64),
 domain: z.string().min(1).max(64),
 job: z.unknown(),
 source: SourceSchema,
 envelope: z.unknown(),
}).strict();

export interface BusSigner { readonly issuer: string; readonly seed: Uint8Array }
/** The saved request identity. It carries no submission result: a success
 * marker is never persisted, so loading it can only replay the same request. */
export type BusRequestRecord = Omit<z.infer<typeof RecordSchema>, "job" | "envelope"> & { job: RemoteTestJob; envelope: MyelinEnvelope };

export interface BusPublisher extends DurablePublisher { close?(): Promise<void> }
export type BusPublisherFactory = (input: { bus: BusConfig; signer: BusSigner }) => Promise<BusPublisher>;
export type BusStageFunction = (
 input: { config: unknown; request: Record<string, unknown>; worktree: string; stagingRoot: string; expectedCommit?: string },
 options: Omit<SshOptions, "receiptStore">,
) => Promise<SshStageOutcome>;
export interface BusProducerInjected {
 stage?: BusStageFunction;
 publisher?: BusPublisherFactory;
 ssh?: Omit<SshOptions, "receiptStore">;
 now?: () => number;
 publishTimeoutMs?: number;
}

export type BusPublishOutcome =
 | { status: "submitted"; eventId: string; stream: string; seq: number; duplicate: boolean }
 | { status: "refused"; eventId: string; reason: "expired_request" | "publisher_unavailable" | "disabled" | "stopped" | "no-signer" | "sign-failed" | "unroutable" }
 | { status: "uncertain"; eventId: string; reason: "timeout" | "jetstream-error" | "stream-mismatch" | "domain-mismatch" | "ack_mismatch" | "publish_failed" };
export type BusRunOutcome = BusPublishOutcome | { status: "not_staged"; reason: "expired_job" | "receiver_failed" | "no_response" | "invalid_response" };

/** Real SDK publisher: the Cortex runtime connects with the operator credentials
 * file to the first reachable configured server (the SDK link takes one URL),
 * signs each envelope with the configured issuer key (never unsigned, never a
 * fallback) and acknowledges only from the configured stream and domain. */
export const connectBusPublisher = (start: typeof startMyelinRuntime): BusPublisherFactory => async ({ bus, signer }) => {
 let failure: unknown;
 for (const url of bus.transport.servers) {
  const config = { agent: { name: "ranger", displayName: "Ranger" },
   nats: { url, name: "ranger", subjects: [], credsPath: bus.transport.credentialsFile } } as unknown as Parameters<typeof startMyelinRuntime>[0];
  try {
   const runtime = await start(config, {
    jetstreamDomain: bus.target.domain, signer: { principal: signer.issuer, rawSeedBytes: signer.seed },
    signFailureMode: "drop", stack: bus.routing.stack, principal: bus.routing.principal,
   });
   const publishDurable = runtime.publishDurable?.bind(runtime);
   if (!runtime.enabled || !publishDurable) { await runtime.stop(); throw Error("Bus runtime cannot publish durably"); }
   return { publishDurable, close: () => runtime.stop() };
  } catch (error) { failure = error; }
 }
 throw failure instanceof Error ? failure : Error("No bus server configured");
};
export const startBusPublisher = connectBusPublisher(startMyelinRuntime);

const clock = (injected: BusProducerInjected) => injected.now ?? Date.now;
const jsonEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function loadConfigs(path: string): Promise<{ bus: BusConfig; ssh: SshConfig }> {
 try {
  const bus = validateBusConfig(await readPrivateJson(path));
  return { bus, ssh: validateSshConfig(await readPrivateJson(bus.ssh.configFile)) };
 } catch { throw new BusProducerRefusal("config", "Bus or SSH configuration is missing, unsafe or invalid"); }
}

async function loadSigner(path: string, bus: BusConfig): Promise<BusSigner> {
 let parsed: z.infer<typeof SignerFileSchema>;
 try { parsed = SignerFileSchema.parse(await readPrivateJson(path)); }
 catch { throw new BusProducerRefusal("signer", "Signer file is missing, unsafe or invalid"); }
 if (!bus.issuers.some(entry => entry.issuer === parsed.issuer)) throw new BusProducerRefusal("unauthorized", "Signer is not a configured issuer");
 return { issuer: parsed.issuer, seed: Buffer.from(parsed.seed, "base64") };
}

function authorize(bus: BusConfig, issuer: string, actor: string | undefined, job: RemoteTestJob) {
 try { authorizeBusProducer(bus, { issuer, ...(actor !== undefined && { actor }) }, job); }
 catch { throw new BusProducerRefusal("unauthorized", "Issuer is not bound to this repository/profile as itself"); }
}

function requestEnvelope(bus: BusConfig, issuer: string, job: RemoteTestJob, source: { bundleDigest: string; bundleBytes: number }): { envelope: MyelinEnvelope; subject: string } {
 const route = taskSubjectAndType(bus.routing.principal, BUS_TEST_CAPABILITY, bus.routing.stack);
 const subject = subjectFor({ classification: "local", principal: bus.routing.principal, stack: bus.routing.stack, type: route.type });
 if (subject !== route.subject) throw new BusProducerRefusal("envelope", "Request subject does not match the configured route");
 authorize(bus, issuer, issuer, job);
 const envelope = createEnvelope({
  source: `${bus.routing.principal}.${bus.routing.stack}.ranger`, type: route.type,
  sovereignty: { classification: bus.routing.classification, data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "local-only" },
  correlation_id: job.correlationId, deadline: new Date(job.deadline).toISOString(), distribution_mode: "offer",
  originator: { identity: issuer, attribution: "adapter-resolved" },
  payload: { version: 1, job, source },
 });
 try {
  validateBusRequest(Buffer.from(JSON.stringify(envelope.payload)));
  if (!validateEnvelope(envelope).valid) throw Error("invalid");
 } catch { throw new BusProducerRefusal("envelope", "Request envelope is invalid"); }
 if (Buffer.byteLength(JSON.stringify(envelope)) + SIGNATURE_ALLOWANCE_BYTES > BUS_LIMITS.requestBytes) throw new BusProducerRefusal("envelope", "Request envelope is too large");
 return { envelope, subject };
}

const withoutIdentity = (envelope: MyelinEnvelope) => { const { id: _id, timestamp: _timestamp, ...rest } = envelope; return rest; };

function checkRecord(bus: BusConfig, ssh: SshConfig, input: unknown): BusRequestRecord {
 try {
  const record = RecordSchema.parse(input), job = selectSshJob(ssh, record.job);
  const { envelope, subject } = requestEnvelope(bus, record.issuer, job, record.source);
  const saved = record.envelope as MyelinEnvelope;
  if (!validateEnvelope(saved).valid || saved.signed_by !== undefined || !jsonEqual(withoutIdentity(saved), withoutIdentity(envelope)) ||
   record.subject !== subject || record.executorId !== ssh.executorId || record.stream !== bus.streams.request.stream ||
   record.domain !== bus.target.domain || record.source.bundleDigest !== job.bundleDigest) throw Error("mismatch");
  return { ...record, job, envelope: saved };
 } catch (e) {
  if (e instanceof BusProducerRefusal && e.stage === "unauthorized") throw e;
  throw new BusProducerRefusal("record", "Saved bus request does not match the current configuration");
 }
}

function assertStaged(ssh: SshConfig, request: Record<string, unknown>, staged: Extract<SshStageOutcome, { status: "staged" }>, expectedCommit: string | undefined): RemoteTestJob {
 try {
  const job = selectSshJob(ssh, staged.job);
  for (const [key, value] of Object.entries(request)) if (!jsonEqual((job as Record<string, unknown>)[key], value)) throw Error("request");
  if (staged.executorId !== ssh.executorId || staged.source.bundleDigest !== job.bundleDigest) throw Error("source");
  if (expectedCommit !== undefined && job.commitDigest !== expectedCommit) throw Error("commit");
  SourceSchema.parse(staged.source);
  return job;
 } catch { throw new BusProducerRefusal("binding", "Staged source does not bind this exact request"); }
}

async function publishRecord(record: BusRequestRecord, bus: BusConfig, signer: BusSigner, injected: BusProducerInjected): Promise<BusPublishOutcome> {
 const eventId = record.envelope.id;
 if (clock(injected)() >= record.job.deadline) return { status: "refused", eventId, reason: "expired_request" };
 let publisher: BusPublisher;
 try { publisher = await (injected.publisher ?? startBusPublisher)({ bus, signer }); }
 catch { return { status: "refused", eventId, reason: "publisher_unavailable" }; }
 try {
  const ack = await publisher.publishDurable(record.envelope, {
   expectedStream: bus.streams.request.stream, ...(injected.publishTimeoutMs !== undefined && { timeoutMs: injected.publishTimeoutMs }),
  });
  if (ack.stream !== bus.streams.request.stream || ack.domain !== bus.target.domain || !Number.isSafeInteger(ack.seq) || ack.seq <= 0) {
   return { status: "uncertain", eventId, reason: "ack_mismatch" };
  }
  return { status: "submitted", eventId, stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate };
 } catch (e) {
  if (!(e instanceof MyelinDurablePublishError)) return { status: "uncertain", eventId, reason: "publish_failed" };
  if (NOT_SENT_KINDS.has(e.kind)) return { status: "refused", eventId, reason: e.kind as Extract<BusPublishOutcome, { status: "refused" }>["reason"] };
  return { status: "uncertain", eventId, reason: e.kind as Extract<BusPublishOutcome, { status: "uncertain" }>["reason"] };
 } finally { await publisher.close?.().catch(() => undefined); }
}

export interface RunBusCommand { config: string; request: string; worktree: string; stagingRoot: string; requestOutput: string; signer: string; expectedCommit?: string }

/** Opt-in bus submission. Stages the clean committed HEAD over the stage-only SSH
 * operation, requires the exact job/executor/source answer, then saves the job
 * and the unsigned stable request envelope in one atomic private file before
 * the single durable publish. Nothing runs locally and nothing is resubmitted:
 * a published request is only "submitted", never a test result. */
export async function runBusCommand(options: RunBusCommand, injected: BusProducerInjected = {}): Promise<BusRunOutcome> {
 const { bus, ssh } = await loadConfigs(options.config);
 const signer = await loadSigner(options.signer, bus);
 const request = await readPrivateJson(options.request) as Record<string, unknown>;
 if (SOURCE_FIELDS.some(field => Object.hasOwn(request, field))) throw new BusProducerRefusal("request", "Source bindings must be derived from staging");
 let draft: RemoteTestJob;
 try { draft = selectSshJob(ssh, { ...request, commitDigest: "0".repeat(40), treeDigest: "0".repeat(40), bundleDigest: `sha256:${"0".repeat(64)}` }); }
 catch { throw new BusProducerRefusal("request", "Request is not an approved remote-test request"); }
 authorize(bus, signer.issuer, signer.issuer, draft);
 if (clock(injected)() >= draft.deadline) throw new BusProducerRefusal("expired", "Request deadline has passed");
 const output = await reserve(options.requestOutput);
 try {
  const staged = await (injected.stage ?? stageCommittedSource)({
   config: ssh, request, worktree: options.worktree, stagingRoot: options.stagingRoot, ...(options.expectedCommit && { expectedCommit: options.expectedCommit }),
  }, { ...injected.ssh, now: clock(injected) });
  if (staged.status === "refused") return { status: "not_staged", reason: staged.reason };
  if (staged.status === "uncertain") return { status: "not_staged", reason: staged.reason };
  const job = assertStaged(ssh, request, staged, options.expectedCommit);
  if (clock(injected)() >= job.deadline) throw new BusProducerRefusal("expired", "Request deadline has passed");
  const { envelope, subject } = requestEnvelope(bus, signer.issuer, job, staged.source);
  const record = { version: 1 as const, issuer: signer.issuer, subject, executorId: ssh.executorId, stream: bus.streams.request.stream, domain: bus.target.domain, job, source: staged.source, envelope };
  await saveJob(output.destination, record);
  return await publishRecord(record, bus, signer, injected);
 } finally { await output.release(); }
}

/** Explicit retry of one saved request: the same job, envelope, source reference
 * and message ID are republished. Never restages, never snapshots a new HEAD,
 * never refreshes an expired request. */
export async function retryBusCommand(options: { config: string; request: string; signer: string }, injected: BusProducerInjected = {}): Promise<BusPublishOutcome> {
 const { bus, ssh } = await loadConfigs(options.config);
 const signer = await loadSigner(options.signer, bus);
 let raw: unknown;
 try { raw = await readPrivateJson(options.request); } catch { throw new BusProducerRefusal("record", "Saved bus request is missing or unsafe"); }
 const record = checkRecord(bus, ssh, raw);
 if (record.issuer !== signer.issuer) throw new BusProducerRefusal("signer", "Signer is not the issuer of the saved request");
 return publishRecord(record, bus, signer, injected);
}

/** Receipt-only lookup over the existing SSH status path with the saved exact
 * job. It stages nothing, publishes nothing and executes nothing. */
export async function statusBusCommand(options: { config: string; request: string; output: string }, injected: BusProducerInjected = {}): Promise<SshOutcome> {
 const { bus, ssh } = await loadConfigs(options.config);
 let raw: unknown;
 try { raw = await readPrivateJson(options.request); } catch { throw new BusProducerRefusal("record", "Saved bus request is missing or unsafe"); }
 const record = checkRecord(bus, ssh, raw);
 const output = await reserve(options.output);
 try { return await statusSshRemoteTest({ config: ssh, job: record.job }, { ...injected.ssh, now: clock(injected), receiptStore: r => publishReceiptFile(output.destination, r) }); }
 finally { await output.release(); }
}

export function busOutcomeExitCode(result: BusRunOutcome): number { return result.status === "submitted" ? 0 : 1; }
export function busOutcomeMessage(result: BusRunOutcome): string {
 const saved = " The saved request keeps its identity.";
 switch (result.status) {
  case "submitted": return `Remote-test request ${result.eventId} submitted to the bus (not a test result). Retrieve the receipt with bus-status; do not run local fallback.\n`;
  case "not_staged": return `Remote-test source not staged (${result.reason}); nothing was submitted and nothing ran locally. Run again once the cause is fixed.\n`;
  case "refused": return `Remote-test request ${result.eventId} was not sent (${result.reason}); no submission, no local fallback.${saved} An explicit bus-retry republishes the same request.\n`;
  case "uncertain": return `Remote-test request ${result.eventId} publication is uncertain (${result.reason}); it may or may not be stored.${saved} Check bus-status, then bus-retry republishes the same message ID. No automatic resubmission.\n`;
 }
}

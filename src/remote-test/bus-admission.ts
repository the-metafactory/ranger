import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { admitOfferedDispatch, type Offering } from "@the-metafactory/cortex/bus";
import { validateEnvelope, type MyelinEnvelope } from "@the-metafactory/myelin";
import { taskSubjectAndType } from "@the-metafactory/myelin/subjects";
import { getSignedByChain, loadRegistry, verifyEnvelopeIdentity } from "@the-metafactory/myelin/identity";
import { authorizeBusProducer, BUS_LIMITS, validateBusConfig, validateBusRequest, type BusConfig, type BusRequest } from "./bus-contract.ts";
import { sha256Reference, validateRemoteTestJob, type ProfileManifest } from "./contract.ts";

export const BUS_TEST_CAPABILITY = "ci-test";

type AdmissionStage = "config" | "envelope" | "alignment" | "request" | "authentication" | "authorization" | "profile" | "policy" | "expiry";
type AdmissionCode = "too_large" | "malformed" | "invalid" | "mismatch" | "unverified" | "denied" | "expired";
export interface BusAdmissionSummary { readonly stage: AdmissionStage; readonly code: AdmissionCode }

export class BusAdmissionRefusal extends Error {
 constructor(readonly stage: AdmissionStage, readonly code: AdmissionCode) { super(`Bus admission refused: ${stage}/${code}`); }
}

export interface BusAdmissionContext {
 readonly config: BusConfig;
 readonly profiles: readonly ProfileManifest[];
 readonly offerings: readonly Offering[] | undefined;
 readonly summary?: (summary: BusAdmissionSummary) => void;
}

export interface AdmittedBusRequest {
 readonly request: Readonly<{ version: 1; job: Readonly<BusRequest["job"]>; source: Readonly<BusRequest["source"]> }>;
 readonly provenance: Readonly<{
  issuer: string;
  actor: string;
  envelopeId: string;
  envelopeDigest: string;
  subject: string;
  source: string;
  authenticatedAt: number;
  chain: readonly Readonly<{ identity: string; method: "ed25519" | "hub-stamp"; at: string }>[];
 }>;
}

const registries = new WeakMap<BusAdmissionContext, { file: string; revision: string; registry: ReturnType<typeof loadRegistry> }>();

async function configuredRegistry(context: BusAdmissionContext, file: string) {
 try {
  const metadata = await stat(file, { bigint: true });
  const revision = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");
  const cached = registries.get(context);
  if (cached?.file === file && cached.revision === revision) return cached.registry;
  const registry = loadRegistry(file);
  registries.set(context, { file, revision, registry });
  return registry;
 } catch (error) {
  registries.delete(context);
  throw error;
 }
}

function assertAligned(envelope: MyelinEnvelope, subject: string, config: BusConfig): void {
 const expected = taskSubjectAndType(config.routing.principal, BUS_TEST_CAPABILITY, config.routing.stack);
 const alignment = {
  subject: subject === expected.subject,
  type: envelope.type === expected.type,
  classification: envelope.sovereignty.classification === "local",
  source: envelope.source.startsWith(`${config.routing.principal}.${config.routing.stack}.`),
  distribution: envelope.distribution_mode === undefined || envelope.distribution_mode === "offer",
  target: envelope.target_assistant === undefined,
  attribution: envelope.originator === undefined || envelope.originator.attribution === "adapter-resolved",
 };
 if (!Object.values(alignment).every(Boolean)) throw new BusAdmissionRefusal("alignment", "mismatch");
}

function parseEnvelope(bytes: Uint8Array): MyelinEnvelope {
 if (!(bytes instanceof Uint8Array)) throw new BusAdmissionRefusal("envelope", "malformed");
 if (bytes.byteLength > BUS_LIMITS.requestBytes) throw new BusAdmissionRefusal("envelope", "too_large");
 const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
 if (value && typeof value === "object" && "spec_version" in value && typeof value.spec_version === "number" && value.spec_version > 3) {
  throw new BusAdmissionRefusal("envelope", "invalid");
 }
 if (!validateEnvelope(value).valid) throw new BusAdmissionRefusal("envelope", "invalid");
 return value as MyelinEnvelope;
}

async function admit(input: { bytes: Uint8Array; subject: string }, context: BusAdmissionContext): Promise<AdmittedBusRequest> {
 let stage: AdmissionStage = "config";
 try {
  const config = validateBusConfig(context.config);
  const profiles = structuredClone(context.profiles);
  const offerings = structuredClone(context.offerings);
  stage = "envelope";
  const envelope = parseEnvelope(input.bytes);
  const envelopeDigest = sha256Reference(createHash("sha256").update(input.bytes));
  const subject = input.subject;
  stage = "alignment";
  assertAligned(envelope, subject, config);
  stage = "request";
  const request = validateBusRequest(Buffer.from(JSON.stringify(envelope.payload)));
  if (envelope.correlation_id !== request.job.correlationId ||
   (envelope.deadline !== undefined && Date.parse(envelope.deadline) !== request.job.deadline)) {
   throw new BusAdmissionRefusal(stage, "mismatch");
  }
  stage = "authentication";
  const verified = await verifyEnvelopeIdentity(envelope, await configuredRegistry(context, config.registry.file));
  if (verified.status !== "verified") throw new BusAdmissionRefusal(stage, "unverified");
  const origin = verified.chain[0]?.principal;
  const chain = getSignedByChain(envelope);
  if (!origin || chain[0]?.method !== "ed25519") throw new BusAdmissionRefusal(stage, "unverified");
  const issuer = origin.id;
  stage = "authorization";
  authorizeBusProducer(config, { issuer, actor: envelope.originator?.identity }, request.job);
  stage = "profile";
  const profile = profiles.find(p => p.profileId === request.job.profileId && p.profileDigest === request.job.profileDigest);
  if (!profile) throw new BusAdmissionRefusal(stage, "denied");
  validateRemoteTestJob(request.job, profile);
  stage = "policy";
  const decision = admitOfferedDispatch({
   capability: BUS_TEST_CAPABILITY, offerings, arrivedScope: "local", signing: "enforce",
   ctx: { signed: true, peerPrincipal: issuer, peerInNetwork: false, surfaceVerified: false,
    surfacePredicatePassed: false, complianceOk: false, rateOk: false },
  });
  if (!decision.admit) throw new BusAdmissionRefusal(stage, "denied");
  stage = "expiry";
  const authenticatedAt = Date.now();
  if (request.job.deadline <= authenticatedAt) throw new BusAdmissionRefusal(stage, "expired");
  return Object.freeze({
   request: Object.freeze({ version: request.version, job: Object.freeze(request.job), source: Object.freeze(request.source) }),
   provenance: Object.freeze({
    issuer, actor: envelope.originator?.identity ?? issuer, envelopeId: envelope.id, envelopeDigest,
    subject, source: envelope.source, authenticatedAt,
    chain: Object.freeze(chain.map(s => Object.freeze({ identity: s.identity, method: s.method, at: s.at }))),
   }),
  });
 } catch (error) {
  if (error instanceof BusAdmissionRefusal) throw error;
  throw new BusAdmissionRefusal(stage, stage === "authentication" ? "unverified" : "invalid");
 }
}

function summarizeRefusal(context: BusAdmissionContext, refusal: BusAdmissionRefusal): void {
 try { context.summary?.(Object.freeze({ stage: refusal.stage, code: refusal.code })); }
 catch { return; }
}

export async function admitBusRequest(input: { bytes: Uint8Array; subject: string }, context: BusAdmissionContext): Promise<AdmittedBusRequest> {
 try { return await admit(input, context); }
 catch (error) {
  const refusal = error instanceof BusAdmissionRefusal ? error : new BusAdmissionRefusal("envelope", "invalid");
  summarizeRefusal(context, refusal);
  throw refusal;
 }
}

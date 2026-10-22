import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitOfferedDispatch } from "@the-metafactory/cortex/bus";
import { createEnvelope, type MyelinEnvelope } from "@the-metafactory/myelin";
import { canonicalizeForChainStamp, loadRegistry, signEnvelope, verifyEnvelopeIdentity, type Identity } from "@the-metafactory/myelin/identity";
import { taskSubjectAndType } from "@the-metafactory/myelin/subjects";
import { admitBusRequest, BUS_TEST_CAPABILITY, BusAdmissionRefusal, type BusAdmissionContext, type BusAdmissionSummary } from "../src/remote-test/bus-admission.ts";
import { BUS_LIMITS, validateBusConfig, type BusRequest } from "../src/remote-test/bus-contract.ts";
import type { ProfileManifest } from "../src/remote-test/contract.ts";

const issuer = "did:mf:example-ranger";
const relay = "did:mf:example-relay";
const other = "did:mf:other-ranger";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const profile = (): ProfileManifest => ({ version: 1, profileId: "bun-unit-v1", profileDigest: digest("a"),
 lockDigest: digest("b"), imageDigest: digest("c"), platform: "linux-arm64", commands: [["bun", "test"]] });
const request = (): BusRequest => ({ version: 1, job: { version: 1, jobId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
 repositoryId: "github:github.com/example/repo", commitDigest: "d".repeat(40), treeDigest: "e".repeat(40), bundleDigest: digest("f"),
 profileId: profile().profileId, profileDigest: profile().profileDigest, lockDigest: profile().lockDigest,
 imageDigest: profile().imageDigest, platform: profile().platform, generation: 3, deadline: Date.now() + 60_000 },
 source: { bundleDigest: digest("f"), bundleBytes: 4096 } });
const route = taskSubjectAndType("example", BUS_TEST_CAPABILITY, "private");
const unsigned = (r = request()): MyelinEnvelope => createEnvelope({ source: "example.private.ranger", type: route.type,
 sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "local-only" },
 correlation_id: r.job.correlationId, deadline: new Date(r.job.deadline).toISOString(), distribution_mode: "offer", payload: r });

function key(did: string) {
 const { privateKey, publicKey } = generateKeyPairSync("ed25519");
 const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
 const identity: Identity = { id: did, network: "example", public_key: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  type: "service", created_at: new Date().toISOString() };
 return { privateKey, seed, identity };
}

describe("signed private ci-test admission", () => {
 let root: string;
 let keys: Record<string, ReturnType<typeof key>>;
 let context: BusAdmissionContext;
 let summaries: BusAdmissionSummary[];
 beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ranger-admission-"));
  keys = Object.fromEntries([issuer, relay, other].map(did => [did, key(did)]));
  writeFileSync(join(root, "registry.json"), JSON.stringify({ version: 2, identities: Object.values(keys).map(k => k.identity), trusted_hubs: [] }), { mode: 0o600 });
  const r = request();
  context = { config: validateBusConfig({ version: 1, target: { domain: "private-domain", account: "private-account" },
   routing: { classification: "local", principal: "example", stack: "private" },
   streams: { request: { stream: "CI_REQUESTS", durable: "CI_EXECUTOR" }, result: { stream: "CI_RESULTS" } },
   transport: { servers: ["tls://bus.example.invalid:4222"], credentialsFile: join(root, "private.creds") },
   ssh: { configFile: join(root, "ssh.json") }, registry: { file: join(root, "registry.json") },
   execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 60, progressIntervalSeconds: 10, maxDeliver: 3 },
   issuers: [{ issuer, bindings: [{ repositoryId: r.job.repositoryId, profileId: r.job.profileId, profileDigest: r.job.profileDigest }] }],
  }), profiles: [profile()], offerings: [{ capability: BUS_TEST_CAPABILITY, scopes: ["local"] }], summary: s => { summaries.push(s); } };
  summaries = [];
 });
 afterEach(() => { rmSync(root, { recursive: true, force: true }); });

 const signed = (e = unsigned(), did = issuer) => signEnvelope(e, keys[did].seed, did, { role: "origin" });
 const restampOrigin = (e: MyelinEnvelope, offsetMs: number) => {
  e.signed_by![0].at = new Date(Date.now() + offsetMs).toISOString();
  e.signed_by![0].signature = sign(null, canonicalizeForChainStamp(e, 0), keys[issuer].privateKey).toString("base64");
  return e;
 };
 const admit = (e: unknown, subject = route.subject) => admitBusRequest({ bytes: encode(e), subject }, context);
 async function refused(e: unknown, stage: BusAdmissionSummary["stage"], code: BusAdmissionSummary["code"], subject = route.subject) {
  const before = readdirSync(root);
  const registry = readFileSync(join(root, "registry.json"));
  let failure: unknown;
  try { await admit(e, subject); } catch (err) { failure = err; }
  expect(failure).toBeInstanceOf(BusAdmissionRefusal);
  expect(failure).toMatchObject({ stage, code, message: `Bus admission refused: ${stage}/${code}` });
  expect(summaries).toEqual([{ stage, code }]);
  expect(readdirSync(root)).toEqual(before);
  expect(readFileSync(join(root, "registry.json"))).toEqual(registry);
 }

 test("returns the exact request and immutable authenticated provenance from the real public SDK and registry", async () => {
  const r = request(), e = await signed(unsigned(r));
  const expected = structuredClone(r);
  const accepted = await admit(e);
  expect(accepted.request).toEqual(expected);
  expect(accepted.provenance).toMatchObject({ issuer, actor: issuer, envelopeId: e.id, subject: route.subject, source: e.source,
   envelopeDigest: `sha256:${createHash("sha256").update(encode(e)).digest("hex")}`,
   chain: [{ identity: issuer, method: "ed25519", at: e.signed_by![0].at }] });
  expect(accepted.provenance.authenticatedAt).toBeLessThanOrEqual(Date.now());
  for (const value of [accepted, accepted.request, accepted.request.job, accepted.request.source, accepted.provenance, accepted.provenance.chain, accepted.provenance.chain[0]]) expect(Object.isFrozen(value)).toBe(true);
  expect(() => { (accepted.request.job as any).generation = 99; }).toThrow();
  e.payload.job = {};
  context.config.issuers[0].issuer = other;
  expect(accepted.request).toEqual(expected);
  expect(accepted.provenance.issuer).toBe(issuer);
  expect(summaries).toEqual([]);
  expect(readdirSync(root)).toEqual(["registry.json"]);
 });

 test("accepts absent mode/deadline and a self originator, without requiring a delegation", async () => {
  const e = unsigned(); delete e.distribution_mode; delete e.deadline;
  e.originator = { identity: issuer, attribution: "adapter-resolved" };
  expect((await admit(await signed(e))).provenance.actor).toBe(issuer);
 });

 test("authenticates the whole chain but authorizes the origin rather than last-stamp convenience principal", async () => {
  const e = await signEnvelope(await signed(), keys[relay].seed, relay, { role: "transit" });
  const verification = await verifyEnvelopeIdentity(e, loadRegistry(context.config.registry.file));
  expect(verification.status === "verified" && verification.principal.id).toBe(relay);
  expect((await admit(e)).provenance).toMatchObject({ issuer, chain: [{ identity: issuer }, { identity: relay }] });
 });

 test("an authorized last stamp cannot launder an unconfigured origin", async () => {
  const e = await signEnvelope(await signed(unsigned(), other), keys[issuer].seed, issuer);
  await refused(e, "authorization", "invalid");
 });

 test("local SDK admission alone never authenticates an unsigned envelope", async () => {
  expect(admitOfferedDispatch({ capability: BUS_TEST_CAPABILITY, offerings: context.offerings, arrivedScope: "local", signing: "enforce",
   ctx: { signed: false, peerInNetwork: false, surfaceVerified: false, surfacePredicatePassed: false, complianceOk: false, rateOk: false } })).toEqual({ admit: true });
  await refused(unsigned(), "authentication", "unverified");
 });

 test("uses configured offerings with the accepted evaluator instead of treating local as permission", async () => {
  context = { ...context, offerings: [{ capability: BUS_TEST_CAPABILITY, scopes: ["federated"], accept: { kind: "principals", principals: [issuer] } }] };
  await refused(await signed(), "policy", "denied");
 });

 test("unrelated offerings retain the SDK local default", async () => {
  context = { ...context, offerings: [{ capability: "other", scopes: ["federated"], accept: { kind: "principals", principals: [issuer] } }] };
  expect((await admit(await signed())).provenance.issuer).toBe(issuer);
 });

 const envelopeFaults: [string, (e: any) => void, BusAdmissionSummary["stage"]][] = [
  ["wrong type", e => { e.type = "tasks.other"; }, "alignment"],
  ["wrong source principal", e => { e.source = "other.private.ranger"; }, "alignment"],
  ["wrong source stack", e => { e.source = "example.other.ranger"; }, "alignment"],
  ["federated", e => { e.sovereignty.classification = "federated"; }, "alignment"],
  ["public", e => { e.sovereignty.classification = "public"; }, "alignment"],
  ["delegate", e => { e.distribution_mode = "delegate"; e.target_assistant = other; }, "alignment"],
  ["direct", e => { e.distribution_mode = "direct"; e.target_assistant = other; }, "alignment"],
  ["target on offer", e => { e.target_assistant = other; }, "alignment"],
  ["federated attribution", e => { e.originator = { identity: issuer, attribution: "federated" }; }, "alignment"],
  ["delegated attribution", e => { e.originator = { identity: issuer, attribution: "delegated" }; }, "alignment"],
  ["correlation changed", e => { e.correlation_id = crypto.randomUUID(); }, "request"],
  ["correlation missing", e => { delete e.correlation_id; }, "request"],
  ["deadline mismatch", e => { e.deadline = new Date(Date.now() + 120_000).toISOString(); }, "request"],
 ];
 for (const [name, mutate, stage] of envelopeFaults) test(`rejects signed ${name}`, async () => {
  const e = unsigned(); mutate(e); await refused(await signed(e), stage, "mismatch");
 });

 for (const subject of ["local.example.other.tasks.ci-test", "local.other.private.tasks.ci-test", "local.example.tasks.ci-test", "local.example.private.tasks.ci-test.extra", "federated.example.private.tasks.ci-test", "public.example.private.tasks.ci-test"]) {
  test(`rejects subject ${subject}`, async () => { await refused(await signed(), "alignment", "mismatch", subject); });
 }

 test("rejects different actor even if both issuers are explicitly configured", async () => {
  context.config.issuers.push({ issuer: other, bindings: structuredClone(context.config.issuers[0].bindings) });
  const e = unsigned(); e.originator = { identity: other, attribution: "adapter-resolved" };
  await refused(await signed(e), "authorization", "invalid");
 });

 test("a registry identity with no permission entry remains unauthorized", async () => {
  await refused(await signed(unsigned(), other), "authorization", "invalid");
 });

 test("unknown signing identity fails registry authentication", async () => {
  writeFileSync(context.config.registry.file, JSON.stringify({ version: 2, identities: [keys[relay].identity], trusted_hubs: [] }));
  await refused(await signed(), "authentication", "unverified");
 });

 test("missing, malformed and wrong-key registries fail closed without leaking details", async () => {
  for (const contents of ["malformed private registry", JSON.stringify({ version: 2, identities: [{ ...keys[issuer].identity, public_key: keys[other].identity.public_key }], trusted_hubs: [] })]) {
   writeFileSync(context.config.registry.file, contents); summaries.length = 0;
   await refused(await signed(), "authentication", "unverified");
  }
  context.config.registry.file = join(root, "missing-private-registry.json"); summaries.length = 0;
  await refused(await signed(), "authentication", "unverified");
 });

 const identityFaults: [string, (r: any) => void, BusAdmissionSummary["stage"]][] = [
  ["repository", r => { r.job.repositoryId = "github:github.com/example/other"; }, "authorization"],
  ["profile ID", r => { r.job.profileId = "other-profile"; }, "authorization"],
  ["profile digest", r => { r.job.profileDigest = digest("9"); }, "authorization"],
  ["lock", r => { r.job.lockDigest = digest("9"); }, "profile"],
  ["image", r => { r.job.imageDigest = digest("9"); }, "profile"],
  ["platform", r => { r.job.platform = "linux-amd64"; }, "request"],
  ["source digest", r => { r.source.bundleDigest = digest("9"); }, "request"],
  ["source size", r => { r.source.bundleBytes = 0; }, "request"],
  ["oversize source", r => { r.source.bundleBytes = BUS_LIMITS.bundleBytes + 1; }, "request"],
  ["source URL", r => { r.source.url = "https://private.example.invalid/source"; }, "request"],
  ["zero generation", r => { r.job.generation = 0; }, "request"],
  ["extra generation", r => { r.generation = 99; }, "request"],
  ["missing generation", r => { delete r.job.generation; }, "request"],
 ];
 for (const [name, mutate, stage] of identityFaults) test(`rejects signed wrong ${name}`, async () => {
  const r = request(); mutate(r); await refused(await signed(unsigned(r)), stage, "invalid");
 });

 for (const [name, profiles] of [
  ["missing", []],
  ["different ID", [{ ...profile(), profileId: "other-profile" }]],
  ["different digest", [{ ...profile(), profileDigest: digest("9") }]],
 ] as const) test(`${name} operator profile fails closed`, async () => {
  context = { ...context, profiles };
  await refused(await signed(), "profile", "denied");
 });

 for (const field of ["config", "profiles", "offerings"] as const) test(`invalid local ${field} is reported as setup failure before envelope parsing`, async () => {
  context = { ...context, [field]: field === "config" ? {} : [() => "uncloneable private setup"] };
  await expect(admitBusRequest({ bytes: Buffer.from("{"), subject: route.subject }, context)).rejects.toMatchObject({ stage: "config", code: "invalid" });
  expect(summaries).toEqual([{ stage: "config", code: "invalid" }]);
 });

 test("unchanged registry is read only once across admissions sharing a context", async () => {
  const e = await signed();
  const reads = spyOn(fs, "readFileSync");
  try {
   await admit(e);
   await admit(e);
   expect(reads.mock.calls.filter(([path]) => path === context.config.registry.file)).toHaveLength(1);
  } finally { reads.mockRestore(); }
 });

 test("registry revocation, failed reload and recovery never fall back to cached permission", async () => {
  const e = await signed();
  await admit(e);
  const original = readFileSync(context.config.registry.file);
  const rekeyed = original.toString().replace(keys[issuer].identity.public_key, keys[other].identity.public_key);
  expect(Buffer.byteLength(rekeyed)).toBe(original.byteLength);
  writeFileSync(context.config.registry.file, rekeyed);
  await refused(e, "authentication", "unverified"); summaries.length = 0;
  writeFileSync(context.config.registry.file, JSON.stringify({ version: 2, identities: [keys[relay].identity], trusted_hubs: [] }));
  await refused(e, "authentication", "unverified");
  writeFileSync(context.config.registry.file, "private malformed registry"); summaries.length = 0;
  await refused(e, "authentication", "unverified");
  rmSync(context.config.registry.file); summaries.length = 0;
  await expect(admit(e)).rejects.toMatchObject({ stage: "authentication", code: "unverified" });
  expect(summaries).toEqual([{ stage: "authentication", code: "unverified" }]);
  writeFileSync(context.config.registry.file, original); summaries.length = 0;
  expect((await admit(e)).provenance.issuer).toBe(issuer);
  expect(summaries).toEqual([]);
 });

 test("a changed configured registry path cannot reuse a cached registry", async () => {
  const e = await signed();
  await admit(e);
  context.config.registry.file = join(root, "another-registry.json");
  writeFileSync(context.config.registry.file, JSON.stringify({ version: 2, identities: [keys[relay].identity], trusted_hubs: [] }));
  await refused(e, "authentication", "unverified");
 });

 test("a cached registry never skips signature verification or freshness", async () => {
  const e = await signed();
  await admit(e);
  (e.payload as unknown as BusRequest).source.bundleBytes++;
  await refused(e, "authentication", "unverified"); summaries.length = 0;
  await refused(restampOrigin(await signed(), -301_000), "authentication", "unverified");
 });

 test("expired signed jobs are refused at admission", async () => {
  const r = request(); r.job.deadline = Date.now() - 1;
  await refused(await signed(unsigned(r)), "expiry", "expired");
 });

 for (const field of ["commitDigest", "treeDigest", "bundleDigest", "correlationId", "generation"]) test(`tampered signed ${field} fails cryptographic verification`, async () => {
  const e = await signed(); const r = e.payload as unknown as BusRequest;
  if (field === "generation") r.job.generation++;
  else if (field === "correlationId") { r.job.correlationId = crypto.randomUUID(); e.correlation_id = r.job.correlationId; }
  else if (field === "bundleDigest") { r.job.bundleDigest = digest("9"); r.source.bundleDigest = r.job.bundleDigest; }
  else r.job[field as "commitDigest" | "treeDigest"] = "9".repeat(40);
  await refused(e, "authentication", "unverified");
 });

 test("tampered signature and an invalid earlier stamp with valid relay both refuse", async () => {
  const e = await signed(); e.signed_by![0].signature = randomBytes(64).toString("base64");
  await refused(e, "authentication", "unverified"); summaries.length = 0;
  const forwarded = await signEnvelope(e, keys[relay].seed, relay);
  await refused(forwarded, "authentication", "unverified");
 });

 test("tampering with a valid source size invalidates the signed request", async () => {
  const e = await signed(); (e.payload as unknown as BusRequest).source.bundleBytes++;
  await refused(e, "authentication", "unverified");
 });

 test("a signed valid source size is retained exactly for the consumer", async () => {
  const r = request(); r.source.bundleBytes = BUS_LIMITS.bundleBytes;
  expect((await admit(await signed(unsigned(r)))).request.source.bundleBytes).toBe(BUS_LIMITS.bundleBytes);
 });

 test("legacy single-stamp wire form authenticates through the published chain helper", async () => {
  const e = await signed();
  (e as any).signed_by = e.signed_by![0];
  expect((await admit(e)).provenance.issuer).toBe(issuer);
 });

 test("an unknown later signer cannot be ignored after a valid origin", async () => {
  const e = await signEnvelope(await signed(), keys[other].seed, other);
  writeFileSync(context.config.registry.file, JSON.stringify({ version: 2, identities: [keys[issuer].identity], trusted_hubs: [] }));
  await refused(e, "authentication", "unverified");
 });

 for (const [name, chain] of [["empty", []], ["null", null], ["too long", Array.from({ length: 17 }, () => ({ method: "ed25519" }))]] as const) test(`invalid signed chain ${name} refuses schema validation`, async () => {
  const e = unsigned(); (e as any).signed_by = chain;
  await refused(e, "envelope", "invalid");
 });

 test("fresh valid signatures within the existing five-minute window are accepted", async () => {
  const e = restampOrigin(await signed(), -240_000);
  expect((await admit(e)).provenance.issuer).toBe(issuer);
 });

 for (const offset of [-301_000, 301_000]) test(`real signatures outside Myelin freshness window (${offset}) refuse`, async () => {
  const e = restampOrigin(await signed(), offset);
  await refused(e, "authentication", "unverified");
 });

 test("fresh final stamp cannot hide an expired origin stamp", async () => {
  const e = restampOrigin(await signed(), -301_000);
  await refused(await signEnvelope(e, keys[relay].seed, relay), "authentication", "unverified");
 });

 test("a trusted hub attesting a configured issuer is not that issuer acting as itself", async () => {
  const e = unsigned();
  e.signed_by = [{ identity: issuer, method: "hub-stamp", stamped_by: relay, at: new Date().toISOString(), signature: "" }];
  e.signed_by[0].signature = sign(null, canonicalizeForChainStamp(e, 0), keys[relay].privateKey).toString("base64");
  writeFileSync(context.config.registry.file, JSON.stringify({ version: 2, identities: Object.values(keys).map(k => k.identity), trusted_hubs: [relay] }));
  expect((await verifyEnvelopeIdentity(e, loadRegistry(context.config.registry.file))).status).toBe("verified");
  await refused(e, "authentication", "unverified");
 });

 test("bounded parsing refuses oversize input before decoding, plus malformed UTF-8/JSON and invalid envelope shapes", async () => {
  for (const [bytes, code] of [[new Uint8Array(BUS_LIMITS.requestBytes + 1).fill(255), "too_large"], [new Uint8Array([255]), "invalid"], [Buffer.from("{"), "invalid"], [encode({}), "invalid"], [encode({ ...unsigned(), spec_version: 1e300 }), "invalid"]] as const) {
   summaries.length = 0;
   await expect(admitBusRequest({ bytes, subject: route.subject }, context)).rejects.toMatchObject({ stage: "envelope", code });
   expect(summaries).toEqual([{ stage: "envelope", code }]);
  }
 });

 test("diagnostic failure cannot change refusal or leak payload, keys and config", async () => {
  const seen: unknown[] = [];
  context = { ...context, summary: s => { seen.push(s); throw Error("private sink failed"); } };
  const e = unsigned(); e.extensions = { secret: "private payload" }; e.economics = { wallet: "did:mf:private-wallet" };
  await expect(admit(e)).rejects.toMatchObject({ stage: "authentication", code: "unverified" });
  expect(seen).toEqual([{ stage: "authentication", code: "unverified" }]);
 });
});

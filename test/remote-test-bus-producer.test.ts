import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MyelinDurablePublishError } from "@the-metafactory/cortex/bus";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import { signEnvelope, type Identity } from "@the-metafactory/myelin/identity";
import { subjectFor } from "@the-metafactory/myelin/subjects";
import { admitBusRequest, BUS_TEST_CAPABILITY } from "../src/remote-test/bus-admission.ts";
import { validateBusConfig } from "../src/remote-test/bus-contract.ts";
import {
 BusProducerRefusal, connectBusPublisher, busOutcomeExitCode, busOutcomeMessage, retryBusCommand, runBusCommand, statusBusCommand,
 type BusProducerInjected, type BusPublisher, type BusRefusalStage, type BusStageFunction,
} from "../src/remote-test/bus-producer.ts";
import type { ProfileManifest } from "../src/remote-test/contract.ts";
import type { SshRunner } from "../src/remote-test/ssh-client.ts";

const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const issuer = "did:mf:example-ranger";
const now = 1_800_000_000_000;
const id = "6c7e8091-1234-4234-8234-123456789abc";
const profile: ProfileManifest = { version: 1, profileId: "unit-v1", profileDigest: sha("profile"), lockDigest: sha("lock"), imageDigest: sha("image"), platform: "linux-arm64", commands: [["bun", "test"]] };
const request = { version: 1 as const, jobId: id, correlationId: id, repositoryId: "github:github.com/example/repo", profileId: profile.profileId, profileDigest: profile.profileDigest,
 lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: now + 600_000, generation: 1 };
const source = { commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: sha("bundle") };
const staged = { bundleDigest: source.bundleDigest, bundleBytes: 4096 };
const job = { ...request, ...source };
const account = `A${"C".repeat(55)}`;
const otherAccount = `A${"D".repeat(55)}`;
const userJwt = (claims: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const creds = (jwt: string) => `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSU${"A".repeat(56)}\n------END USER NKEY SEED------\n`;
const accountCreds = (issuerAccount: string) => creds(userJwt({ iss: issuerAccount, sub: `U${"A".repeat(55)}`, nats: { type: "user" } }));
const issuerAccountCreds = (issuerAccount: string) => creds(userJwt({ iss: `O${"A".repeat(55)}`, sub: `U${"A".repeat(55)}`, nats: { type: "user", issuer_account: issuerAccount } }));
const receipt = { version: 1 as const, identity: job, executorId: "fixture", status: "passed" as const, completedAt: now - 1000, exitCode: 0 };

function keyPair() {
 const { privateKey, publicKey } = generateKeyPairSync("ed25519");
 const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
 const identity: Identity = { id: issuer, network: "example", public_key: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  type: "service", created_at: new Date().toISOString() };
 return { seed, identity };
}

describe("opt-in bus producer", () => {
 let root: string;
 let key: ReturnType<typeof keyPair>;
 let busConfig: Record<string, any>;
 let calls: { stage: number; publish: { envelope: MyelinEnvelope; options: unknown }[]; closed: number; ssh: { version: number; operation: string; job: unknown }[] };
 let publishOutcome: (envelope: MyelinEnvelope) => Promise<{ stream: string; seq: number; duplicate: boolean; domain?: string }>;
 let stageOutcome: Awaited<ReturnType<BusStageFunction>>;
 let injected: BusProducerInjected;

 const path = (name: string) => join(root, name);
 const writeJson = (name: string, value: unknown) => writeFile(path(name), JSON.stringify(value), { mode: 0o600 });
 const options = (extra: Record<string, string> = {}) => ({ config: path("bus.json"), signer: path("signer.json"), request: path("request.json"),
  worktree: path("worktree"), stagingRoot: root, requestOutput: path("saved-request.json"), ...extra });
 const savedFiles = async () => (await readdir(root)).filter(name => name !== "bus.json" && name !== "ssh.json" && name !== "signer.json" && name !== "request.json" && name !== "registry.json" && name !== "private.creds");
 const saved = async () => JSON.parse(await readFile(path("saved-request.json"), "utf8"));

 beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ranger-bus-producer-")));
  key = keyPair();
  busConfig = { version: 1, target: { domain: "private-domain", account },
   routing: { classification: "local", principal: "example", stack: "private" },
   streams: { request: { stream: "CI_REQUESTS", durable: "CI_EXECUTOR" }, result: { stream: "CI_RESULTS" } },
   transport: { servers: ["tls://bus.example.invalid:4222"], credentialsFile: path("private.creds") },
   ssh: { configFile: path("ssh.json") }, registry: { file: path("registry.json") },
   execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 60, progressIntervalSeconds: 10, maxDeliver: 3 },
   issuers: [{ issuer, bindings: [{ repositoryId: request.repositoryId, profileId: profile.profileId, profileDigest: profile.profileDigest }] }] };
  await writeJson("bus.json", busConfig);
  await writeJson("ssh.json", { target: "disposable-alias", remoteCli: "/reviewed/ranger", remoteConfig: "/private/executor.json", executorId: "fixture", profiles: [profile] });
  await writeJson("signer.json", { version: 1, issuer, seed: key.seed });
  await writeJson("registry.json", { version: 2, identities: [key.identity], trusted_hubs: [] });
  await writeJson("request.json", request);
  await writeFile(path("private.creds"), accountCreds(account), { mode: 0o600 });
  calls = { stage: 0, publish: [], closed: 0, ssh: [] };
  stageOutcome = { status: "staged", job, executorId: "fixture", source: staged };
  publishOutcome = async () => ({ stream: "CI_REQUESTS", seq: 7, duplicate: false, domain: "private-domain" });
  const publisher: BusPublisher = {
   publishDurable: async (envelope, publishOptions) => { calls.publish.push({ envelope: structuredClone(envelope) as unknown as MyelinEnvelope, options: publishOptions }); return publishOutcome(envelope as unknown as MyelinEnvelope); },
   close: async () => { calls.closed++; },
  };
  const runner: SshRunner = async invocation => {
   const chunks: Buffer[] = []; for await (const b of invocation.input) chunks.push(Buffer.from(b));
   calls.ssh.push(JSON.parse(Buffer.concat(chunks).toString().split("\n")[0]));
   return { code: 0, stdout: JSON.stringify({ version: 1, receipt }) };
  };
  injected = { now: () => now, publisher: async () => publisher, ssh: { runner },
   stage: async () => { calls.stage++; return stageOutcome; } };
 });
 afterEach(async () => { await rm(root, { recursive: true, force: true }); });

 const refusal = async (promise: Promise<unknown>, stage: BusRefusalStage) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(BusProducerRefusal);
  expect((error as BusProducerRefusal).stage).toBe(stage);
 };

 test("the SDK publisher falls through unreachable servers to the next configured one", async () => {
  const tried: string[] = [];
  const stopped: string[] = [];
  const snapshots: string[] = [], paths: string[] = [];
  const exists = (file: string) => stat(file).then(() => true, () => false);
  const start = (async (config: { nats: { url: string; credsPath: string } }) => {
   const url = config.nats.url;
   tried.push(url);
   expect(config.nats.credsPath).not.toBe(path("private.creds"));
   snapshots.push(await readFile(config.nats.credsPath, "utf8"));
   paths.push(config.nats.credsPath);
   if (url.includes("down")) throw new Error("connection refused");
   return { enabled: true, publishDurable: async () => ({}), stop: async () => { stopped.push(url); } };
  }) as unknown as Parameters<typeof connectBusPublisher>[0];
  const bus = validateBusConfig({ ...busConfig, transport: { ...busConfig.transport, servers: ["tls://down-1.example.invalid:4222", "tls://down-2.example.invalid:4222", "tls://up.example.invalid:4222", "tls://never.example.invalid:4222"] } });
  const credentials = { account, canonical: accountCreds(account) };
  const publisher = await connectBusPublisher(start)({ bus, signer: { issuer, seed: new Uint8Array(32) }, credentials });
  expect(tried).toEqual(["tls://down-1.example.invalid:4222", "tls://down-2.example.invalid:4222", "tls://up.example.invalid:4222"]);
  expect(await exists(paths[2])).toBe(true);
  await publisher.close?.();
  expect(await exists(paths[2])).toBe(false);
  expect(stopped).toEqual(["tls://up.example.invalid:4222"]);
  expect(snapshots).toEqual(Array(3).fill(credentials.canonical));
  const allDown = validateBusConfig({ ...busConfig, transport: { ...busConfig.transport, servers: ["tls://down-a.example.invalid:4222", "tls://down-b.example.invalid:4222"] } });
  await expect(connectBusPublisher(start)({ bus: allDown, signer: { issuer, seed: new Uint8Array(32) }, credentials })).rejects.toThrow("connection refused");
  expect(await exists(paths.at(-1)!)).toBe(false);
 });

 test("saves the exact job and stable unsigned envelope, then publishes durably once and reports submitted only", async () => {
  const result = await runBusCommand(options(), injected);
  expect(result).toMatchObject({ status: "submitted", stream: "CI_REQUESTS", seq: 7, duplicate: false });
  expect(busOutcomeExitCode(result)).toBe(0);
  expect(busOutcomeMessage(result)).toContain("not a test result");
  expect(calls.stage).toBe(1);
  expect(calls.publish).toHaveLength(1);
  expect(calls.publish[0].options).toEqual({ expectedStream: "CI_REQUESTS" });
  expect(calls.closed).toBe(1);
  expect(calls.ssh).toEqual([]);
  const record = await saved();
  expect(record).toMatchObject({ version: 1, issuer, executorId: "fixture", stream: "CI_REQUESTS", domain: "private-domain", job, source: staged,
   subject: subjectFor({ classification: "local", principal: "example", stack: "private", type: "tasks.ci-test" }) });
  expect(record.envelope).toEqual(calls.publish[0].envelope);
  expect(record.envelope.signed_by).toBeUndefined();
  expect(record.envelope.id).toBe((result as { eventId: string }).eventId);
  expect(record.envelope).toMatchObject({ source: "example.private.ranger", type: "tasks.ci-test", correlation_id: id, distribution_mode: "offer",
   originator: { identity: issuer, attribution: "adapter-resolved" }, deadline: new Date(request.deadline).toISOString(), payload: { version: 1, job, source: staged } });
  expect((await stat(path("saved-request.json"))).mode & 0o777).toBe(0o600);
  expect(await savedFiles()).toEqual(["saved-request.json"]);
 });

 test("the saved envelope, once signed by the issuer, passes the real Ranger admission unchanged", async () => {
  await runBusCommand(options(), injected);
  const { envelope } = await saved();
  const signedEnvelope = await signEnvelope(envelope, key.seed, issuer, { role: "origin" });
  const admitted = await admitBusRequest({ bytes: Buffer.from(JSON.stringify(signedEnvelope)), subject: (await saved()).subject }, {
   config: validateBusConfig(busConfig), profiles: [profile], offerings: [{ capability: BUS_TEST_CAPABILITY, scopes: ["local"] }],
  });
  expect(admitted.request.job).toEqual(job);
  expect(admitted.provenance).toMatchObject({ issuer, actor: issuer });
 });

 describe("staging", () => {
  test.each([
   ["a different job field", () => ({ ...stageOutcome, job: { ...job, generation: 2 } })],
   ["a different executor", () => ({ ...stageOutcome, executorId: "other" })],
   ["a different source digest", () => ({ ...stageOutcome, source: { ...staged, bundleDigest: sha("other") } })],
   ["a job outside the reviewed profile", () => ({ ...stageOutcome, job: { ...job, lockDigest: sha("other-lock") } })],
   ["an oversized source", () => ({ ...stageOutcome, source: { ...staged, bundleBytes: 65 * 1024 ** 2 } })],
  ])("%s is refused without saving or publishing", async (_name, mutate) => {
   stageOutcome = mutate();
   await refusal(runBusCommand(options(), injected), "binding");
   expect(calls.publish).toEqual([]);
   expect(await savedFiles()).toEqual([]);
  });

  test("a commit other than the expected one is refused", async () => {
   await refusal(runBusCommand(options({ expectedCommit: "c".repeat(40) }), injected), "binding");
   expect(await savedFiles()).toEqual([]);
   expect(calls.publish).toEqual([]);
  });

  test.each([
   [{ status: "refused", reason: "receiver_failed" }, "receiver_failed"],
   [{ status: "uncertain", reason: "no_response" }, "no_response"],
  ] as const)("%j saves nothing, publishes nothing and never falls back to local tests", async (outcome, reason) => {
   stageOutcome = outcome;
   const result = await runBusCommand(options(), injected);
   expect(result).toEqual({ status: "not_staged", reason });
   expect(busOutcomeExitCode(result)).toBe(1);
   expect(calls.publish).toEqual([]);
   expect(await savedFiles()).toEqual([]);
  });

  test("a deadline that passes during staging is refused before anything is saved", async () => {
   let clock = now;
   await refusal(runBusCommand(options(), { ...injected, now: () => clock, stage: async () => { clock = request.deadline; return stageOutcome; } }), "expired");
   expect(await savedFiles()).toEqual([]);
   expect(calls.publish).toEqual([]);
  });
 });

 describe("authorization and configuration", () => {
  test("a signer that is not a configured issuer is refused before staging", async () => {
   await writeFile(path("signer.json"), JSON.stringify({ version: 1, issuer: "did:mf:other", seed: key.seed }), { mode: 0o600 });
   await refusal(runBusCommand(options(), injected), "unauthorized");
   expect(calls.stage).toBe(0);
  });

  test("a repository or profile the issuer is not bound to is refused before staging", async () => {
   await writeJson("request.json", { ...request, repositoryId: "github:github.com/example/other" });
   await refusal(runBusCommand(options(), injected), "unauthorized");
   expect(calls.stage).toBe(0);
   expect(await savedFiles()).toEqual([]);
  });

  test("an expired request is refused before staging", async () => {
   await refusal(runBusCommand(options(), { ...injected, now: () => request.deadline }), "expired");
   expect(calls.stage).toBe(0);
  });

  test("caller-claimed source bindings are refused", async () => {
   await writeJson("request.json", { ...request, commitDigest: "a".repeat(40) });
   await refusal(runBusCommand(options(), injected), "request");
   expect(calls.stage).toBe(0);
  });

  test("missing, malformed or unsafe configuration and signer files are refused", async () => {
   await refusal(runBusCommand(options({ config: path("missing.json") }), injected), "config");
   await writeFile(path("signer.json"), JSON.stringify({ version: 1, issuer, seed: "short" }), { mode: 0o600 });
   await refusal(runBusCommand(options(), injected), "signer");
   await writeJson("signer.json", { version: 1, issuer, seed: key.seed });
   await chmod(path("signer.json"), 0o666);
   await refusal(runBusCommand(options(), injected), "signer");
   expect(calls.stage).toBe(0);
   expect(calls.publish).toEqual([]);
  });

  test("bus-run refuses credentials of another account before staging, saving or publishing", async () => {
   for (const text of [accountCreds(otherAccount), issuerAccountCreds(otherAccount)]) {
    await writeFile(path("private.creds"), text, { mode: 0o600 });
    const error = await runBusCommand(options(), injected).then(() => undefined, (e: unknown) => e) as BusProducerRefusal;
    expect(error).toBeInstanceOf(BusProducerRefusal);
    expect(error).toMatchObject({ stage: "config", message: "NATS credentials are not for the configured target account" });
   }
   expect(calls.stage).toBe(0);
   expect(calls.publish).toEqual([]);
   expect(await savedFiles()).toEqual([]);
  });

  test("an issuer account claim that names the configured account is accepted", async () => {
   await writeFile(path("private.creds"), issuerAccountCreds(account), { mode: 0o600 });
   expect(await runBusCommand(options(), injected)).toMatchObject({ status: "submitted" });
  });

  test("bus-retry and bus-status refuse a saved request once the credentials name another account", async () => {
   await runBusCommand(options(), injected);
   await writeFile(path("private.creds"), accountCreds(otherAccount), { mode: 0o600 });
   await refusal(retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("saved-request.json") }, injected), "config");
   await refusal(statusBusCommand({ config: path("bus.json"), request: path("saved-request.json"), output: path("receipt.json") }, injected), "config");
   expect(calls.publish).toHaveLength(1);
   expect(calls.ssh).toEqual([]);
   expect(await savedFiles()).toEqual(["saved-request.json"]);
  });

  test.each([
   ["missing", async () => { await rm(path("private.creds")); }],
   ["group-writable", async () => { await chmod(path("private.creds"), 0o620); }],
   ["not a creds file", async () => { await writeFile(path("private.creds"), "secret-token-material\n", { mode: 0o600 }); }],
   ["a JWT that is not JSON", async () => { await writeFile(path("private.creds"), creds("e30.c2VjcmV0LXRva2Vu.sig"), { mode: 0o600 }); }],
   ["a JWT that is not a user", async () => { await writeFile(path("private.creds"), creds(userJwt({ iss: account, sub: `U${"A".repeat(55)}`, nats: { type: "account" } })), { mode: 0o600 }); }],
   ["no seed", async () => { await writeFile(path("private.creds"), accountCreds(account).replace(/SU[A-Z]+/, "secret-seed"), { mode: 0o600 }); }],
  ])("%s credentials are refused without echoing them", async (_name, corrupt) => {
   await corrupt();
   const error = await runBusCommand(options(), injected).then(() => undefined, (e: unknown) => e) as BusProducerRefusal;
   expect(error).toBeInstanceOf(BusProducerRefusal);
   expect(error).toMatchObject({ stage: "config", message: "NATS credentials are missing, unsafe or invalid" });
   expect(String(error.stack)).not.toContain("secret");
   expect(calls.stage).toBe(0);
   expect(await savedFiles()).toEqual([]);
  });

  test("an existing output path is never overwritten", async () => {
   await writeFile(path("saved-request.json"), "keep");
   const error = await runBusCommand(options(), injected).then(() => undefined, (e: unknown) => e);
   expect(error).toBeDefined();
   expect(await readFile(path("saved-request.json"), "utf8")).toBe("keep");
   expect(calls.stage).toBe(0);
  });
 });

 describe("uncertain or failed publication", () => {
  test("a timeout keeps the saved identity, exposes uncertainty and never resubmits or runs locally", async () => {
   publishOutcome = async envelope => { throw new MyelinDurablePublishError("timeout", envelope.id, "no PubAck"); };
   const result = await runBusCommand(options(), injected);
   expect(result).toMatchObject({ status: "uncertain", reason: "timeout" });
   expect(busOutcomeExitCode(result)).toBe(1);
   expect(busOutcomeMessage(result)).toContain("uncertain");
   expect(calls.publish).toHaveLength(1);
   expect(calls.stage).toBe(1);
   expect(calls.closed).toBe(1);
   expect((await saved()).envelope.id).toBe((result as { eventId: string }).eventId);
   expect(await savedFiles()).toEqual(["saved-request.json"]);
  });

  test("explicit retry republishes the same envelope and message ID without restaging", async () => {
   publishOutcome = async envelope => { throw new MyelinDurablePublishError("jetstream-error", envelope.id, "connection lost"); };
   await runBusCommand(options(), injected);
   const before = await readFile(path("saved-request.json"), "utf8");
   publishOutcome = async () => ({ stream: "CI_REQUESTS", seq: 8, duplicate: true, domain: "private-domain" });
   const retried = await retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("saved-request.json") }, { ...injected, now: () => now + 1000 });
   expect(retried).toMatchObject({ status: "submitted", seq: 8, duplicate: true });
   expect(calls.stage).toBe(1);
   expect(calls.publish).toHaveLength(2);
   expect(calls.publish[1].envelope).toEqual(calls.publish[0].envelope);
   expect(calls.publish[1].envelope.id).toBe(calls.publish[0].envelope.id);
   expect(await readFile(path("saved-request.json"), "utf8")).toBe(before);
  });

  test.each(["sign-failed", "no-signer", "disabled", "unroutable"] as const)("%s means nothing was sent and no success marker exists", async kind => {
   publishOutcome = async envelope => { throw new MyelinDurablePublishError(kind, envelope.id, "refused"); };
   const result = await runBusCommand(options(), injected);
   expect(result).toMatchObject({ status: "refused", reason: kind });
   expect(busOutcomeExitCode(result)).toBe(1);
   expect(await savedFiles()).toEqual(["saved-request.json"]);
   expect(await saved()).not.toHaveProperty("seq");
  });

  test.each([
   ["stream-mismatch", "stream-mismatch"],
   ["domain-mismatch", "domain-mismatch"],
  ] as const)("%s may have stored the message and is uncertain", async (kind, reason) => {
   publishOutcome = async envelope => { throw new MyelinDurablePublishError(kind, envelope.id, "wrong ack"); };
   expect(await runBusCommand(options(), injected)).toMatchObject({ status: "uncertain", reason });
  });

  test.each([
   ["a different stream", { stream: "OTHER", seq: 1, duplicate: false, domain: "private-domain" }],
   ["a different domain", { stream: "CI_REQUESTS", seq: 1, duplicate: false, domain: "other-domain" }],
   ["an absent domain", { stream: "CI_REQUESTS", seq: 1, duplicate: false }],
   ["an invalid sequence", { stream: "CI_REQUESTS", seq: 0, duplicate: false, domain: "private-domain" }],
  ])("an acknowledgement from %s is not submitted", async (_name, ack) => {
   publishOutcome = async () => ack;
   expect(await runBusCommand(options(), injected)).toMatchObject({ status: "uncertain", reason: "ack_mismatch" });
  });

  test("a non-SDK failure and a publisher that cannot start are reported without a success", async () => {
   publishOutcome = async () => { throw Error("socket secret"); };
   const failed = await runBusCommand(options({ requestOutput: path("a.json") }), injected);
   expect(failed).toMatchObject({ status: "uncertain", reason: "publish_failed" });
   expect(JSON.stringify(failed)).not.toContain("secret");
   const unavailable = await runBusCommand(options({ requestOutput: path("b.json") }), { ...injected, publisher: async () => { throw Error("no broker"); } });
   expect(unavailable).toMatchObject({ status: "refused", reason: "publisher_unavailable" });
  });

  test("retry never refreshes an expired request", async () => {
   publishOutcome = async envelope => { throw new MyelinDurablePublishError("timeout", envelope.id, "no PubAck"); };
   await runBusCommand(options(), injected);
   const before = await readFile(path("saved-request.json"), "utf8");
   const retried = await retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("saved-request.json") }, { ...injected, now: () => request.deadline + 1 });
   expect(retried).toMatchObject({ status: "refused", reason: "expired_request" });
   expect(calls.publish).toHaveLength(1);
   expect(await readFile(path("saved-request.json"), "utf8")).toBe(before);
  });

  test("retry refuses a saved request that no longer matches the configuration, signer or its own envelope", async () => {
   await runBusCommand(options(), injected);
   const retry = () => retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("saved-request.json") }, injected);
   const record = await saved();
   const otherStream = structuredClone(busConfig); otherStream.streams.request.stream = "OTHER_REQUESTS";
   await writeJson("bus.json", otherStream);
   await refusal(retry(), "record");
   await writeJson("bus.json", busConfig);
   await writeFile(path("signer.json"), JSON.stringify({ version: 1, issuer: "did:mf:other", seed: key.seed }), { mode: 0o600 });
   await refusal(retry(), "unauthorized");
   await writeJson("signer.json", { version: 1, issuer, seed: key.seed });
   const tampered = structuredClone(record); tampered.envelope.payload.source.bundleBytes = 1;
   await writeJson("tampered.json", tampered);
   await refusal(retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("tampered.json") }, injected), "record");
   await writeJson("signed.json", { ...record, envelope: await signEnvelope(record.envelope, key.seed, issuer, { role: "origin" }) });
   await refusal(retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("signed.json") }, injected), "record");
   await refusal(retryBusCommand({ config: path("bus.json"), signer: path("signer.json"), request: path("missing.json") }, injected), "record");
   expect(calls.publish).toHaveLength(1);
  });
 });

 describe("receipt-only lookup", () => {
  test("uses the saved exact job over the status operation and neither stages, publishes nor executes", async () => {
   await runBusCommand(options(), injected);
   const result = await statusBusCommand({ config: path("bus.json"), request: path("saved-request.json"), output: path("receipt.json") }, injected);
   expect(result).toEqual({ status: "terminal", receipt });
   expect(calls.ssh).toEqual([{ version: 2, operation: "status", job }]);
   expect(calls.stage).toBe(1);
   expect(calls.publish).toHaveLength(1);
   expect(JSON.parse(await readFile(path("receipt.json"), "utf8"))).toEqual(receipt);
  });

  test("an absent receipt stays pending and is not success", async () => {
   await runBusCommand(options(), injected);
   const runner: SshRunner = async () => ({ code: 0, stdout: JSON.stringify({ version: 1, receipt: null }) });
   const result = await statusBusCommand({ config: path("bus.json"), request: path("saved-request.json"), output: path("receipt.json") }, { ...injected, ssh: { runner } });
   expect(result).toEqual({ status: "pending", reason: "absent_receipt" });
   expect(await savedFiles()).not.toContain("receipt.json");
  });

  test("a missing saved request is refused", async () => {
   await refusal(statusBusCommand({ config: path("bus.json"), request: path("nope.json"), output: path("receipt.json") }, injected), "record");
  });
 });

 test("without a bus option the existing remote-test commands keep their shape", async () => {
  const help = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "remote-test", "--help"], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(help.stdout).text();
  await help.exited;
  for (const command of ["run", "status", "bus-run", "bus-retry", "bus-status"]) expect(text).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
  const failed = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "remote-test", "bus-run", "--config", path("missing.json"), "--signer", path("signer.json"),
   "--request", path("request.json"), "--worktree", root, "--staging-root", root, "--request-output", path("out.json")], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(failed.stderr).text();
  expect(await failed.exited).toBe(1);
  expect(stderr).toContain("config refusal");
  expect(await savedFiles()).toEqual([]);
 });
});

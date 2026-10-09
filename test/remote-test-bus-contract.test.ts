import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 authorizeBusProducer,
 BUS_LIMITS,
 BusContractRefusal,
 validateBusConfig,
 validateBusRequest,
 type BusConfig,
 type BusRefusalCode,
} from "../src/remote-test/bus-contract.ts";
import type { RemoteTestJob } from "../src/remote-test/contract.ts";
import { SSH_LIMITS } from "../src/remote-test/ssh-protocol.ts";
import { validateSshConfig } from "../src/remote-test/ssh-client.ts";
import { ConfigError, loadConfig } from "../src/config.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64)}`;
const ISSUER = "did:mf:example-ranger";
const job = (): RemoteTestJob => ({
 version: 1,
 jobId: "6c7e8091-1234-4234-8234-123456789abc",
 correlationId: "8c7e8091-1234-4234-8234-123456789abc",
 repositoryId: "github:github.com/the-metafactory/ranger",
 commitDigest: "d".repeat(40),
 treeDigest: "e".repeat(40),
 bundleDigest: digest("f"),
 profileId: "bun-unit-v1",
 profileDigest: digest("a"),
 lockDigest: digest("b"),
 imageDigest: digest("c"),
 platform: "linux-arm64",
 deadline: 1_900_000_000_000,
 generation: 3,
});
const request = (): Record<string, any> => ({ version: 1, job: job(), source: { bundleDigest: digest("f"), bundleBytes: 4096 } });
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const config = (): Record<string, any> => ({
 version: 1,
 target: { domain: "example-domain", account: "example-account" },
 routing: { classification: "local", principal: "example", stack: "private" },
 streams: { request: { stream: "CI_TEST_REQUESTS", durable: "CI_TEST_EXECUTOR" }, result: { stream: "CI_TEST_RESULTS" } },
 transport: { servers: ["tls://bus.example.invalid:4222"], credentialsFile: "/example-private/bus.creds" },
 ssh: { configFile: "/example-private/ssh.json" },
 execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 60, progressIntervalSeconds: 20, maxDeliver: 3 },
 registry: { file: "/example-private/registry.json" },
 issuers: [{ issuer: ISSUER, bindings: [{ repositoryId: job().repositoryId, profileId: job().profileId, profileDigest: job().profileDigest }] }],
});
const refusal = (fn: () => unknown): BusRefusalCode | undefined => {
 try { fn(); } catch (error) { if (error instanceof BusContractRefusal) return error.code; throw error; }
 return undefined;
};
type Mutation = (value: Record<string, any>) => void;

describe("bus request validation", () => {
 test("accepts a bound request and preserves every V1 job identity field", () => {
  const input = request();
  const parsed = validateBusRequest(encode(input));
  expect(parsed).toEqual(input as any);
  expect(parsed.job).toEqual(job());
  expect(validateBusRequest(Buffer.from(JSON.stringify(input))).source.bundleBytes).toBe(4096);
  expect(validateBusRequest(encode({ ...input, source: { ...input.source, bundleBytes: SSH_LIMITS.bundleBytes } })).source.bundleBytes).toBe(SSH_LIMITS.bundleBytes);
 });

 test("bounds the encoded request at 128 KiB before decoding or parsing", () => {
  expect(BUS_LIMITS.requestBytes).toBe(131_072);
  const body = JSON.stringify(request());
  const padded = (size: number) => new TextEncoder().encode(body + " ".repeat(size - body.length));
  expect(validateBusRequest(padded(BUS_LIMITS.requestBytes)).job.jobId).toBe(job().jobId);
  expect(refusal(() => validateBusRequest(padded(BUS_LIMITS.requestBytes + 1)))).toBe("too_large");
  // Invalid UTF-8 and invalid JSON past the limit report size, proving no decode or parse ran.
  expect(refusal(() => validateBusRequest(new Uint8Array(BUS_LIMITS.requestBytes + 1).fill(0xff)))).toBe("too_large");
  expect(refusal(() => validateBusRequest(new TextEncoder().encode("{".repeat(BUS_LIMITS.requestBytes + 1))))).toBe("too_large");
 });

 const malformed: [string, Uint8Array | unknown][] = [
  ["empty bytes", new Uint8Array()],
  ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
  ["truncated JSON", new TextEncoder().encode(JSON.stringify(request()).slice(0, -1))],
  ["a string instead of bytes", JSON.stringify(request())],
  ["a parsed object instead of bytes", request()],
  ["deeply nested JSON within the limit", new TextEncoder().encode("[".repeat(60_000) + "]".repeat(60_000))],
 ];
 for (const [name, input] of malformed) {
  test(`refuses malformed payload: ${name}`, () => {
   const code = refusal(() => validateBusRequest(input as Uint8Array));
   expect(code === "malformed" || code === "invalid").toBe(true);
  });
 }

 const invalid: [string, Mutation][] = [
  ["unknown top-level field", r => { r.reply = "inbox.private"; }],
  ["prototype key", () => {}],
  ["version 2", r => { r.version = 2; }],
  ["missing source", r => { delete r.source; }],
  ["missing job", r => { delete r.job; }],
  ["source as a URL string", r => { r.source = "https://example.invalid/source.bundle"; }],
  ["source as a path string", r => { r.source = "/private/source.bundle"; }],
  ["source digest as a path", r => { r.source.bundleDigest = "/private/source.bundle"; }],
  ["source digest as a URL", r => { r.source.bundleDigest = "https://example.invalid/source.bundle"; }],
  ["source path field", r => { r.source.path = "/private/source.bundle"; }],
  ["source URL field", r => { r.source.url = "https://example.invalid/source.bundle"; }],
  ["source command field", r => { r.source.command = ["git", "fetch"]; }],
  ["command at top level", r => { r.command = "bun test"; }],
  ["zero bundle bytes", r => { r.source.bundleBytes = 0; }],
  ["negative bundle bytes", r => { r.source.bundleBytes = -1; }],
  ["fractional bundle bytes", r => { r.source.bundleBytes = 1.5; }],
  ["string bundle bytes", r => { r.source.bundleBytes = "4096"; }],
  ["bundle above the receiver ceiling", r => { r.source.bundleBytes = SSH_LIMITS.bundleBytes + 1; }],
  ["unsafe bundle size", r => { r.source.bundleBytes = 2 ** 53 + 1; }],
  ["empty object", r => { for (const key of Object.keys(r)) delete r[key]; }],
  ["unknown job field", r => { r.job.image = "docker.io/example:latest"; }],
  ["abbreviated commit", r => { r.job.commitDigest = "d".repeat(12); }],
  ["job without generation", r => { delete r.job.generation; }],
  ["job on another platform", r => { r.job.platform = "linux-amd64"; }],
  ["job repository as a URL", r => { r.job.repositoryId = "https://github.com/the-metafactory/ranger"; }],
 ];
 for (const [name, mutate] of invalid) {
  test(`refuses invalid request: ${name}`, () => {
   const value = request(); mutate(value);
   const bytes = name === "prototype key"
    ? new TextEncoder().encode(JSON.stringify(request()).replace(/^\{/, '{"__proto__":{"admin":true},'))
    : encode(value);
   expect(refusal(() => validateBusRequest(bytes))).toBe("invalid");
  });
 }
 test("refuses JSON null and arrays", () => {
  expect(refusal(() => validateBusRequest(encode(null)))).toBe("invalid");
  expect(refusal(() => validateBusRequest(encode([request()])))).toBe("invalid");
 });

 test("refuses a source digest that differs from the job bundle", () => {
  const value = request(); value.source.bundleDigest = digest("0");
  expect(refusal(() => validateBusRequest(encode(value)))).toBe("digest_mismatch");
  const both = request(); both.job.bundleDigest = digest("1");
  expect(refusal(() => validateBusRequest(encode(both)))).toBe("digest_mismatch");
 });

 test("refusal messages never echo request content", () => {
  const value = request(); value.source.url = "https://secret.example.invalid/token";
  try { validateBusRequest(encode(value)); throw Error("accepted"); }
  catch (error) { expect((error as Error).message).not.toContain("secret"); }
 });
});

describe("private bus configuration", () => {
 test("accepts complete explicit configuration", () => {
  expect(validateBusConfig(config())).toEqual(config() as BusConfig);
 });

 const refused: [string, Mutation][] = [
  ["missing domain", c => { delete c.target.domain; }],
  ["empty domain", c => { c.target.domain = ""; }],
  ["missing account", c => { delete c.target.account; }],
  ["wildcard account", c => { c.target.account = "*"; }],
  ["missing target", c => { delete c.target; }],
  ["federated classification", c => { c.routing.classification = "federated"; }],
  ["public classification", c => { c.routing.classification = "public"; }],
  ["subject wildcard as stack", c => { c.routing.stack = ">"; }],
  ["dotted principal", c => { c.routing.principal = "a.b"; }],
  ["missing request durable", c => { delete c.streams.request.durable; }],
  ["wildcard request stream", c => { c.streams.request.stream = "CI_*"; }],
  ["full wildcard durable", c => { c.streams.request.durable = ">"; }],
  ["missing result stream", c => { delete c.streams.result; }],
  ["shared request/result stream", c => { c.streams.result.stream = c.streams.request.stream; }],
  ["no servers", c => { c.transport.servers = []; }],
  ["server without port", c => { c.transport.servers = ["tls://bus.example.invalid"]; }],
  ["server with credentials", c => { c.transport.servers = ["nats://user:pass@bus.example.invalid:4222"]; }],
  ["server with path", c => { c.transport.servers = ["nats://bus.example.invalid:4222/x"]; }],
  ["server with query", c => { c.transport.servers = ["nats://bus.example.invalid:4222?x=1"]; }],
  ["websocket server", c => { c.transport.servers = ["wss://bus.example.invalid:443"]; }],
  ["duplicate servers", c => { c.transport.servers = ["tls://a.example.invalid:4222", "tls://a.example.invalid:4222"]; }],
  ["relative credentials file", c => { c.transport.credentialsFile = "bus.creds"; }],
  ["traversing credentials file", c => { c.transport.credentialsFile = "/example-private/../bus.creds"; }],
  ["missing SSH locator", c => { delete c.ssh; }],
  ["relative SSH locator", c => { c.ssh.configFile = "./ssh.json"; }],
  ["two outstanding deliveries", c => { c.execution.maxAckPending = 2; }],
  ["two concurrent jobs", c => { c.execution.maxConcurrentJobs = 2; }],
  ["progress after ack expiry", c => { c.execution.progressIntervalSeconds = 60; }],
  ["unbounded redelivery", c => { c.execution.maxDeliver = 1000; }],
  ["missing execution", c => { delete c.execution; }],
  ["missing registry", c => { delete c.registry; }],
  ["missing issuers", c => { delete c.issuers; }],
  ["empty issuers", c => { c.issuers = []; }],
  ["wildcard issuer", c => { c.issuers[0].issuer = "*"; }],
  ["issuer pattern", c => { c.issuers[0].issuer = "did:mf:*"; }],
  ["issuer subtree", c => { c.issuers[0].issuer = "did:mf:>"; }],
  ["duplicate issuer", c => { c.issuers.push(structuredClone(c.issuers[0])); }],
  ["empty bindings", c => { c.issuers[0].bindings = []; }],
  ["wildcard repository", c => { c.issuers[0].bindings[0].repositoryId = "github:github.com/the-metafactory/*"; }],
  ["wildcard profile", c => { c.issuers[0].bindings[0].profileId = "*"; }],
  ["missing profile digest", c => { delete c.issuers[0].bindings[0].profileDigest; }],
  ["duplicate binding", c => { c.issuers[0].bindings.push({ ...c.issuers[0].bindings[0], profileDigest: digest("9") }); }],
  ["delegated actor entry", c => { c.issuers[0].actor = "did:mf:other"; }],
  ["permission derived from job", c => { c.issuers[0].bindings[0].fromJob = true; }],
  ["default-domain switch", c => { c.useDefaultDomain = true; }],
  ["version 2", c => { c.version = 2; }],
 ];
 for (const [name, mutate] of refused) {
  test(`fails closed: ${name}`, () => {
   const value = config(); mutate(value);
   expect(() => validateBusConfig(value)).toThrow();
  });
 }

 test("documented skeleton is inert until every placeholder is substituted", () => {
  const template = readFileSync(new URL("../docs/examples/remote-test-bus-config.json", import.meta.url), "utf8");
  expect(() => validateBusConfig(JSON.parse(template))).toThrow();
  const c = config();
  const replacements: Record<string, unknown> = {
   REPLACE_JETSTREAM_DOMAIN: c.target.domain, REPLACE_NATS_ACCOUNT: c.target.account,
   REPLACE_PRINCIPAL_TOKEN: c.routing.principal, REPLACE_STACK_TOKEN: c.routing.stack,
   REPLACE_REQUEST_STREAM: c.streams.request.stream, REPLACE_REQUEST_DURABLE: c.streams.request.durable,
   REPLACE_RESULT_STREAM: c.streams.result.stream,
   REPLACE_NATS_SERVER_URL: c.transport.servers[0], REPLACE_NATS_CREDENTIALS_ABSOLUTE_PATH: c.transport.credentialsFile,
   REPLACE_SSH_CONFIG_ABSOLUTE_PATH: c.ssh.configFile,
   REPLACE_ACK_WAIT_SECONDS: 60, REPLACE_PROGRESS_INTERVAL_SECONDS: 20, REPLACE_MAX_DELIVER: 3,
   REPLACE_IDENTITY_REGISTRY_ABSOLUTE_PATH: c.registry.file,
   REPLACE_RANGER_ISSUER_DID: ISSUER, REPLACE_REPOSITORY_ID: job().repositoryId,
   REPLACE_APPROVED_PROFILE_ID: job().profileId, REPLACE_PROFILE_DIGEST: job().profileDigest,
  };
  const substituted = template.replace(/"(REPLACE_[A-Z_]+)"/g, (_, placeholder: string) => {
   expect(replacements[placeholder]).toBeDefined();
   return JSON.stringify(replacements[placeholder]);
  });
  expect(validateBusConfig(JSON.parse(substituted))).toEqual(c as BusConfig);
 });
});

describe("producer binding", () => {
 const parsed = () => validateBusConfig(config());
 test("binds an issuer acting as itself to its exact repository/profile digest", () => {
  const expected = config().issuers[0].bindings[0];
  expect(authorizeBusProducer(parsed(), { issuer: ISSUER }, job())).toEqual(expected);
  expect(authorizeBusProducer(parsed(), { issuer: ISSUER, actor: ISSUER }, job())).toEqual(expected);
 });

 test("refuses a delegated distinct actor even when the actor is also configured", () => {
  const c = config();
  c.issuers.push({ issuer: "did:mf:other-ranger", bindings: structuredClone(c.issuers[0].bindings) });
  const both = validateBusConfig(c);
  expect(refusal(() => authorizeBusProducer(both, { issuer: ISSUER, actor: "did:mf:other-ranger" }, job()))).toBe("actor_mismatch");
  expect(refusal(() => authorizeBusProducer(both, { issuer: ISSUER, actor: "" }, job()))).toBe("actor_mismatch");
 });

 const unauthorized: [string, { issuer: string }, Partial<RemoteTestJob>][] = [
  ["unknown issuer", { issuer: "did:mf:unknown" }, {}],
  ["right repository with the wrong profile digest", { issuer: ISSUER }, { profileDigest: digest("9") }],
  ["unbound profile", { issuer: ISSUER }, { profileId: "bun-other-v1" }],
  ["unbound repository", { issuer: ISSUER }, { repositoryId: "github:github.com/the-metafactory/other" }],
 ];
 for (const [name, origin, change] of unauthorized) {
  test(`refuses ${name}`, () => {
   expect(refusal(() => authorizeBusProducer(parsed(), origin, { ...job(), ...change }))).toBe("unauthorized");
  });
 }

 test("a profile bound to another issuer grants nothing to this issuer", () => {
  const c = config();
  c.issuers.push({ issuer: "did:mf:other-ranger", bindings: [{ repositoryId: job().repositoryId, profileId: "bun-other-v1", profileDigest: digest("8") }] });
  expect(refusal(() => authorizeBusProducer(validateBusConfig(c), { issuer: ISSUER }, { ...job(), profileId: "bun-other-v1", profileDigest: digest("8") }))).toBe("unauthorized");
 });
});

describe("existing configuration stays unchanged and the bus shape is inert", () => {
 test("SSH configuration parses as before and refuses bus fields", () => {
  const profile = { version: 1, profileId: "bun-unit-v1", profileDigest: digest("a"), lockDigest: digest("b"), imageDigest: digest("c"), platform: "linux-arm64", commands: [["bun", "test"]] };
  const ssh = { target: "example-host", remoteCli: "/opt/ranger/bin/ranger", remoteConfig: "/example-private/executor.json", executorId: "executor-1", profiles: [profile] };
  expect(validateSshConfig(ssh)).toEqual({ ...ssh, timeoutSeconds: 660, receiptMaxAgeMs: 86_400_000 } as any);
  expect(() => validateSshConfig({ ...ssh, bus: config() })).toThrow();
  expect(() => validateBusConfig(ssh)).toThrow();
 });

 test("supervisor test backends cannot select the bus", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-bus-config-"));
  try {
   const path = join(dir, "ranger.yaml");
   const yaml = (kind: string) => `maps:\n  - repo: acme/widgets\n    root: 1\n    testBackend:\n      kind: ${kind}\n      configFile: /example-private/ssh.json\n      stateRoot: /example-private/state\n      profileId: bun-unit-v1\n      lockFile: bun.lock\n`;
   writeFileSync(path, yaml("ssh"));
   expect(loadConfig(path, {}).config.maps[0].testBackend?.kind).toBe("ssh");
   writeFileSync(path, yaml("bus"));
   expect(() => loadConfig(path, {})).toThrow(ConfigError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });

 test("no Ranger source module loads the bus contract", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const files = readdirSync(root, { recursive: true }).map(String).filter(f => f.endsWith(".ts") && !f.endsWith("bus-contract.ts"));
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) expect(readFileSync(join(root, file), "utf8")).not.toContain("bus-contract");
 });
});

import { describe, expect, test } from "bun:test";
import {
 validateProfileManifest,
 validateRemoteTestJob,
 validateRemoteTestReceipt,
 receiptMatchesRequest,
 type ProfileManifest,
 type RemoteTestJob,
 type RemoteTestReceipt,
} from "../src/remote-test/contract.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64)}`;
const profile = (): ProfileManifest => ({
 version: 1,
 profileId: "bun-unit-v1",
 profileDigest: digest("a"),
 lockDigest: digest("b"),
 imageDigest: digest("c"),
 platform: "linux-arm64",
 commands: [["bun", "test"], ["bunx", "tsc", "--noEmit"]],
});
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
 generation: 1,
});
const receipt = (): RemoteTestReceipt => ({
 version: 1,
 identity: job(),
 executorId: "executor-test-1",
 status: "passed",
 completedAt: 1_899_999_999_000,
 exitCode: 0,
});

describe("V1 jobs and operator-selected profiles", () => {
 test("accepts a complete job and returns a detached typed request", () => {
  const input = job();
  const parsed = validateRemoteTestJob(input, profile());
  expect(parsed).toEqual(input);
  expect(parsed).not.toBe(input);
  expect(validateProfileManifest(profile())).toEqual(profile());
 });

 test("supports SHA-256 Git object repositories without abbreviations", () => {
  expect(validateRemoteTestJob({ ...job(), commitDigest: "d".repeat(64), treeDigest: "e".repeat(64) }, profile()).commitDigest).toHaveLength(64);
  expect(() => validateRemoteTestJob({ ...job(), treeDigest: "e".repeat(64) }, profile())).toThrow();
 });

 const malformed: [string, unknown][] = [
  ["version", 2], ["version", "1"],
  ["jobId", "not-a-uuid"], ["correlationId", ""],
  ["commitDigest", "abc1234"], ["treeDigest", "z".repeat(40)],
  ["bundleDigest", "f".repeat(64)], ["profileDigest", "sha256:bad"],
  ["lockDigest", digest("g")], ["imageDigest", `sha256:${"C".repeat(64)}`],
  ["repositoryId", "https://user:password@example.test/repo"],
  ["repositoryId", "github:github.com/owner/../repo"],
  ["profileId", ""], ["platform", "darwin-arm64"],
  ["deadline", -1], ["deadline", Infinity], ["deadline", 1.5],
  ["deadline", Number.MAX_SAFE_INTEGER + 1],
  ["generation", 0], ["generation", "1"], ["generation", 1.1],
 ];
 for (const [field, value] of malformed) {
  test(`rejects malformed job ${field}=${String(value)}`, () => {
   expect(() => validateRemoteTestJob({ ...job(), [field]: value }, profile())).toThrow();
  });
 }
 for (const field of Object.keys(job())) {
  test(`rejects missing job identity ${field}`, () => {
   const input: Record<string, unknown> = job();
   delete input[field];
   expect(() => validateRemoteTestJob(input, profile())).toThrow();
  });
 }
 for (const field of ["commands", "credentials", "env", "approved", "cpu", "endpoint"]) {
  test(`rejects caller authority field ${field}`, () => {
   expect(() => validateRemoteTestJob({ ...job(), [field]: "override" }, profile())).toThrow();
  });
 }
 for (const field of ["profileId", "profileDigest", "lockDigest", "imageDigest", "platform"]) {
  test(`rejects a profile mismatch on ${field}`, () => {
   const value = field === "profileId" ? "other-profile" : field === "platform" ? "linux-amd64" : digest("1");
   expect(() => validateRemoteTestJob({ ...job(), [field]: value }, profile())).toThrow();
  });
 }
 test("does not mutate or coerce caller inputs", () => {
  const input = job();
  const selected = profile();
  validateRemoteTestJob(Object.freeze(input), Object.freeze(selected));
  expect(input).toEqual(job());
  expect(selected).toEqual(profile());
 });
});

describe("profile manifest boundary", () => {
 const invalid: Record<string, unknown>[] = [
  { version: 2 }, { profileDigest: "bad" }, { lockDigest: "bad" }, { imageDigest: "bad" },
  { platform: "linux-amd64" }, { commands: [] }, { commands: [[]] },
  { commands: [[""]] }, { commands: [["bun", "test\u0000injection"]] },
  { commands: "bun test" }, { commands: [["bun", 1]] },
  { credentials: {} }, { approved: true }, { env: {} }, { endpoint: "host" },
 ];
 invalid.forEach((overrides, index) => {
  test(`rejects invalid manifest fixture ${index}`, () => {
   expect(() => validateProfileManifest({ ...profile(), ...overrides })).toThrow();
   expect(() => validateRemoteTestJob(job(), { ...profile(), ...overrides })).toThrow();
  });
 });
 for (const field of Object.keys(profile())) {
  test(`rejects missing manifest ${field}`, () => {
   const input: Record<string, unknown> = profile();
   delete input[field];
   expect(() => validateProfileManifest(input)).toThrow();
  });
 }
});

describe("terminal receipt attribution and exact identity", () => {
 test("accepts a matching complete receipt", () => {
  expect(receiptMatchesRequest(receipt(), job())).toBe(true);
  expect(validateRemoteTestReceipt(receipt(), job())).toEqual(receipt());
 });
 const changes: Record<string, unknown> = {
  version: 2,
  jobId: "9c7e8091-1234-4234-8234-123456789abc",
  correlationId: "ac7e8091-1234-4234-8234-123456789abc",
  repositoryId: "github:github.com/other/repo",
  commitDigest: "1".repeat(40), treeDigest: "2".repeat(40),
  bundleDigest: digest("3"), profileId: "other-profile", profileDigest: digest("4"),
  lockDigest: digest("5"), imageDigest: digest("6"), platform: "linux-amd64",
  deadline: job().deadline + 1, generation: 2,
 };
 for (const [field, value] of Object.entries(changes)) {
  test(`rejects receipt mismatch on ${field}`, () => {
   const input = { ...receipt(), identity: { ...job(), [field]: value } };
   expect(receiptMatchesRequest(input, job())).toBe(false);
   expect(() => validateRemoteTestReceipt(input, job())).toThrow();
  });
 }
 for (const field of Object.keys(job())) {
  test(`rejects partial receipt identity ${field}`, () => {
   const identity: Record<string, unknown> = job();
   delete identity[field];
   const input = { ...receipt(), identity };
   expect(receiptMatchesRequest(input, job())).toBe(false);
   expect(() => validateRemoteTestReceipt(input, job())).toThrow();
  });
 }
 test("compares fields independent of object key insertion order", () => {
  const identity = Object.fromEntries(Object.entries(job()).reverse());
  expect(receiptMatchesRequest({ ...receipt(), identity }, job())).toBe(true);
 });
 test("identity comparison never implies success", () => {
  const input = { ...receipt(), status: "test_failed", exitCode: 1 };
  expect(receiptMatchesRequest(input, job())).toBe(true);
  expect(validateRemoteTestReceipt(input, job()).status).toBe("test_failed");
 });
 for (const status of ["infra_failed", "timed_out", "cancelled", "rejected"] as const) {
  test(`preserves explicit ${status} with no test exit code`, () => {
   expect(validateRemoteTestReceipt({ ...receipt(), status, exitCode: null }, job()).status).toBe(status);
  });
 }
 const invalid: Record<string, unknown>[] = [
  { version: 2 }, { status: "completed" }, { status: "running" },
  { status: "passed", exitCode: null }, { status: "passed", exitCode: 1 },
  { status: "test_failed", exitCode: 0 }, { status: "test_failed", exitCode: null },
  { exitCode: -1 }, { exitCode: 1.5 }, { completedAt: Infinity },
  { completedAt: job().deadline + 1 }, { executorId: "" }, { credentials: {} },
 ];
 invalid.forEach((overrides, index) => {
  test(`rejects invalid terminal receipt fixture ${index}`, () => {
   expect(() => validateRemoteTestReceipt({ ...receipt(), ...overrides }, job())).toThrow();
  });
 });
 test("failure may complete after the deadline", () => {
  expect(validateRemoteTestReceipt({ ...receipt(), status: "timed_out", exitCode: null, completedAt: job().deadline + 1 }, job()).status).toBe("timed_out");
 });
 test("rejects extras inside receipt identity and malformed requests", () => {
  const input = { ...receipt(), identity: { ...job(), credentials: "secret" } };
  expect(receiptMatchesRequest(input, job())).toBe(false);
  expect(() => validateRemoteTestReceipt(input, job())).toThrow();
  expect(receiptMatchesRequest(receipt(), { ...job(), generation: "1" })).toBe(false);
  expect(() => validateRemoteTestReceipt(receipt(), {})).toThrow();
 });
 test("rejects every missing receipt field", () => {
  for (const field of Object.keys(receipt())) {
   const input: Record<string, unknown> = receipt();
   delete input[field];
   expect(() => validateRemoteTestReceipt(input, job())).toThrow();
  }
 });
});

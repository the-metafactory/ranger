import { describe, expect, test } from "bun:test";
import {
 assertNotPrincipal,
 matchWriteTokenEnv,
 resolveWriteToken,
 WriteGateError,
 writeEnv,
} from "../src/identity.ts";
import type { RangerConfig } from "../src/config.ts";

function config(over: Partial<RangerConfig> = {}): RangerConfig {
 return {
  version: 1,
  maps: [],
  auth: { readOnlyTokens: {}, writeTokens: {} },
  bot: {},
  principal: { login: "jcfischer" },
  state: { journalPath: ":memory:", canonicalRoot: "/tmp/repos" },
  workers: { spawnCapPerDay: 10, wallClockMin: 90, maxAttempts: 2, deadmanThreshold: 3 },
  ...over,
 };
}

describe("matchWriteTokenEnv — longest-prefix matching over auth.writeTokens", () => {
 const auth = {
  readOnlyTokens: {},
  writeTokens: {
   "*": "RANGER_WRITE_TOKEN",
   "the-metafactory/*": "RANGER_WRITE_METAFACTORY",
   "jcfischer/seekolous": "RANGER_WRITE_SEEKOLOUS",
  },
 };

 test("exact repo prefix beats wildcard", () => {
  expect(matchWriteTokenEnv(auth, "jcfischer/seekolous")).toBe("RANGER_WRITE_SEEKOLOUS");
 });

 test("org wildcard beats global wildcard", () => {
  expect(matchWriteTokenEnv(auth, "the-metafactory/ranger")).toBe("RANGER_WRITE_METAFACTORY");
 });

 test("unmatched repo falls to global wildcard", () => {
  expect(matchWriteTokenEnv(auth, "someone/else")).toBe("RANGER_WRITE_TOKEN");
 });
});

describe("resolveWriteToken", () => {
 test("resolves from env when set", () => {
  const cfg = config({
   auth: { readOnlyTokens: {}, writeTokens: { "acme/*": "RANGER_WRITE_ACME" } },
  });
  const resolved = resolveWriteToken(cfg, "acme/widgets", { RANGER_WRITE_ACME: "ghp_write" });
  expect(resolved).toEqual({ token: "ghp_write", source: "RANGER_WRITE_ACME" });
 });

 test("unset env → WriteGateError (no fallback)", () => {
  const cfg = config({
   auth: { readOnlyTokens: {}, writeTokens: { "acme/*": "RANGER_WRITE_ACME" } },
  });
  expect(() => resolveWriteToken(cfg, "acme/widgets", {})).toThrow(WriteGateError);
 });

 test("no mapping → WriteGateError naming the fix", () => {
  const cfg = config({});
  expect(() => resolveWriteToken(cfg, "acme/widgets", {})).toThrow(/auth\.writeTokens/);
 });
});

describe("writeEnv", () => {
 test("pins GH_TOKEN + isolates GH_CONFIG_DIR, but does NOT set SOMA_GRAPH_READONLY", () => {
  const { env, cleanup } = writeEnv("ghp_x");
  try {
   expect(env.GH_TOKEN).toBe("ghp_x");
   expect(env.GITHUB_TOKEN).toBe("ghp_x");
   expect(env.SOMA_GRAPH_READONLY).toBeUndefined();
   expect(env.GH_CONFIG_DIR).toBeDefined();
  } finally {
   cleanup();
  }
 });
});

describe("assertNotPrincipal — design §2 mechanical invariant", () => {
 test("refuses a graph-mutating tick under the principal's login", () => {
  const cfg = config();
  expect(() => assertNotPrincipal(cfg, "jcfischer")).toThrow(WriteGateError);
 });

 test("allows a distinct machine-account identity", () => {
  const cfg = config();
  expect(() => assertNotPrincipal(cfg, "ivy-bot")).not.toThrow();
 });

 test("a configured principal login is honored", () => {
  const cfg = config({ principal: { login: "the-boss" } });
  expect(() => assertNotPrincipal(cfg, "the-boss")).toThrow(WriteGateError);
 });
});

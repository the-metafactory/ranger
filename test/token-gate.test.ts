import { describe, expect, test } from "bun:test";
import {
  parseGhHeaders,
  matchTokenEnv,
  resolveReadOnlyToken,
  GateError,
} from "../src/token-gate.ts";
import type { RangerConfig } from "../src/config.ts";

describe("parseGhHeaders", () => {
  test("classic token scopes are parsed from the header block", () => {
    const output = [
      "HTTP/2.0 200 OK",
      "content-type: application/json",
      "x-oauth-scopes: repo, read:org, workflow",
      "",
      '{"login":"jcfischer","id":1}',
    ].join("\n");
    const parsed = parseGhHeaders(output);
    expect(parsed.scopes).toEqual(["repo", "read:org", "workflow"]);
    expect(parsed.login).toBe("jcfischer");
  });

  test("fine-grained token (empty/absent scopes header) → empty scopes", () => {
    const output = [
      "HTTP/2.0 200 OK",
      "content-type: application/json",
      "x-oauth-scopes: ",
      "",
      '{"login":"scout-test"}',
    ].join("\n");
    expect(parseGhHeaders(output).scopes).toEqual([]);
  });

  test("missing header entirely → empty scopes", () => {
    expect(parseGhHeaders("HTTP/2.0 200 OK\n\n{}").scopes).toEqual([]);
  });
});

describe("matchTokenEnv — longest-prefix matching", () => {
  const auth = {
    readOnlyTokens: {
      "*": "RANGER_READONLY_GH_TOKEN",
      "the-metafactory/*": "RANGER_READONLY_GH_TOKEN_METAFACTORY",
      "jcfischer/seekolous": "RANGER_READONLY_GH_TOKEN_SEEKOLOUS",
    },
  };

  test("exact repo prefix beats wildcard", () => {
    expect(matchTokenEnv(auth, "jcfischer/seekolous")).toBe(
      "RANGER_READONLY_GH_TOKEN_SEEKOLOUS",
    );
  });

  test("org wildcard beats global wildcard", () => {
    expect(matchTokenEnv(auth, "the-metafactory/ranger")).toBe(
      "RANGER_READONLY_GH_TOKEN_METAFACTORY",
    );
  });

  test("unmatched repo falls to global wildcard", () => {
    expect(matchTokenEnv(auth, "someone/else")).toBe(
      "RANGER_READONLY_GH_TOKEN",
    );
  });
});

describe("resolveReadOnlyToken", () => {
  const config: RangerConfig = {
    version: 1,
    maps: [],
    auth: {
      readOnlyTokens: { "acme/*": "RANGER_RO_ACME" },
    },
  };

  test("resolves from env when set", () => {
    const resolved = resolveReadOnlyToken(config, "acme/widgets", {
      RANGER_RO_ACME: "github_pat_x",
    });
    expect(resolved).toEqual({
      token: "github_pat_x",
      source: "RANGER_RO_ACME",
    });
  });

  test("unset env → GateError (no keyring fallback)", () => {
    expect(() => resolveReadOnlyToken(config, "acme/widgets", {})).toThrow(
      GateError,
    );
    expect(() => resolveReadOnlyToken(config, "acme/widgets", {})).toThrow(
      /refusing to fall back to the gh keyring/,
    );
  });

  test("no mapping → GateError naming the config fix", () => {
    expect(() => resolveReadOnlyToken(config, "other/repo", {})).toThrow(
      /no read-only token mapping/,
    );
  });
});

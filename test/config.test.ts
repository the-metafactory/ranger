import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config.ts";

function withConfig(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ranger-config-"));
  const path = join(dir, "ranger.yaml");
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  test("parses a valid config and coerces numeric root", () => {
    withConfig(
      [
        "version: 1",
        "maps:",
        "  - repo: acme/widgets",
        "    root: 1",
        "    walk: full",
        "auth:",
        "  readOnlyTokens:",
        '    "acme/*": RANGER_RO_ACME',
      ].join("\n"),
      (path) => {
        const { config } = loadConfig(path);
        expect(config.maps).toHaveLength(1);
        expect(config.maps[0].repo).toBe("acme/widgets");
        expect(config.maps[0].root).toBe(1);
        expect(config.maps[0].walk).toBe("full");
        expect(config.auth.readOnlyTokens["acme/*"]).toBe("RANGER_RO_ACME");
      },
    );
  });

  test("walk defaults to none", () => {
    withConfig(
      ["version: 1", "maps:", "  - repo: acme/widgets", "    root: 1"].join(
        "\n",
      ),
      (path) => {
        expect(loadConfig(path).config.maps[0].walk).toBe("none");
      },
    );
  });

  test("parses optional per-map discord escalation surface", () => {
    withConfig(
      [
        "version: 1",
        "maps:",
        "  - repo: acme/widgets",
        "    root: 1",
        "    discord:",
        "      tokenEnv: RANGER_DISCORD_TOKEN",
        '      channelId: "1234567890123456789"',
      ].join("\n"),
      (path) => {
        const map = loadConfig(path).config.maps[0];
        expect(map.discord?.tokenEnv).toBe("RANGER_DISCORD_TOKEN");
        expect(map.discord?.channelId).toBe("1234567890123456789");
      },
    );
  });

  test("discord without tokenEnv → ConfigError", () => {
    withConfig(
      [
        "version: 1",
        "maps:",
        "  - repo: acme/widgets",
        "    root: 1",
        "    discord:",
        '      channelId: "123"',
      ].join("\n"),
      (path) => {
        expect(() => loadConfig(path)).toThrow(ConfigError);
      },
    );
  });

  test("invalid root type → ConfigError", () => {
    withConfig(
      [
        "version: 1",
        "maps:",
        "  - repo: acme/widgets",
        "    root: not-a-number",
        "    walk: none",
      ].join("\n"),
      (path) => {
        expect(() => loadConfig(path)).toThrow(ConfigError);
      },
    );
  });

  test("missing file → ConfigError", () => {
    expect(() => loadConfig("/nonexistent/ranger.yaml")).toThrow(ConfigError);
  });
});

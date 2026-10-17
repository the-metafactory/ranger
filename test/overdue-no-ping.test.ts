import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseConfigLines, fakeDiscord, runCli } from "./support.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");

/** The principal's Discord id stays set in ranger.yaml and names nothing ranger posts: an overdue card is state, and Vigil's text is the interruption — https://github.com/the-metafactory/soma/issues/787#issuecomment-6126534287 */
const PRINCIPAL_DISCORD_ID = "285727653603049472";

const T0 = new Date("2026-10-01T00:00:00.000Z");

function dayAfter(days: number): string {
  return new Date(T0.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function writeFixtures(dir: string): void {
  writeFileSync(
    join(dir, "acme__widgets-frontier.json"),
    JSON.stringify({
      repo: "acme/widgets",
      root: "1",
      frontier: [
        {
          ref: { id: "31" },
          node: {
            id: "31",
            title: "Settle the overdue card",
            kind: "task",
            checkpointId: "no-ping-shipped",
            autonomy: "propose",
            probes: [],
          },
          status: "open",
          assignees: [],
          blockedBy: [],
          author: "alice",
          url: "https://github.com/acme/widgets/issues/31",
          typed: true,
          parent: { id: "1" },
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, "acme__widgets-audit.json"),
    JSON.stringify({
      repo: "acme/widgets",
      root: "1",
      nodes: 1,
      closedWithoutReceipt: [],
      openWithoutCheckpoint: [],
      openClaimed: [],
    }),
  );
}

function writeConfig(dir: string): string {
  const path = join(dir, "ranger.yaml");
  writeFileSync(
    path,
    [
      ...baseConfigLines(dir),
      "principal:",
      "  login: jcfischer",
      `  discordId: "${PRINCIPAL_DISCORD_ID}"`,
    ].join("\n"),
  );
  return path;
}

function envFor(dir: string, discordPort: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dir,
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discordPort}`,
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5",
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_RO_TEST: "ghp_ro",
  };
}

function escalate(
  config: string,
  dir: string,
  port: number,
  now: string,
  extra: string[] = [],
) {
  return runCli(["escalate", "-c", config, ...extra, "--json"], {
    ...envFor(dir, port),
    RANGER_NOW: now,
  });
}

describe("node #261 — an overdue card never pings the principal", () => {
  test("the 7-day card reads `📣 <N>d old — overdue`, and its edit allows no mention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-overdue-nopng-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(dir);
      const config = writeConfig(dir);
      const fresh = await escalate(config, dir, discord.port, T0.toISOString());
      expect(fresh.code).toBe(0);
      expect(JSON.parse(fresh.stdout).maps[0].posted).toEqual(["31"]);
      const posted = discord.posts.at(-1)!;
      expect(posted.content).not.toContain("📣");
      expect(posted.allowedMentions).toEqual({ parse: [], users: [] });

      const overdue = await escalate(
        config,
        dir,
        discord.port,
        dayAfter(7),
      );
      expect(overdue.code).toBe(0);
      expect(JSON.parse(overdue.stdout).maps[0].edited).toEqual(["31"]);
      const edit = discord.edits.at(-1)!;
      expect(edit.content.endsWith("\n📣 7d old — overdue")).toBe(true);
      expect(edit.content).not.toContain("<@");
      expect(edit.content).not.toContain(PRINCIPAL_DISCORD_ID);
      expect(edit.allowedMentions).toEqual({ parse: [], users: [] });
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the digest card line ends `📣 <N>d`, and its cards line says nothing about pings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-overdue-digest-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(dir);
      const config = writeConfig(dir);
      await escalate(config, dir, discord.port, T0.toISOString());
      const digestRun = await escalate(
        config,
        dir,
        discord.port,
        dayAfter(7),
        ["--digest"],
      );
      expect(digestRun.code).toBe(0);
      expect(JSON.parse(digestRun.stdout).maps[0].kind).toBe("digest");
      const digest = discord.posts.at(-1)!.content;
      const cardLine = digest
        .split("\n")
        .find((line) => line.startsWith("- `#31`"))!;
      expect(cardLine.endsWith("— escalate-hitl · 📣 7d")).toBe(true);
      expect(digest).toContain("Cards: 1 (1 aged 3+d, 1 7+d)");
      expect(digest).not.toContain("@-mentioned");
      expect(digest).not.toContain("no ping");
      expect(digest).not.toContain("<@");
      expect(digest).not.toContain(PRINCIPAL_DISCORD_ID);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an aging (3-6d) or fresh card's content is unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-overdue-band-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(dir);
      const config = writeConfig(dir);
      await escalate(config, dir, discord.port, T0.toISOString());
      const fresh = discord.posts.at(-1)!.content;
      expect(fresh.split("\n").at(-1)).not.toContain("📣");

      await escalate(config, dir, discord.port, dayAfter(4));
      const aged = discord.edits.at(-1)!;
      expect(
        aged.content.endsWith(
          "\n⚠️ 4d old — aging; blocked-descendant count unavailable " +
            "(read-only surface can't enumerate blocked nodes)",
        ),
      ).toBe(true);
      expect(aged.allowedMentions).toEqual({ parse: [], users: [] });

      const editsBefore = discord.edits.length;
      const repeat = await escalate(config, dir, discord.port, dayAfter(4));
      expect(JSON.parse(repeat.stdout).maps[0].edited).toEqual([]);
      expect(discord.edits).toHaveLength(editsBefore);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
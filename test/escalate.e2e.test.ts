import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { Journal } from "../src/journal.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const bun = process.execPath;

function writeConfig(dir: string): string {
  const config = [
    "version: 1",
    "maps:",
    "  - repo: acme/widgets",
    "    root: 1",
    "    walk: research-only",
    "    discord:",
    "      tokenEnv: RANGER_DISCORD_TOKEN",
    '      channelId: "1234567890"',
    "auth:",
    "  readOnlyTokens:",
    '    "acme/*": RANGER_RO_TEST',
    "bot:",
    "  identity: ivy-bot",
    "principal:",
    "  login: jcfischer",
    "state:",
    `  journalPath: ${join(dir, "state.sqlite")}`,
    "workers:",
    "  spawnCapPerDay: 10",
  ].join("\n");
  const path = join(dir, "ranger.yaml");
  writeFileSync(path, config);
  return path;
}

/** Frontier with four HITL/provisioning nodes (11 propose, 12 grilling, 13 untyped, 14 provisioning). */
function writeFixtures(dir: string, drop: string[] = []): string {
  const nodes = [
    {
      ref: { id: "11" },
      node: {
        id: "11",
        title: "Ship billing integration",
        kind: "task",
        checkpointId: "billing-shipped",
        autonomy: "propose",
        probes: [],
      },
      status: "open",
      assignees: [],
      blockedBy: [],
      author: "alice",
      url: "https://github.com/acme/widgets/issues/11",
      typed: true,
      parent: { id: "1" },
    },
    {
      ref: { id: "12" },
      node: {
        id: "12",
        title: "Draft UX copy",
        kind: "grilling",
        checkpointId: "copy-drafted",
        autonomy: "auto",
        probes: [],
      },
      status: "open",
      assignees: [],
      blockedBy: [],
      author: "alice",
      url: "https://github.com/acme/widgets/issues/12",
      typed: true,
      parent: { id: "1" },
    },
    {
      ref: { id: "13" },
      node: {
        id: "13",
        title: "Untyped mystery node",
        kind: "task",
        checkpointId: "",
        autonomy: "approve",
        probes: [],
      },
      status: "open",
      assignees: [],
      blockedBy: [],
      author: "alice",
      url: "https://github.com/acme/widgets/issues/13",
      typed: false,
      parent: { id: "1" },
    },
    {
      ref: { id: "14" },
      node: {
        id: "14",
        title: "Provision the staging env",
        kind: "task",
        checkpointId: "staging-provisioned",
        autonomy: "auto",
        probes: [{ type: "command", run: "bun test", cwd: "/tmp/not-declared" }],
      },
      status: "open",
      assignees: [],
      blockedBy: [],
      author: "alice",
      url: "https://github.com/acme/widgets/issues/14",
      typed: true,
      parent: { id: "1" },
    },
  ].filter((n) => !drop.includes(n.ref.id));

  writeFileSync(
    join(dir, "acme__widgets-frontier.json"),
    JSON.stringify({ repo: "acme/widgets", root: "1", frontier: nodes }, null, 2),
  );
  writeFileSync(
    join(dir, "acme__widgets-audit.json"),
    JSON.stringify(
      {
        repo: "acme/widgets",
        root: "1",
        nodes: 16,
        closedWithoutReceipt: ["7", "8"],
        openWithoutCheckpoint: ["9"],
        openClaimed: [{ id: "16", assignees: ["alice"] }],
      },
      null,
      2,
    ),
  );
  return dir;
}

/** Fake Discord: records POST (new card) and PATCH (edit) with message id + body. */
function fakeDiscord() {
  const posts: { messageId: string; content: string }[] = [];
  const edits: { messageId: string; content: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname.startsWith("/channels/")) {
        const parsed = (await req.json()) as { content?: string };
        const messageId = `msg-${posts.length + 1}`;
        posts.push({ messageId, content: parsed?.content ?? "" });
        return Response.json({ id: messageId });
      }
      const editMatch = url.pathname.match(
        /^\/channels\/[^/]+\/messages\/([^/]+)$/,
      );
      if (req.method === "PATCH" && editMatch) {
        const messageId = editMatch[1];
        const parsed = (await req.json()) as { content?: string };
        edits.push({ messageId, content: parsed?.content ?? "" });
        return Response.json({ id: messageId });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port as number,
    posts,
    edits,
    stop: () => server.stop(true),
  };
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = join(import.meta.dir, ".."),
) {
  return runCmd(bun, [cliPath, ...args], { env, cwd });
}

function envFor(dir: string, discordPort: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dir,
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discordPort}`,
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_RO_TEST: "ghp_ro",
  };
}

describe("ranger escalate — escalation desk (design §5, node #20)", () => {
  test("posts one card per HITL/provisioning node, edits-not-reposts on a second run, resolves a node that leaves the queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      // First run: announce-once — one POST per card.
      const run1 = await runCli(["escalate", "-c", config, "--json"], env);
      expect(run1.code).toBe(0);
      const report1 = JSON.parse(run1.stdout);
      expect(report1.maps[0].posted.sort()).toEqual(["11", "12", "13", "14"]);
      expect(report1.maps[0].edited).toEqual([]);
      expect(discord.posts).toHaveLength(4);
      // Cards carry the right heads + age + principal mention on content.
      const joined = discord.posts.map((p) => p.content).join("\n");
      expect(joined).toContain("**Decision needed**");
      expect(joined).toContain("**HITL decision**");
      expect(joined).toContain("**Needs typing**");
      expect(joined).toContain("**Provisioning needed**");
      expect(joined).toContain("· 0d");

      const journal = new Journal(join(dir, "state.sqlite"));
      expect(journal.listEscalations("acme/widgets")).toHaveLength(4);
      expect(
        journal.listEscalations("acme/widgets").every((r) => r.status === "open"),
      ).toBe(true);
      journal.close();

      // Second run, unchanged frontier: edit-not-repost — no new POSTs.
      const run2 = await runCli(["escalate", "-c", config, "--json"], env);
      const report2 = JSON.parse(run2.stdout);
      expect(report2.maps[0].posted).toEqual([]);
      expect(report2.maps[0].edited.sort()).toEqual(["11", "12", "13", "14"]);
      expect(discord.posts).toHaveLength(4); // unchanged — nothing reposted
      expect(discord.edits.length).toBeGreaterThanOrEqual(4);

      // Third run: node 12 leaves the queue → its card resolves, others edit.
      writeFixtures(fixtureDir, ["12"]);
      const run3 = await runCli(["escalate", "-c", config, "--json"], env);
      const report3 = JSON.parse(run3.stdout);
      expect(report3.maps[0].resolved).toEqual(["12"]);
      expect(report3.maps[0].posted).toEqual([]);
      const j2 = new Journal(join(dir, "state.sqlite"));
      expect(j2.getEscalation("acme/widgets", "12")?.status).toBe("resolved");
      expect(j2.getEscalation("acme/widgets", "11")?.status).toBe("open");
      j2.close();
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("digest posts once per day and edits-not-reposts the same day, carrying cards + audit + budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-digest-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-digest-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      // Prime the cards.
      const cards = await runCli(["escalate", "-c", config, "--json"], env);
      expect(JSON.parse(cards.stdout).maps[0].posted).toHaveLength(4);

      const digest1 = await runCli(
        ["escalate", "--digest", "-c", config, "--json"],
        env,
      );
      expect(digest1.code).toBe(0);
      const d1 = JSON.parse(digest1.stdout);
      expect(d1.maps[0].posted).toBe(true);
      expect(d1.maps[0].cards).toHaveLength(4);
      const content = discord.posts.at(-1)?.content ?? "";
      expect(content).toContain("ranger digest");
      expect(content).toContain("Cards: 4");
      expect(content).toContain("receipt-less closes 2");
      expect(content).toContain("spawns today 0/10");

      const postsBefore = discord.posts.length;
      const digest2 = await runCli(
        ["escalate", "--digest", "-c", config, "--json"],
        env,
      );
      const d2 = JSON.parse(digest2.stdout);
      expect(d2.maps[0].posted).toBe(false); // same day → edited, not reposted
      expect(discord.posts.length).toBe(postsBefore); // no new digest message
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

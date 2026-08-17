import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { EscalationDiscord } from "../src/escalate.ts";
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
      body: "Should we ship the copy now or wait for the brand refresh? <@1234567890>",
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
        probes: [
          { type: "command", run: "bun test", cwd: "/tmp/not-declared" },
        ],
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
    JSON.stringify(
      { repo: "acme/widgets", root: "1", frontier: nodes },
      null,
      2,
    ),
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
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5", // keep e2e fast
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
      // Grilling cards carry the question body (design §5 decision payload).
      expect(joined).toContain(
        "Should we ship the copy now or wait for the brand refresh?",
      );
      // Graph-derived mention syntax is inerted (`<` → `‹`), so a node body
      // can't force a ping outside the 7-day policy (review fix).
      expect(joined).not.toContain("<@1234567890>");
      expect(joined).toContain("‹@1234567890");
      // Provisioning cards carry the exact probe run+cwd for the principal
      // to paste into the registry (design §5 actionable provisioning).
      expect(joined).toContain("run `bun test`");
      expect(joined).toContain("cwd `/tmp/not-declared`");

      const journal = new Journal(join(dir, "state.sqlite"));
      expect(journal.listEscalations("acme/widgets")).toHaveLength(4);
      expect(
        journal
          .listEscalations("acme/widgets")
          .every((r) => r.status === "open"),
      ).toBe(true);
      // The §3 route is persisted so the digest can render it (review fix).
      expect(journal.getEscalation("acme/widgets", "14")?.route).toBe(
        "provisioning",
      );
      expect(journal.getEscalation("acme/widgets", "12")?.route).toBe(
        "escalate-hitl",
      );
      journal.close();
      // The announce-once lock is released after the run (no stale lock).
      expect(existsSync(join(dir, ".escalate.lock"))).toBe(false);

      // Second run, unchanged frontier: content is identical → edit-on-change
      // skips every card (no posts, no edits — no needless Discord writes).
      const run2 = await runCli(["escalate", "-c", config, "--json"], env);
      const report2 = JSON.parse(run2.stdout);
      expect(report2.maps[0].posted).toEqual([]);
      expect(report2.maps[0].edited).toEqual([]);
      expect(discord.posts).toHaveLength(4); // unchanged — nothing reposted
      expect(discord.edits).toHaveLength(0); // no-op edits skipped

      // A content change DOES edit in place: bump the age to day 1 (the age
      // suffix renders `· 1d`, so every card's content differs).
      const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const ageRun = await runCli(
        ["escalate", "-c", config, "--json"],
        { ...env, RANGER_NOW: later.toISOString() },
      );
      const ageReport = JSON.parse(ageRun.stdout);
      expect(ageReport.maps[0].posted).toEqual([]);
      expect(ageReport.maps[0].edited.sort()).toEqual(["11", "12", "13", "14"]);
      expect(discord.posts).toHaveLength(4); // still no new posts

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
      // The digest renders the persisted route, not the node id (review fix).
      expect(content).toContain("#14 Provision the staging env — provisioning");
      expect(content).toContain("#12 Draft UX copy — escalate-hitl");

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

  test("two overlapping runs do not duplicate cards (announce-once lock)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-lock-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-lock-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      const [run1, run2] = await Promise.all([
        runCli(["escalate", "-c", config, "--json"], env),
        runCli(["escalate", "-c", config, "--json"], env),
      ]);
      expect(run1.code).toBe(0);
      expect(run2.code).toBe(0);
      // The lock serializes the runs: exactly one announce pass, the second
      // run edits in place — 4 posts, never 8.
      expect(discord.posts).toHaveLength(4);
      const journal = new Journal(join(dir, "state.sqlite"));
      expect(journal.listEscalations("acme/widgets")).toHaveLength(4);
      journal.close();
      expect(existsSync(join(dir, ".escalate.lock"))).toBe(false);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("reclaims a stale announce-once lock left by a dead owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-stale-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-stale-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      // Simulate a killed run: the lock file with an owner whose pid is dead
      // and whose startedAt is old. A live run must reclaim it, not wait 60s.
      const lockFile = join(dir, ".escalate.lock");
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 2_000_000_000, // out of pid range → ESRCH on kill(pid, 0)
          startedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
        }),
      );

      const run = await runCli(["escalate", "-c", config, "--json"], env);
      expect(run.code).toBe(0);
      const report = JSON.parse(run.stdout);
      expect(report.maps[0].posted).toHaveLength(4);
      expect(existsSync(lockFile)).toBe(false); // released after the run
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("rejects a non-discord/non-localhost RANGER_DISCORD_API_BASE (token-exfil guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-evil-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-evil-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);

      // A non-loopback host is refused even with the test sentinel set.
      const evil = await runCli(["escalate", "-c", config, "--json"], {
        ...envFor(fixtureDir, discord.port),
        RANGER_DISCORD_API_BASE: "http://evil.example",
      });
      expect(evil.code).toBe(2); // maps failed → exit 2
      const evilReport = JSON.parse(evil.stdout);
      expect(evilReport.maps[0].ok).toBe(false);
      expect(evilReport.maps[0].error).toContain("not allowed");
      expect(discord.posts).toHaveLength(0);

      // Loopback without the explicit test sentinel is refused too — an
      // injected override cannot exfiltrate the token to a local listener.
      const unsentineled = await runCli(["escalate", "-c", config, "--json"], {
        ...envFor(fixtureDir, discord.port),
        RANGER_DISCORD_ALLOW_TEST_OVERRIDE: undefined,
      });
      expect(unsentineled.code).toBe(2);
      const unSent = JSON.parse(unsentineled.stdout);
      expect(unSent.maps[0].ok).toBe(false);
      expect(unSent.maps[0].error).toContain("not allowed");
      expect(discord.posts).toHaveLength(0);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("retries a 429 rate-limit response before giving up", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        return Response.json({ id: "retried-ok" });
      },
    });
    try {
      const client = new EscalationDiscord(
        "tok",
        "chan",
        `http://127.0.0.1:${server.port}`,
      );
      const id = await client.post("hello");
      expect(id).toBe("retried-ok");
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("throttle reserves slots so concurrent posts do not burst", async () => {
    const arrivals: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch() {
        arrivals.push(Date.now());
        await new Promise((r) => setTimeout(r, 5));
        return Response.json({ id: `m-${arrivals.length}` });
      },
    });
    try {
      const client = new EscalationDiscord(
        "tok",
        "chan",
        `http://127.0.0.1:${server.port}`,
      );
      await Promise.all([
        client.post("a"),
        client.post("b"),
        client.post("c"),
      ]);
      // Slots are reserved 1s apart before any awaits, so the three arrivals
      // must be spaced ~1s, never a [0, ~0, ~1s] burst.
      expect(arrivals).toHaveLength(3);
      const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
      expect(gaps[0]).toBeGreaterThanOrEqual(900);
      expect(gaps[1]).toBeGreaterThanOrEqual(900);
    } finally {
      server.stop(true);
    }
  });
});

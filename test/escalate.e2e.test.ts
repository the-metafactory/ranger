import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EscalationDiscord } from "../src/escalate.ts";
import { Journal } from "../src/journal.ts";
import { baseConfigLines, fakeDiscord, runCli } from "./support.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");

function writeConfig(dir: string, discordId?: string): string {
  const config = [
    ...baseConfigLines(dir),
    "principal:",
    "  login: jcfischer",
    ...(discordId === undefined ? [] : [`  discordId: "${discordId}"`]),
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
        title: "Draft UX copy <@1234567890>",
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
/** Fake Discord server: records POSTs and PATCHes for assertion (shared from ./support.ts). */

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
      if (run2.code !== 0 || run2.stderr.length > 0) {
        console.error(
          "[flaky-diag] run2 code=",
          run2.code,
          "stdout=",
          run2.stdout.slice(0, 200),
          "stderr=",
          run2.stderr.slice(0, 800),
        );
      }
      const report2 = JSON.parse(run2.stdout);
      expect(report2.maps[0].posted).toEqual([]);
      expect(report2.maps[0].edited).toEqual([]);
      expect(discord.posts).toHaveLength(4); // unchanged — nothing reposted
      expect(discord.edits).toHaveLength(0); // no-op edits skipped

      // A content change DOES edit in place: bump the age to day 1 (the age
      // suffix renders `· 1d`, so every card's content differs).
      const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const ageRun = await runCli(["escalate", "-c", config, "--json"], {
        ...env,
        RANGER_NOW: later.toISOString(),
      });
      const ageReport = JSON.parse(ageRun.stdout);
      expect(ageReport.maps[0].posted).toEqual([]);
      expect(ageReport.maps[0].edited.sort()).toEqual(["11", "12", "13", "14"]);
      expect(discord.posts).toHaveLength(4); // still no new posts

      // Third run: node 12 leaves the queue → its card is edited to a "no
      // longer on queue" note but KEPT OPEN (design §5 — cards persist until
      // a principal response or operator verb resolves them; leaving the
      // frontier is not a resolution).
      writeFixtures(fixtureDir, ["12"]);
      const run3 = await runCli(["escalate", "-c", config, "--json"], env);
      const report3 = JSON.parse(run3.stdout);
      expect(report3.maps[0].keptOpen).toEqual(["12"]);
      expect(report3.maps[0].posted).toEqual([]);
      const j2 = new Journal(join(dir, "state.sqlite"));
      expect(j2.getEscalation("acme/widgets", "12")?.status).toBe("open");
      expect(j2.getEscalation("acme/widgets", "12")?.lastContent).toContain(
        "no longer on the HITL/provisioning queue",
      );
      // The absent-card note inertes mention syntax too (a graph title can't
      // ping the principal on resolve — review fix).
      expect(j2.getEscalation("acme/widgets", "12")?.lastContent).not.toContain(
        "<@1234567890>",
      );
      expect(j2.getEscalation("acme/widgets", "12")?.lastContent).toContain(
        "‹@1234567890",
      );
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
      expect(content).toContain(
        "#12 Draft UX copy ‹@1234567890> — escalate-hitl",
      );

      const postsBefore = discord.posts.length;
      const editsBefore = discord.edits.length;
      const digest2 = await runCli(
        ["escalate", "--digest", "-c", config, "--json"],
        env,
      );
      const d2 = JSON.parse(digest2.stdout);
      expect(d2.maps[0].posted).toBe(false); // same day → edited, not reposted
      expect(discord.posts.length).toBe(postsBefore); // no new digest message
      // Edit-on-change: unchanged same-day content is a no-op — re-running
      // the digest must not churn Discord writes (review fix).
      expect(discord.edits.length).toBe(editsBefore);
      expect(d2.maps[0].digestMessageId).toBe(d1.maps[0].digestMessageId);

      // A DELETED unchanged digest message is recovered on the next no-op
      // run: the unchanged path verifies the message still exists (GET) and
      // reposts when it is definitively gone — the daily summary never
      // silently vanishes until the next day (round-16 review fix).
      const deletedDigestId = d1.maps[0].digestMessageId;
      discord.deleteMessage(deletedDigestId);
      const postsAfterDelete = discord.posts.length;
      const digest3 = await runCli(
        ["escalate", "--digest", "-c", config, "--json"],
        env,
      );
      const d3 = JSON.parse(digest3.stdout);
      expect(d3.maps[0].posted).toBe(true); // reposted after the delete
      expect(discord.posts.length).toBe(postsAfterDelete + 1); // one fresh digest
      expect(d3.maps[0].digestMessageId).not.toBe(deletedDigestId);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("digest reserves room for audit + budget when card titles are long (review fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-digest-long-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-digest-long-fx-"));
    const discord = fakeDiscord();
    try {
      // Five HITL nodes with very long titles — enough that an un-reserved
      // digest would tail-slice the audit + budget sections.
      const longTitle = (n: string) =>
        `This is an extremely long decision title for node ${n} that stretches far beyond a normal card title ` +
        `so the assembled card list consumes most of the Discord message budget and forces the budget-driven card cap to engage `.repeat(3) +
        `(end of node ${n} title)`;
      const nodes = Array.from({ length: 5 }, (_, i) => {
        const id = String(21 + i);
        return {
          ref: { id },
          node: {
            id,
            title: longTitle(id),
            kind: "grilling",
            checkpointId: "decide",
            autonomy: "propose",
            probes: [],
          },
          status: "open",
          assignees: [],
          blockedBy: [],
          author: "alice",
          url: `https://github.com/acme/widgets/issues/${id}`,
          typed: true,
          parent: { id: "1" },
        };
      });
      writeFileSync(
        join(fixtureDir, "acme__widgets-frontier.json"),
        JSON.stringify({ repo: "acme/widgets", root: "1", frontier: nodes }),
      );
      writeFileSync(
        join(fixtureDir, "acme__widgets-audit.json"),
        JSON.stringify({
          repo: "acme/widgets",
          root: "1",
          nodes: 16,
          closedWithoutReceipt: ["7", "8"],
          openWithoutCheckpoint: ["9"],
          openClaimed: [{ id: "16", assignees: ["alice"] }],
        }),
      );
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      const cards = await runCli(["escalate", "-c", config, "--json"], env);
      expect(JSON.parse(cards.stdout).maps[0].posted).toHaveLength(5);

      const digest = await runCli(["escalate", "--digest", "-c", config, "--json"], env);
      expect(digest.code).toBe(0);
      const content = discord.posts.at(-1)?.content ?? "";
      // The promised sections survive a long card list.
      expect(content).toContain("**Audit:** receipt-less closes");
      expect(content).toContain("**Budget:** spawns today");
      // The card list was capped to fit (not the tail sliced off).
      expect(content).toMatch(/more open cards \(full list in the thread\)/);
      expect(content.length).toBeLessThanOrEqual(1950);
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

  test("reclaims a lock whose pid is ALIVE but stale — the age arm catches PID-reuse (round-19 blocker)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-reuse-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-reuse-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      // The dead process's pid got reused by an unrelated ALIVE process (here:
      // the test runner) — a PID-only check would treat this lock as live
      // forever and strand the desk (every tick times out). The startedAt is
      // older than LOCK_STALE_MS, so the age arm reclaims it.
      const lockFile = join(dir, ".escalate.lock");
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid, // alive right now — kill(pid, 0) succeeds
          startedAt: Date.now() - 40 * 60 * 1000, // > 30min stale
        }),
      );

      const run = await runCli(["escalate", "-c", config, "--json"], env);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.stdout).maps[0].posted).toHaveLength(4);
      expect(existsSync(lockFile)).toBe(false); // reclaimed + released
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("a stale reclaim marker from a crashed reclaim does not strand the desk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-marker-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-marker-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const config = writeConfig(dir);
      const env = envFor(fixtureDir, discord.port);

      // A crashed reclaim leaves BOTH a dead lock and a stale `.reclaiming`
      // marker whose owner is dead. The desk must not strand forever (EEXIST
      // on the marker): the stale marker is cleaned up and the dead lock
      // reclaimed (round-13 review fix).
      const lockFile = join(dir, ".escalate.lock");
      const marker = `${lockFile}.reclaiming`;
      const deadPid = 2_000_000_000; // ESRCH on kill(pid, 0)
      writeFileSync(
        lockFile,
        JSON.stringify({ pid: deadPid, startedAt: Date.now() - 60_000 }),
      );
      writeFileSync(
        marker,
        JSON.stringify({ pid: deadPid, at: Date.now() - 60_000 }),
      );

      const run = await runCli(["escalate", "-c", config, "--json"], env);
      expect(run.code).toBe(0);
      const report = JSON.parse(run.stdout);
      expect(report.maps[0].posted).toHaveLength(4); // not stranded
      expect(existsSync(lockFile)).toBe(false); // released after the run
      expect(existsSync(marker)).toBe(false); // stale marker cleaned up
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("mention syntax in kind/url is inerted, and the overdue suffix survives a huge decision body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-suffix-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-suffix-fx-"));
    const discord = fakeDiscord();
    try {
      // One grilling node: kind + url embed `<@1234567890>` (a graph author
      // trying to ping the principal outside the 7-day policy) and the body
      // (entry top level) is huge to force the front-cap to engage.
      const node = {
        ref: { id: "31" },
        node: {
          id: "31",
          title: "Decision with mention",
          kind: "<@1234567890>",
          checkpointId: "decide",
          autonomy: "propose",
          probes: [],
        },
        status: "open",
        assignees: [],
        blockedBy: [],
        author: "alice",
        url: "https://github.com/acme/widgets/issues/<@1234567890>",
        typed: true,
        parent: { id: "1" },
        body: "This is the full grilling question and its options. ".repeat(120),
      };
      writeFileSync(
        join(fixtureDir, "acme__widgets-frontier.json"),
        JSON.stringify({ repo: "acme/widgets", root: "1", frontier: [node] }),
      );
      writeFileSync(
        join(fixtureDir, "acme__widgets-audit.json"),
        JSON.stringify({
          repo: "acme/widgets",
          root: "1",
          nodes: 2,
          closedWithoutReceipt: [],
          openWithoutCheckpoint: [],
          openClaimed: [],
        }),
      );
      const config = writeConfig(dir, "999"); // principal.discordId → pings
      const env = envFor(fixtureDir, discord.port);
      const run1 = await runCli(["escalate", "-c", config, "--json"], env);
      expect(JSON.parse(run1.stdout).maps[0].posted).toHaveLength(1);

      // A week later the age band is overdue: content changes → edit in
      // place. Assert kind/url mentions are inerted and the `<@id>` suffix
      // survives the 1950-char front-cap.
      const later = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const run2 = await runCli(["escalate", "-c", config, "--json"], {
        ...env,
        RANGER_NOW: later.toISOString(),
      });
      expect(JSON.parse(run2.stdout).maps[0].edited).toEqual(["31"]);
      const content = discord.edits.at(-1)?.content ?? "";
      expect(content).not.toContain("<@1234567890>");
      expect(content).toContain("‹@1234567890");
      // The overdue suffix — including the `<@id>` ping — survives the
      // 1950-char front-cap (round-13 review fix).
      expect(content).toContain("📣 <@999>");
      expect(content.endsWith("**7d** — needs your attention")).toBe(true);
      expect(content.length).toBeLessThanOrEqual(1950);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("a map whose Discord channel moves reposts cards in the new channel (destination persisted)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-move-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-move-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const writeCfg = (channelId: string) => {
        const config = [
          ...baseConfigLines(dir, { channelId }),
          "principal:",
          "  login: jcfischer",
        ].join("\n");
        const p = join(dir, "ranger.yaml");
        writeFileSync(p, config);
        return p;
      };
      const env = envFor(fixtureDir, discord.port);

      const run1 = await runCli(
        ["escalate", "-c", writeCfg("1234567890"), "--json"],
        env,
      );
      expect(JSON.parse(run1.stdout).maps[0].posted).toHaveLength(4);

      // The map moves to a new channel: the persisted destination differs →
      // cards are reposted fresh there (announce-once per destination), and
      // the journal rows track the new channel (round-14 review fix).
      const run2 = await runCli(
        ["escalate", "-c", writeCfg("9999999999"), "--json"],
        env,
      );
      const report2 = JSON.parse(run2.stdout);
      expect(report2.maps[0].posted).toHaveLength(4); // reposted, new channel
      expect(report2.maps[0].edited).toEqual([]);
      const j = new Journal(join(dir, "state.sqlite"));
      for (const id of ["11", "12", "13", "14"]) {
        expect(j.getEscalation("acme/widgets", id)?.channelId).toBe(
          "9999999999",
        );
      }
      j.close();
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("a map that moves A→B→A recovers its original cards (no duplicates)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-escalate-aba-"));
    const fixtureDir = mkdtempSync(join(tmpdir(), "ranger-escalate-aba-fx-"));
    const discord = fakeDiscord();
    try {
      writeFixtures(fixtureDir);
      const writeCfg = (channelId: string) => {
        const p = join(dir, "ranger.yaml");
        writeFileSync(
          p,
          [
            ...baseConfigLines(dir, { channelId }),
            "principal:",
            "  login: jcfischer",
          ].join("\n"),
        );
        return p;
      };
      const env = envFor(fixtureDir, discord.port);
      const cardsAt = (channel: string) =>
        runCli(["escalate", "-c", writeCfg(channel), "--json"], env);

      // Snowflake-shaped channel ids: "A" = 1234567890, "B" = 9999999999.
      const r1 = await cardsAt("1234567890");
      expect(JSON.parse(r1.stdout).maps[0].posted).toHaveLength(4);
      const aMessageIds = new Journal(join(dir, "state.sqlite"))
        .listEscalations("acme/widgets")
        .map((r) => r.messageId)
        .sort();

      // Move to B: fresh cards in the new channel (messages 5-8).
      const r2 = await cardsAt("9999999999");
      expect(JSON.parse(r2.stdout).maps[0].posted).toHaveLength(4);
      const postsAfterB = discord.posts.length; // 8

      // Move back to A: the ORIGINAL messages are recovered — edited, NOT
      // reposted (no duplicate card in A).
      const r3 = await cardsAt("1234567890");
      const report3 = JSON.parse(r3.stdout);
      expect(report3.maps[0].posted).toHaveLength(0); // no new posts
      expect(discord.posts.length).toBe(postsAfterB); // 8, unchanged
      expect(report3.maps[0].edited).toHaveLength(4); // recovered + edited
      const j = new Journal(join(dir, "state.sqlite"));
      const backMessageIds = j
        .listEscalations("acme/widgets")
        .map((r) => r.messageId)
        .sort();
      expect(backMessageIds).toEqual(aMessageIds); // original A ids recovered
      j.close();
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
      await Promise.all([client.post("a"), client.post("b"), client.post("c")]);
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

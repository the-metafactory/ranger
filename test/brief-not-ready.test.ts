import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTick } from "../src/candidates.ts";
import { readFrontier } from "../src/frontier-cache.ts";
import { graphAudit, GraphError } from "../src/graph.ts";
import { Journal } from "../src/journal.ts";
import { classifyFrontier } from "../src/route.ts";
import { baseConfigLines, fakeDiscord, fixturesBin, runCli } from "./support.ts";

/**
 * Node #154: ranger never takes an open build node that soma's
 * `graph audit --json` lists under `buildBriefNotReady` (soma#753), escalates
 * it with one card naming what is missing, and takes it once the audit stops
 * listing it. Driven by audit JSON fixtures through the fake soma: the
 * planner through the tick's own read (readFrontier → classifyFrontier →
 * planTick), the desk through `ranger escalate`.
 */

const REPO = "acme/widgets";
const TOKEN = { token: "ghp_write", source: "write-token" };
const POLICY = { floor: 1000, cooldownMs: 10 * 60_000 };
const MAP = { repo: REPO, root: 1, walk: "full" as const };
const REGISTRY = {};

function entry(id: string, kind: string, title = `Node ${id}`) {
  return {
    ref: { id },
    node: { id, title, kind, checkpointId: `cp-${id}`, autonomy: "auto", probes: [] },
    status: "open",
    assignees: [],
    blockedBy: [],
    author: "alice",
    url: `https://github.com/acme/widgets/issues/${id}`,
    typed: true,
    parent: { id: "1" },
  };
}

/** 21 and 22 are build nodes, 23 a task, 24 research. */
function writeFrontier(dir: string): void {
  writeFileSync(
    join(dir, "acme__widgets-frontier.json"),
    JSON.stringify({
      repo: REPO,
      root: "1",
      frontier: [entry("21", "build", "Build the widget"), entry("22", "build"), entry("23", "task"), entry("24", "research")],
    }),
  );
}

/** The audit fixture; `notReady` undefined writes an older soma's audit (no field). */
function writeAudit(dir: string, notReady?: unknown): void {
  writeFileSync(
    join(dir, "acme__widgets-audit.json"),
    JSON.stringify({
      repo: REPO,
      root: "1",
      nodes: 5,
      closedWithoutReceipt: [],
      openWithoutCheckpoint: [],
      openClaimed: [],
      ...(notReady === undefined ? {} : { buildBriefNotReady: notReady }),
    }),
  );
}

const MISSING_21 = { id: "21", missing: ["## Acceptance criteria", "[NEEDS CLARIFICATION]"] };

describe("the tick planner holds a build node soma's audit reports not ready", () => {
  let dir: string;
  let journal: Journal;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PATH", "FAKE_SOMA_DIR"];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), "ranger-brief-"));
    process.env.PATH = `${fixturesBin}:${saved.PATH ?? ""}`;
    process.env.FAKE_SOMA_DIR = dir;
    journal = new Journal(join(dir, "state.sqlite"));
    writeFrontier(dir);
  });

  afterEach(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** One tick's read and plan, the way walk.ts does it. */
  const plan = async (laneBusy = false) => {
    const read = await readFrontier({
      journal, repo: REPO, root: 1, token: TOKEN, policy: POLICY, maxAgeMs: 60 * 60_000, now: new Date(),
    });
    const classified = classifyFrontier(read.frontier.frontier, MAP, REGISTRY, "ivy-bot", read.briefs);
    return { read, classified, plan: planTick(classified, { laneBusy, vetoed: () => false }) };
  };
  const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);

  test("a listed build node is not claimed and not counted as taken: the next build node is", async () => {
    writeAudit(dir, [MISSING_21]);
    const { classified, plan: p } = await plan();
    expect(classified.find((n) => n.id === "21")?.route).toEqual({ route: "brief-not-ready", missing: MISSING_21.missing });
    expect(ids(p.implement)).toEqual(["22"]);
    expect(ids(p.take)).toEqual(["22", "24"]);
    // With the lane busy, the node the tick waits for is not the held one either.
    expect((await plan(true)).plan.waiting?.id).toBe("22");
  });

  test("once the body is fixed and the audit no longer lists it, the node is claimable", async () => {
    writeAudit(dir, [MISSING_21]);
    expect(ids((await plan()).plan.take)).not.toContain("21");
    // The fix changes the graph, so the sentinel moves and the tick re-reads.
    writeAudit(dir, []);
    const { read, plan: p } = await plan();
    expect(read.source).toBe("fresh");
    expect(ids(p.take)).toEqual(["21", "24"]);
  });

  test("the cached read keeps the audit: an unchanged map stays held without another audit", async () => {
    writeAudit(dir, [MISSING_21]);
    await plan();
    const { read, plan: p } = await plan();
    expect(read.source).toBe("cache");
    expect(read.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
    expect(ids(p.take)).toEqual(["22", "24"]);
  });

  test("an audit without buildBriefNotReady (an older soma) refuses nothing", async () => {
    writeAudit(dir);
    const { read, classified, plan: p } = await plan();
    expect(read.briefs).toEqual({ ok: true, notReady: [] });
    const without = classifyFrontier(read.frontier.frontier, MAP, REGISTRY, "ivy-bot");
    expect(classified).toEqual(without);
    expect(ids(p.take)).toEqual(["21", "24"]);
  });

  test("a listed node of any kind other than build is unchanged", async () => {
    writeAudit(dir, [{ id: "23", missing: ["## Deliverable"] }, { id: "24", missing: ["## Deliverable"] }]);
    const { read, classified } = await plan();
    const without = classifyFrontier(read.frontier.frontier, MAP, REGISTRY, "ivy-bot");
    expect(classified).toEqual(without);
  });

  test("an unreadable or malformed audit holds build nodes only, and is not cached", async () => {
    writeAudit(dir, [{ id: 21, missing: "## Deliverable" }]);
    const { read, plan: p } = await plan();
    expect(read.briefs.ok).toBe(false);
    // Both build nodes wait; the task node takes the implement slot.
    expect(ids(p.take)).toEqual(["23", "24"]);
    expect((await plan()).read.source).toBe("fresh");
  });
});

describe("graphAudit parses soma#753's buildBriefNotReady", () => {
  const audit = (body: unknown) =>
    graphAudit(REPO, 1, TOKEN, {
      runner: async () => ({ code: 0, stdout: JSON.stringify(body), stderr: "" }),
    });
  const base = { repo: REPO, root: "1", nodes: 2, closedWithoutReceipt: [], openWithoutCheckpoint: [], openClaimed: [] };

  test("carries the finding, and leaves it absent when soma omits it", async () => {
    expect((await audit({ ...base, buildBriefNotReady: [MISSING_21] })).buildBriefNotReady).toEqual([MISSING_21]);
    expect((await audit(base)).buildBriefNotReady).toBeUndefined();
  });

  test("refuses a shape other than [{ id, missing: string[] }]", async () => {
    for (const bad of [{}, [{ id: "21" }], [{ id: "21", missing: [1] }], ["21"]]) {
      await expect(audit({ ...base, buildBriefNotReady: bad })).rejects.toBeInstanceOf(GraphError);
    }
  });
});

describe("the escalation desk cards a not-ready build brief", () => {
  test("one card names the missing items; a second tick does not repost; a fixed brief leaves the queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-brief-desk-"));
    const fixtures = mkdtempSync(join(tmpdir(), "ranger-brief-desk-fx-"));
    const discord = fakeDiscord();
    try {
      writeFrontier(fixtures);
      writeAudit(fixtures, [MISSING_21]);
      const config = join(dir, "ranger.yaml");
      writeFileSync(
        config,
        [...baseConfigLines(dir), "principal:", "  login: jcfischer"].join("\n").replace("walk: research-only", "walk: full"),
      );
      const env = {
        ...process.env,
        PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
        FAKE_SOMA_DIR: fixtures,
        RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
        RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
        RANGER_DISCORD_MIN_INTERVAL_MS: "5",
        RANGER_DISCORD_TOKEN: "fake-bot-token",
        RANGER_RO_TEST: "ghp_ro",
      };
      const escalate = async () => {
        const run = await runCli(["escalate", "-c", config, "--json"], env);
        expect(run.code).toBe(0);
        return JSON.parse(run.stdout).maps[0];
      };

      const first = await escalate();
      expect(first.posted).toEqual(["21"]);
      expect(discord.posts).toHaveLength(1);
      const card = discord.posts[0]!.content;
      expect(card).toContain("**Build brief not ready**");
      expect(card).toContain("**#21** Build the widget");
      expect(card).toContain("missing `## Acceptance criteria`, `[NEEDS CLARIFICATION]`");
      const journal = new Journal(join(dir, "state.sqlite"));
      expect(journal.getEscalation(REPO, "21")?.route).toBe("brief-not-ready");
      journal.close();

      // Same state next tick: no duplicate card, no needless edit.
      const second = await escalate();
      expect(second.posted).toEqual([]);
      expect(second.edited).toEqual([]);
      expect(discord.posts).toHaveLength(1);

      // An unreadable audit neither posts a card nor retires the open one.
      writeAudit(fixtures, "not-an-array");
      const unknown = await escalate();
      expect(unknown.posted).toEqual([]);
      expect(unknown.keptOpen).toEqual([]);
      expect(unknown.cardErrors.join("\n")).toContain("build briefs unverified");
      expect(discord.edits).toHaveLength(0);

      // The body is fixed: the audit stops listing it and its card leaves the queue.
      writeAudit(fixtures, []);
      const fixed = await escalate();
      expect(fixed.posted).toEqual([]);
      expect(fixed.keptOpen).toEqual(["21"]);
      expect(discord.posts).toHaveLength(1);
    } finally {
      discord.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(fixtures, { recursive: true, force: true });
    }
  });
});


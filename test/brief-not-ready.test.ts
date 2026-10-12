import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTick } from "../src/candidates.ts";
import { type AuditMode, cachedFrontier, readFrontier } from "../src/frontier-cache.ts";
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

function entry(id: string, kind: string, title = `Node ${id}`, body?: string) {
  return {
    ...(body === undefined ? {} : { body }),
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

/** 21 and 22 are build nodes, 23 a task, 24 research; `body21` is #21's brief, `extra` more entries. */
function writeFrontier(dir: string, body21?: string, extra: ReturnType<typeof entry>[] = []): void {
  writeFileSync(
    join(dir, "acme__widgets-frontier.json"),
    JSON.stringify({
      repo: REPO,
      root: "1",
      frontier: [entry("21", "build", "Build the widget", body21), entry("22", "build"), entry("23", "task"), entry("24", "research"), ...extra],
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
  let calls: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "PATH",
    "FAKE_SOMA_DIR",
    "FAKE_SOMA_CALLS",
    "FAKE_SOMA_AUDIT_FAIL",
    "FAKE_GH_EVENTS_LATEST",
    "FAKE_GH_ISSUES_UPDATED",
    "FAKE_GH_GRAPHQL_REMAINING",
  ];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "ranger-brief-"));
    calls = join(dir, "soma-calls.log");
    writeFileSync(calls, "");
    process.env.PATH = `${fixturesBin}:${saved.PATH ?? ""}`;
    process.env.FAKE_SOMA_DIR = dir;
    process.env.FAKE_SOMA_CALLS = calls;
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
  /** How many times the fake soma ran one verb. */
  const somaCalls = (verb: string) =>
    readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith(`${verb} `)).length;
  /**
   * The fake gh's issue-event half of the sentinel is a checksum of the
   * fixtures, so rewriting one reads as a graph change. Pinning it leaves
   * the sentinel to `updated_at` (FAKE_GH_ISSUES_UPDATED), which a body
   * edit on GitHub bumps.
   */
  const pinEvents = () => {
    process.env.FAKE_GH_EVENTS_LATEST = "1000";
  };

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
    pinEvents();
    writeAudit(dir, [MISSING_21]);
    expect(ids((await plan()).plan.take)).not.toContain("21");
    // Soma's verdict changes, but the sentinel has not moved: the cached
    // read, and its hold, stand.
    writeAudit(dir, []);
    const unchanged = await plan();
    expect(unchanged.read.source).toBe("cache");
    expect(ids(unchanged.plan.take)).not.toContain("21");
    // The body edit bumps the issue's updated_at, so the tick re-reads the
    // frontier, and the edited brief is audited again.
    writeFrontier(dir, "## Acceptance criteria\n\nFixed.");
    process.env.FAKE_GH_ISSUES_UPDATED = "2026-01-02T00:00:00Z";
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

  test("an unreadable audit (soma fails) holds build nodes only", async () => {
    writeAudit(dir, [MISSING_21]);
    process.env.FAKE_SOMA_AUDIT_FAIL = "1";
    const { read, classified, plan: p } = await plan();
    expect(read.briefs).toEqual({ ok: false, error: expect.stringContaining("audit failed") });
    expect(classified.find((n) => n.id === "22")?.route).toEqual({ route: "brief-not-ready", missing: null });
    // Both build nodes wait; the task node takes the implement slot.
    expect(ids(p.take)).toEqual(["23", "24"]);
  });

  test("a malformed audit is cached as failed: the next tick keeps the frontier and re-runs only the audit", async () => {
    pinEvents();
    writeAudit(dir, [{ id: 21, missing: "## Deliverable" }]);
    const first = await plan();
    expect(first.read.source).toBe("fresh");
    expect(first.read.briefs.ok).toBe(false);
    expect(ids(first.plan.take)).toEqual(["23", "24"]);
    // The dashboard's journal read shows the hold, not a pre-failure frontier.
    expect(cachedFrontier(journal, REPO, 1)?.briefs?.ok).toBe(false);

    const second = await plan();
    expect(second.read.source).toBe("cache");
    expect(second.read.briefs.ok).toBe(false);
    expect(somaCalls("frontier")).toBe(1);
    expect(somaCalls("audit")).toBe(2);

    // Once the audit reads, the hold follows its finding; still one frontier read.
    writeAudit(dir, [MISSING_21]);
    const third = await plan();
    expect(third.read.source).toBe("cache");
    expect(third.read.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
    expect(ids(third.plan.take)).toEqual(["22", "24"]);
    expect(somaCalls("frontier")).toBe(1);
    expect(cachedFrontier(journal, REPO, 1)?.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
  });

  test("an audit deferred under the floor holds build nodes and still serves the cached frontier", async () => {
    pinEvents();
    writeAudit(dir, [{ id: 21, missing: "## Deliverable" }]);
    await plan();
    process.env.FAKE_GH_GRAPHQL_REMAINING = "10";
    const { read, plan: p } = await plan();
    expect(read.source).toBe("cache");
    expect(read.briefs.ok).toBe(false);
    expect(ids(p.take)).toEqual(["23", "24"]);
    expect(somaCalls("audit")).toBe(1);
  });
});

describe("the audit is cached on its own, keyed by the build briefs it saw", () => {
  let dir: string;
  let journal: Journal;
  let calls: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["PATH", "FAKE_SOMA_DIR", "FAKE_SOMA_CALLS", "FAKE_SOMA_AUDIT_FAIL", "FAKE_GH_EVENTS_LATEST", "FAKE_GH_ISSUES_UPDATED", "FAKE_GH_SENTINEL_FAIL"];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "ranger-audit-cache-"));
    calls = join(dir, "soma-calls.log");
    writeFileSync(calls, "");
    process.env.PATH = `${fixturesBin}:${saved.PATH ?? ""}`;
    process.env.FAKE_SOMA_DIR = dir;
    process.env.FAKE_SOMA_CALLS = calls;
    // Pinned: only updated_at moves the sentinel, as a comment would.
    process.env.FAKE_GH_EVENTS_LATEST = "1000";
    journal = new Journal(join(dir, "state.sqlite"));
    writeFrontier(dir, "## Deliverable\n\nThe widget.");
    writeAudit(dir, [MISSING_21]);
  });

  afterEach(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const read = (audit?: AuditMode, now = new Date()) =>
    readFrontier({ journal, repo: REPO, root: 1, token: TOKEN, policy: POLICY, maxAgeMs: 60 * 60_000, now, ...(audit === undefined ? {} : { audit }) });
  const audits = () => readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("audit ")).length;
  /** A comment on the map: the sentinel moves, no brief changes. */
  const comment = (n: number) => {
    process.env.FAKE_GH_ISSUES_UPDATED = `2026-01-0${n}T00:00:00Z`;
  };
  const route = (r: Awaited<ReturnType<typeof read>>, id: string) =>
    classifyFrontier(r.frontier.frontier, MAP, REGISTRY, "ivy-bot", r.briefs).find((n) => n.id === id)?.route;

  test("a moved sentinel with no brief changed reuses the audit: a fresh frontier, no second audit", async () => {
    const first = await read();
    expect(first.auditMs).toBeGreaterThanOrEqual(0);
    comment(2);
    const second = await read();
    expect(second.source).toBe("fresh");
    expect(second.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
    expect(second.auditMs).toBeUndefined();
    expect(audits()).toBe(1);
  });

  test("an edited build brief is audited again in refresh mode, and held unaudited in never mode", async () => {
    await read();
    writeFrontier(dir, "## Deliverable\n\nThe widget, edited.");
    writeAudit(dir, []);
    comment(2);
    const locked = await read("never");
    expect(locked.briefs).toEqual({ ok: true, notReady: [MISSING_21], unverified: ["21"] });
    expect(route(locked, "21")).toEqual({ route: "brief-not-ready", missing: null });
    expect(route(locked, "22")).toEqual(expect.objectContaining({ route: "implement" }));
    expect(audits()).toBe(1);
    const warm = await read("refresh");
    expect(warm.briefs).toEqual({ ok: true, notReady: [] });
    expect(audits()).toBe(2);
    // The locked read after it serves the new audit, nothing held.
    expect((await read("never")).briefs).toEqual({ ok: true, notReady: [] });
  });

  test("a build node new since the audit is held until an audit sees it", async () => {
    await read();
    writeFrontier(dir, "## Deliverable\n\nThe widget.", [entry("25", "build", "A new build")]);
    comment(2);
    const locked = await read("never");
    expect(locked.briefs).toEqual({ ok: true, notReady: [MISSING_21], unverified: ["25"] });
    expect(route(locked, "25")).toEqual({ route: "brief-not-ready", missing: null });
  });

  test("a failed audit keeps the last good one: it is served, the edited node held, the failure noted", async () => {
    await read();
    writeFrontier(dir, "## Deliverable\n\nThe widget, edited.");
    comment(2);
    process.env.FAKE_SOMA_AUDIT_FAIL = "1";
    const failed = await read("refresh");
    expect(failed.briefs).toEqual({ ok: true, notReady: [MISSING_21], unverified: ["21"] });
    expect(failed.auditNote).toContain("audit failed");
    expect(cachedFrontier(journal, REPO, 1)?.briefs).toEqual({ ok: true, notReady: [MISSING_21], unverified: ["21"] });
    // Once soma reads again, the next refresh replaces it.
    delete process.env.FAKE_SOMA_AUDIT_FAIL;
    writeAudit(dir, []);
    expect((await read("refresh")).briefs).toEqual({ ok: true, notReady: [] });
  });

  test("if-missing (the escalation pass) never re-audits while a good audit exists, and audits a map that has none", async () => {
    const none = await read("if-missing");
    expect(none.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
    expect(audits()).toBe(1);
    writeFrontier(dir, "## Deliverable\n\nThe widget, edited.");
    comment(2);
    const served = await read("if-missing");
    expect(served.briefs).toEqual({ ok: true, notReady: [MISSING_21], unverified: ["21"] });
    expect(audits()).toBe(1);
  });

  test("if-missing serves a good audit past the max age rather than run one (the walk keeps it fresh)", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    await read("refresh", t0);
    comment(2);
    const late = await read("if-missing", new Date(t0.getTime() + 3 * 60 * 60_000));
    expect(late.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
    expect(audits()).toBe(1);
    // never mode does not serve one past the max age: build nodes are held.
    expect((await read("never", new Date(t0.getTime() + 3 * 60 * 60_000))).briefs.ok).toBe(false);
  });

  test("a failed sentinel read keeps the audit: it needs no sentinel", async () => {
    await read();
    process.env.FAKE_GH_SENTINEL_FAIL = "1";
    const r = await read("never");
    expect(r.briefs).toEqual({ ok: true, notReady: [MISSING_21] });
    expect(audits()).toBe(1);
  });

  test("never mode with no good audit holds every build node", async () => {
    const r = await read("never");
    expect(r.briefs).toEqual({ ok: false, error: "soma graph audit not read yet" });
    expect(audits()).toBe(0);
  });

  test("an audit older than the max age is re-run even with every brief unchanged", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    await read("refresh", t0);
    comment(2);
    await read("refresh", new Date(t0.getTime() + 30 * 60_000));
    expect(audits()).toBe(1);
    comment(3);
    await read("refresh", new Date(t0.getTime() + 61 * 60_000));
    expect(audits()).toBe(2);
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

/**
 * One CLI run's rig: temp state and fixture dirs, the fake Discord, the env
 * that points ranger at both, and a `config` writer that walks the map in
 * full. Torn down whatever the test does.
 */
/** The walk's audit, run before its claim lock: `readFrontier` in `refresh` mode on the rig's journal. */
async function walkAudit(dir: string, fixtures: string, env: NodeJS.ProcessEnv): Promise<void> {
  const saved = { PATH: process.env.PATH, FAKE_SOMA_DIR: process.env.FAKE_SOMA_DIR };
  Object.assign(process.env, { PATH: env.PATH, FAKE_SOMA_DIR: fixtures });
  const journal = new Journal(join(dir, "state.sqlite"));
  try {
    const read = await readFrontier({ journal, repo: REPO, root: 1, token: TOKEN, policy: POLICY, maxAgeMs: 60 * 60_000, now: new Date(), audit: "refresh" });
    expect(read.briefs).toEqual({ ok: true, notReady: [] });
  } finally {
    journal.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withCliRig(
  run: (rig: {
    dir: string;
    fixtures: string;
    env: NodeJS.ProcessEnv;
    discord: ReturnType<typeof fakeDiscord>;
    config: (lines: string[]) => string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ranger-brief-cli-"));
  const fixtures = mkdtempSync(join(tmpdir(), "ranger-brief-cli-fx-"));
  const discord = fakeDiscord();
  try {
    writeFrontier(fixtures);
    writeAudit(fixtures, [MISSING_21]);
    const env = {
      ...process.env,
      PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
      FAKE_SOMA_DIR: fixtures,
      RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
      RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
      RANGER_DISCORD_MIN_INTERVAL_MS: "5",
      RANGER_DISCORD_TOKEN: "fake-bot-token",
    };
    const config = (lines: string[]) => {
      const path = join(dir, "ranger.yaml");
      writeFileSync(path, lines.join("\n").replace("walk: research-only", "walk: full"));
      return path;
    };
    await run({ dir, fixtures, env, discord, config });
  } finally {
    discord.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
  }
}

describe("the escalation desk cards a not-ready build brief", () => {
  test("one card names the missing items; a second tick does not repost; a fixed brief leaves the queue", () =>
    withCliRig(async ({ dir, fixtures, env: rigEnv, discord, config: writeConfig }) => {
      const config = writeConfig([...baseConfigLines(dir), "principal:", "  login: jcfischer"]);
      const env = { ...rigEnv, RANGER_RO_TEST: "ghp_ro" };
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

      // The brief is edited. The pass never re-runs the audit the walk owns
      // (a broken soma changes nothing): the edited node is unverified, so it
      // neither posts a card nor retires the open one.
      writeFrontier(fixtures, "## Acceptance criteria\n\nFixed.");
      writeAudit(fixtures, "not-an-array");
      const unknown = await escalate();
      expect(unknown.posted).toEqual([]);
      expect(unknown.keptOpen).toEqual([]);
      expect(discord.edits).toHaveLength(0);

      // The walk's next audit reads the fixed body: its card leaves the queue.
      writeAudit(fixtures, []);
      await walkAudit(dir, fixtures, env);
      const fixed = await escalate();
      expect(fixed.posted).toEqual([]);
      expect(fixed.keptOpen).toEqual(["21"]);
      expect(discord.posts).toHaveLength(1);
    }));
});

describe("ranger walk never claims a held build node", () => {
  test("the tick claims the next build node and leaves the listed one unassigned", () =>
    withCliRig(async ({ dir, env, config: writeConfig }) => {
      const node = { autonomy: "auto", assignees: [], status: "open", probes: [] };
      const statePath = join(dir, "state.json");
      writeFileSync(statePath, JSON.stringify({ nodes: { "21": { ...node, checkpoint: "cp-21" }, "22": { ...node, checkpoint: "cp-22" } }, decisions: [] }));
      const config = writeConfig(baseConfigLines(dir, { auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'] }));
      const run = await runCli(["walk", "-c", config], {
        ...env,
        FAKE_SOMA_STATE: statePath,
        RANGER_WRITE_TEST: "ghp_write",
        RANGER_NO_SPAWN: "1",
      });
      expect(run.code).toBe(0);
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { nodes: Record<string, { assignees: string[] }> };
      expect(state.nodes["21"]!.assignees).toEqual([]);
      expect(state.nodes["22"]!.assignees).toEqual(["ivy-bot"]);
    }));
});

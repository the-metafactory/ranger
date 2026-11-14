import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { Journal } from "../src/journal.ts";
import { fakeDiscord, fixturesBin, GIT_ENV, runCli } from "./support.ts";

const REPO = "acme/widgets";
const TICKS = 12;
const SETTLED_BY = 6;

let dir: string;
let discord: ReturnType<typeof fakeDiscord>;

beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-no-endless-wait-"));
 discord = fakeDiscord();
});
afterEach(() => {
 discord.stop();
 rmSync(dir, { recursive: true, force: true });
});

interface Host { config: string; env: NodeJS.ProcessEnv; journal: () => Journal; node: (id: string) => void }

function host(env: NodeJS.ProcessEnv = {}): Host {
 const data = join(dir, "soma");
 mkdirSync(data);
 writeFileSync(join(data, "acme__widgets-frontier.json"), JSON.stringify({ repo: REPO, root: "1", frontier: [] }));
 const state = join(dir, "graph.json");
 writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
 const journalPath = join(dir, "journal.sqlite");
 const config = join(dir, "ranger.yaml");
 writeFileSync(config, stringify({
  version: 1,
  maps: [{ repo: REPO, root: 1, walk: "full", commands: { test: "bun test" }, discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1" } }],
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST", readOnlyTokens: { "acme/*": "RANGER_RO_TEST" } },
  bot: { identity: "ivy-bot" },
  state: { journalPath },
  workers: { spawnCapPerDay: 10, niceness: 0 },
 }));
 return {
  config,
  journal: () => new Journal(journalPath),
  node: (id) => writeFileSync(join(data, `acme__widgets-node-${id}.json`), JSON.stringify({
   repo: REPO, ref: { id }, node: { id, title: `Build ${id}`, kind: "task", autonomy: "auto" },
   status: "open", assignees: ["ivy-bot"], blockedBy: [], author: "alice", typed: true, url: "",
  })),
  env: {
   ...process.env, ...GIT_ENV,
   PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
   FAKE_SOMA_DIR: data, FAKE_SOMA_STATE: state,
   RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
   RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5",
   RANGER_DISCORD_TOKEN: "fake-bot-token",
   RANGER_WRITE_TEST: "ghp_write", RANGER_RO_TEST: "ghp_ro", RANGER_NO_SPAWN: "1",
   ...env,
  },
 };
}

type Snapshot = Map<string, string[]>;

function eventsByNode(h: Host): Snapshot {
 const journal = h.journal();
 try {
  const byNode: Snapshot = new Map();
  for (const event of journal.listEvents(REPO, Number.MAX_SAFE_INTEGER).reverse()) {
   if (event.nodeId === null) continue;
   byNode.set(event.nodeId, [...(byNode.get(event.nodeId) ?? []), `${event.kind}: ${event.detail ?? ""}`]);
  }
  return byNode;
 } finally {
  journal.close();
 }
}

async function soak(h: Host): Promise<Snapshot[]> {
 const snapshots: Snapshot[] = [];
 for (let tick = 0; tick < TICKS; tick++) {
  await runCli(["tick", "-c", h.config], h.env);
  snapshots.push(eventsByNode(h));
 }
 return snapshots;
}

function stillWaking(snapshots: Snapshot[]): Record<string, string[]> {
 const settled = snapshots[SETTLED_BY - 1];
 const waking: Record<string, string[]> = {};
 for (const [nodeId, events] of snapshots[snapshots.length - 1]) {
  const before = settled.get(nodeId)?.length ?? 0;
  if (events.length > before) waking[nodeId] = events.slice(before);
 }
 return waking;
}

const said = (snapshot: Snapshot, nodeId: string, text: string) => snapshot.get(nodeId)?.some((e) => e.includes(text)) ?? false;

describe("a node stuck on a failure that never clears goes quiet within a bounded number of ticks", () => {
 test("a worker row whose graph node can never be read parks (#504)", async () => {
  const h = host();
  const journal = h.journal();
  journal.upsertWorker({ repo: REPO, root: 1, nodeId: "20", status: "failed", worktree: null, prNumber: 7,
   outcome: "worker supervisor died; resume-node --reset-recovery after intervention" });
  journal.close();

  const snapshots = await soak(h);

  expect(stillWaking(snapshots)).toEqual({});
  expect(said(snapshots[SETTLED_BY - 1], "20", "closure sweep parked")).toBe(true);
 }, 120_000);

 test("a queued resume whose start is refused every tick is dropped (#168)", async () => {
  const h = host({ RANGER_WRITE_TEST: "ghp_principal" });
  h.node("40");
  const journal = h.journal();
  journal.upsertWorker({ repo: REPO, root: 1, nodeId: "40", status: "parked", lane: "implement", phase: "review", pid: null, finishedAt: "2026-10-06T00:00:00Z" });
  journal.enqueueResume({ nodeId: "40", repo: REPO, root: 1, lane: "headless" });
  journal.close();

  const snapshots = await soak(h);

  expect(stillWaking(snapshots)).toEqual({});
  expect(said(snapshots[SETTLED_BY - 1], "40", "resume-dropped")).toBe(true);
 }, 120_000);

 test("a queued resume whose identity read never comes back is escalated once and keeps its place", async () => {
  const h = host({ FAKE_GH_USER_FAIL: "1" });
  h.node("40");
  const journal = h.journal();
  journal.upsertWorker({ repo: REPO, root: 1, nodeId: "40", status: "parked", lane: "implement", phase: "review", pid: null, finishedAt: "2026-10-06T00:00:00Z" });
  journal.enqueueResume({ nodeId: "40", repo: REPO, root: 1, lane: "headless" });
  journal.close();

  const snapshots = await soak(h);

  expect(stillWaking(snapshots)).toEqual({});
  expect(said(snapshots[SETTLED_BY - 1], "40", "queued resume #40 escalated: 3 transient deferrals in a row")).toBe(true);
  expect(discord.posts.filter((p) => p.content.includes("queued resume stuck"))).toHaveLength(1);
  const after = h.journal();
  expect(after.getResume(REPO, "40")).not.toBeNull();
  after.close();
 }, 120_000);
});

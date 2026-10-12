import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import type { NodeResult } from "../src/graph.ts";
import * as graph from "../src/graph.ts";
import { MAX_WORKER_CLOSURE_READS, reconcileGraphClosures } from "../src/closure-sweep.ts";
import { finishClosedElsewhere } from "../src/closed-elsewhere.ts";
import { sweepMap, type SweepMapResult } from "../src/sweep.ts";
import { fixturesBin } from "./support.ts";
import { BudgetDeferral } from "../src/budget.ts";
import { ABSENT_RESERVE, markAbsentCards } from "../src/card-sync.ts";
import { EscalationDiscord } from "../src/discord.ts";
import * as github from "../src/github.ts";
import type { ChangeRequest } from "../src/forge.ts";

let dir: string;
let journal: Journal;
let config: RangerConfig;
const repo = "acme/widgets";
const botIdentity = "ivy-agent";
const savedEnv = { ...process.env };
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-closure-sweep-"));
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, `maps:\n  - repo: ${repo}\n    root: 1\nauth:\n  readOnlyTokens:\n    '*': RO\n`);
 config = loadConfig(path).config;
 journal = new Journal(join(dir, "journal.sqlite"));
 process.env.PATH = `${fixturesBin}:${savedEnv.PATH ?? ""}`;
});
afterEach(() => {
 journal.close(); rmSync(dir, { recursive: true, force: true });
 for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
 Object.assign(process.env, savedEnv);
});
const context = () => ({ config, journal, map: config.maps[0]!, token: "ghp_write", botIdentity });
const result = (): SweepMapResult => ({ repo, crashed: 0, respawned: [], parked: [], released: [], paused: false, deadmanCount: 0, orphansKilled: [] });
const node = (id: string, closer?: string): NodeResult => ({
 repo, ref: { id }, node: { id, title: "Feature", kind: "task", autonomy: "auto",
  ...(closer === undefined ? {} : { completion: { closer, receiptCommentId: "900", closedAt: new Date().toISOString() } }),
 }, status: "closed", assignees: [], blockedBy: [], author: "alice", typed: true,
 url: `https://github.com/${repo}/issues/${id}`,
});
const mergedPr: ChangeRequest = {
 iid: 1, state: "merged", draft: false, headRef: "node/20-feature", headSha: "a".repeat(40),
 baseRef: "main", mergeState: "mergeable", webUrl: `https://github.com/${repo}/pull/1`,
 author: botIdentity, title: "Feature", body: "", mergeCommitSha: "b".repeat(40), mergedBy: "jcfischer",
};

test("closure sweep caps reads, runs three together and resumes its persisted cursor past an open prefix", async () => {
 for (let i = 0; i < 12; i++) journal.upsertWorker({ repo, root: 1, nodeId: String(i).padStart(2, "0"), status: "failed" });
 // Other maps and terminal workers cannot spend this pass's allowance.
 journal.upsertWorker({ repo, root: 2, nodeId: "other-map", status: "failed" });
 journal.upsertWorker({ repo, root: 1, nodeId: "success", status: "success" });
 const visited: string[] = [];
 let active = 0, peak = 0;
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const read = async (id: string) => {
  visited.push(id); active++; peak = Math.max(peak, active);
  if (active === 3) release();
  await gate;
  active--;
  if (id === "01") throw new Error("transient failure in prefix");
  return { ...node(id), status: "open" };
 };
 await reconcileGraphClosures(context(), read, result());
 expect(visited).toHaveLength(MAX_WORKER_CLOSURE_READS);
 expect(peak).toBe(3);
 // Simulate a new tick process: the cursor survives journal reopen.
 journal.close(); journal = new Journal(join(dir, "journal.sqlite"));
 await reconcileGraphClosures(context(), read, result());
 expect(visited).toHaveLength(10);
 await reconcileGraphClosures(context(), read, result());
 expect(visited).toEqual(Array.from({ length: 12 }, (_, i) => String(i).padStart(2, "0")));
 await reconcileGraphClosures(context(), read, result());
 expect(visited.slice(12)).toEqual(["00", "01", "02", "03", "04"]);
});

test.each([botIdentity, "jcfischer", undefined])("closure attribution uses receipt evidence (closer %s)", async closer => {
 journal.upsertWorker({ repo, root: 1, nodeId: "20", status: "failed" });
 const outcome = await finishClosedElsewhere({ ...context(), node: node("20", closer), pr: null, generation: 0 });
 expect(outcome.status).toBe("released");
 const events = journal.listEvents(repo);
 expect(events[0]?.kind).toBe(closer === undefined ? "closed-elsewhere-ungated" : closer === botIdentity ? "closed" : "closed-elsewhere");
 if (closer === botIdentity) {
  expect(outcome.detail).toContain("recovered ranger close by ivy-agent");
  expect(outcome.detail).not.toContain("outside ranger");
 } else if (closer === undefined) {
  expect(outcome.detail).toContain("without a gated-close receipt");
 } else expect(outcome.detail).toContain("closed outside ranger by jcfischer");
});

test.each([botIdentity, "jcfischer", undefined])("merged closure preserves deadman unless it recovers ranger's own close (closer %s)", async closer => {
 journal.upsertWorker({ repo, root: 1, nodeId: "20", status: "failed" });
 journal.bumpDeadman(); journal.bumpDeadman();
 const outcome = await finishClosedElsewhere({ ...context(), node: node("20", closer), pr: mergedPr, generation: 0 });
 expect(outcome.status).toBe("success");
 expect(journal.deadmanCount()).toBe(closer === botIdentity ? 0 : 2);
});

test("sweep reads noted cards and terminal close retries, never active cards", async () => {
 config.maps[0]!.discord = { tokenEnv: "RANGER_CLOSURE_TEST_TOKEN", channelId: "123" };
 process.env.RANGER_CLOSURE_TEST_TOKEN = "fake";
 for (let i = 0; i < 20; i++) journal.upsertEscalation({ key: `${repo}:${i}`, repo, root: 1, nodeId: String(i), messageId: `card-${i}`, createdAt: new Date().toISOString() });
 journal.upsertEscalation({ key: `${repo}:noted`, repo, root: 1, nodeId: "noted", messageId: "card", createdAt: new Date().toISOString(), notedAt: new Date().toISOString() });
 journal.upsertEscalation({ key: `${repo}:terminal`, repo, root: 1, nodeId: "terminal", messageId: "card", createdAt: new Date().toISOString() });
 journal.upsertWorker({ repo, root: 1, nodeId: "terminal", status: "success", phase: "close" });
 const reads: string[] = [];
 await reconcileGraphClosures(context(), async id => { reads.push(id); return { ...node(id), status: "open" }; }, result());
 expect(reads.sort()).toEqual(["noted", "terminal"]);
});

test("sweep shares its Discord allowance across workers and terminal-card retries", async () => {
 config.maps[0]!.discord = { tokenEnv: "RANGER_CLOSURE_TEST_TOKEN", channelId: "123" };
 process.env.RANGER_CLOSURE_TEST_TOKEN = "fake";
 for (let id = 0; id < 3; id++) {
  const nodeId = String(id), key = `${repo}:${nodeId}`;
  journal.upsertWorker({ repo, root: 1, nodeId, status: "failed", prNumber: 1 });
  journal.upsertEscalation({ key, repo, root: 1, nodeId, channelId: "123", messageId: `${id}-a`, createdAt: new Date().toISOString() });
  journal.setEscalationDestination(key, "123", `${id}-a`, new Date().toISOString());
  journal.setEscalationDestination(key, "456", `${id}-b`, new Date().toISOString());
 }
 const edited: string[] = [];
 const edit = spyOn(EscalationDiscord.prototype, "edit").mockImplementation(async messageId => { edited.push(messageId); });
 const ctx = { ...context(), github: { ...github, getPr: async () => mergedPr } };
 try {
  await reconcileGraphClosures(ctx, async id => node(id, "jcfischer"), result());
  expect(edited).toHaveLength(ABSENT_RESERVE);
  expect(journal.listWorkers(repo).every(worker => worker.status === "success")).toBe(true);
  expect(journal.getEscalation(repo, "2")?.status).toBe("open");
  await reconcileGraphClosures(ctx, async id => node(id, "jcfischer"), result());
  expect(edited).toHaveLength(6);
  expect(new Set(edited).size).toBe(6);
  expect(journal.getEscalation(repo, "2")?.status).toBe("closed");
  await reconcileGraphClosures(ctx, async () => { throw new Error("no resolved card should be read"); }, result());
  expect(edited).toHaveLength(6);
 } finally { edit.mockRestore(); }
});

test("sweep respects the GraphQL floor before reading workers or noted cards", async () => {
 process.env.FAKE_GH_GRAPHQL_REMAINING = "0";
 const calls = join(dir, "graph-calls");
 writeFileSync(calls, ""); process.env.FAKE_SOMA_CALLS = calls;
 journal.upsertWorker({ repo, root: 1, nodeId: "20", status: "failed" });
 config.maps[0]!.discord = { tokenEnv: "RANGER_CLOSURE_TEST_TOKEN", channelId: "123" };
 process.env.RANGER_CLOSURE_TEST_TOKEN = "fake";
 journal.upsertEscalation({ key: `${repo}:21`, repo, root: 1, nodeId: "21", messageId: "card", createdAt: new Date().toISOString(), notedAt: new Date().toISOString() });
 await sweepMap({ ...context(), phase: "liveness" });
 expect(journal.getWorker("20", repo)?.status).toBe("failed");
 expect(journal.getEscalation(repo, "21")?.status).toBe("open");
 expect(await Bun.file(calls).text()).toBe("");
 expect(journal.listEvents(repo)[0]?.detail).toContain("BudgetDeferral");
});

test("sweep handles crashed workers before graph closure reads", async () => {
 journal.upsertWorker({ repo, root: 1, nodeId: "crashed", status: "running", pid: 2_000_000_000, attempts: 0 });
 journal.upsertWorker({ repo, root: 1, nodeId: "20", status: "failed" });
 const order: string[] = [];
 const read = spyOn(graph, "graphNode").mockImplementation(async (_repo, id) => {
  order.push(`read-${id}`);
  return { ...node(id), status: "open" };
 });
 try {
  const outcome = await sweepMap({ ...context(), phase: "liveness", respawn: async id => {
   order.push(`respawn-${id}`); return null;
  } });
  expect(outcome.crashed).toBe(1);
  expect(order).toEqual(["respawn-crashed", "read-20"]);
 } finally { read.mockRestore(); }
});

test("a noted card's budget deferral is deferred, with no error or edit", async () => {
 journal.upsertEscalation({ key: `${repo}:20`, repo, root: 1, nodeId: "20", messageId: "card", createdAt: new Date().toISOString(), notedAt: new Date().toISOString() });
 const client = new EscalationDiscord("fake", "channel");
 const outcome = await markAbsentCards({ ...context(), client, now: new Date(), budget: { remaining: 5, deadline: Date.now() + 60_000 }, owned: () => {},
  readNode: async () => { throw new BudgetDeferral("floor"); },
 }, new Set());
 expect(outcome).toEqual({ keptOpen: [], deferred: ["20"], errors: [] });
 expect(journal.getEscalation(repo, "20")?.status).toBe("open");
});

test("noted backlog cannot spend the unnoted absent-card allowance", async () => {
 const now = new Date();
 for (let i = 0; i < 12; i++) {
  const id = `noted-${String(i).padStart(2, "0")}`;
  journal.upsertEscalation({ key: `${repo}:${id}`, repo, root: 1, nodeId: id,
   channelId: "123", messageId: id, createdAt: "2026-01-01T00:00:00.000Z", notedAt: now.toISOString() });
 }
 const fresh = Array.from({ length: ABSENT_RESERVE }, (_, i) => `fresh-${i}`);
 for (const id of fresh) journal.upsertEscalation({ key: `${repo}:${id}`, repo, root: 1, nodeId: id,
  channelId: "123", messageId: id, createdAt: "2026-02-01T00:00:00.000Z" });
 const reads: string[] = [], edits: string[] = [];
 const edit = spyOn(EscalationDiscord.prototype, "edit").mockImplementation(async id => { edits.push(id); });
 try {
  const budget = { remaining: ABSENT_RESERVE, deadline: Date.now() + 60_000 };
  const outcome = await markAbsentCards({ ...context(), client: new EscalationDiscord("fake", "123"), now, budget,
   owned: () => {}, readNode: async id => { reads.push(id); return { ...node(id), status: "open" }; },
  }, new Set());
  expect(outcome.keptOpen).toEqual(fresh);
  expect(edits).toEqual(fresh);
  expect(budget.remaining).toBe(0);
  expect(reads.filter(id => id.startsWith("noted-"))).toHaveLength(ABSENT_RESERVE);
  for (const id of fresh) expect(journal.getEscalation(repo, id)?.notedAt).not.toBeNull();
 } finally { edit.mockRestore(); }
});

test("noted closure scan resumes its own cursor after journal reopen", async () => {
 const now = new Date();
 const ids = Array.from({ length: 12 }, (_, i) => `noted-${String(i).padStart(2, "0")}`);
 for (const id of ids) journal.upsertEscalation({ key: `${repo}:${id}`, repo, root: 1, nodeId: id,
  channelId: "123", messageId: id, createdAt: now.toISOString(), notedAt: now.toISOString() });
 const reads: string[] = [];
 const edit = spyOn(EscalationDiscord.prototype, "edit").mockResolvedValue(undefined);
 const tick = () => markAbsentCards({ ...context(), client: new EscalationDiscord("fake", "123"), now,
  budget: { remaining: ABSENT_RESERVE, deadline: Date.now() + 60_000 }, owned: () => {},
  readNode: async id => { reads.push(id); return { ...node(id), status: id === ids.at(-1) ? "closed" : "open" }; },
 }, new Set());
 try {
  await tick();
  journal.close(); journal = new Journal(join(dir, "journal.sqlite"));
  await tick(); await tick();
  expect(reads).toEqual(ids);
  expect(journal.getEscalation(repo, ids.at(-1)!)?.status).toBe("closed");
  expect(edit).toHaveBeenCalledTimes(1);
 } finally { edit.mockRestore(); }
});

test("queue-exit keeps a null-channel legacy card open without editing the map channel", async () => {
 config.maps[0]!.discord = { tokenEnv: "RANGER_CLOSURE_TEST_TOKEN", channelId: "123" };
 journal.upsertEscalation({ key: `${repo}:20`, repo, root: 1, nodeId: "20", messageId: "unposted", createdAt: new Date().toISOString() });
 const budget = { remaining: 5, deadline: Date.now() + 60_000 };
 const failFetch: typeof fetch = Object.assign(async () => {
  throw new Error("must not edit a card with no known destination");
 }, { preconnect: fetch.preconnect });
 const client = new EscalationDiscord("fake", "123", "https://unused.invalid", undefined, { until: 0 }, failFetch);
 const outcome = await markAbsentCards({ ...context(), client, now: new Date(), budget, owned: () => {},
  readNode: async () => ({ ...node("20"), status: "open" }),
 }, new Set());
 expect(outcome.errors).toEqual([]);
 expect(budget.remaining).toBe(5);
 expect(journal.getEscalation(repo, "20")?.status).toBe("open");
 expect(journal.getEscalation(repo, "20")?.notedAt).not.toBeNull();
});

test("graph closure retires a null-channel legacy card without editing a placeholder", async () => {
 config.maps[0]!.discord = { tokenEnv: "RANGER_CLOSURE_TEST_TOKEN", channelId: "123" };
 journal.upsertEscalation({ key: `${repo}:20`, repo, root: 1, nodeId: "20", messageId: "unposted", createdAt: new Date().toISOString() });
 const budget = { remaining: 5, deadline: Date.now() + 60_000 };
 const edit = spyOn(EscalationDiscord.prototype, "edit").mockImplementation(async () => { throw new Error("must not edit a placeholder"); });
 try {
  const outcome = await markAbsentCards({ ...context(), client: new EscalationDiscord("fake", "123"), now: new Date(), budget, owned: () => {}, readNode: async () => node("20") }, new Set());
  expect(outcome.errors).toEqual([]);
  expect(edit).not.toHaveBeenCalled();
  expect(budget.remaining).toBe(5);
  expect(journal.getEscalation(repo, "20")?.status).toBe("closed");
 } finally { edit.mockRestore(); }
});

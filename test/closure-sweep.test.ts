import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import type { NodeResult } from "../src/graph.ts";
import { MAX_WORKER_CLOSURE_READS, reconcileGraphClosures } from "../src/closure-sweep.ts";
import { finishClosedElsewhere } from "../src/closed-elsewhere.ts";
import { sweepMap, type SweepMapResult } from "../src/sweep.ts";
import { fixturesBin } from "./support.ts";
import { BudgetDeferral } from "../src/budget.ts";
import { markAbsentCards } from "../src/card-sync.ts";
import { EscalationDiscord } from "../src/discord.ts";

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

test("a noted card's budget deferral is deferred, with no error or edit", async () => {
 journal.upsertEscalation({ key: `${repo}:20`, repo, root: 1, nodeId: "20", messageId: "card", createdAt: new Date().toISOString(), notedAt: new Date().toISOString() });
 const client = new EscalationDiscord("fake", "channel");
 const outcome = await markAbsentCards({ ...context(), client, now: new Date(), budget: { remaining: 5, deadline: Date.now() + 60_000 }, owned: () => {},
  readNode: async () => { throw new BudgetDeferral("floor"); },
 }, new Set());
 expect(outcome).toEqual({ keptOpen: [], deferred: ["20"], errors: [] });
 expect(journal.getEscalation(repo, "20")?.status).toBe("open");
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

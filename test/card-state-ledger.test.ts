import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import {
 createEnvelope, InMemoryTransport, validateExecutionRunFinished,
 type ExecutionRunFinishedEvent, type MyelinEnvelope,
} from "@the-metafactory/myelin";
import { runTick, type TickDeps } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { escalateMaps, type EscalateResult } from "../src/escalate.ts";
import { nodeKey } from "../src/forge-ref.ts";
import { Journal } from "../src/journal.ts";
import { runLedgerPath, type RunLedgerDeps } from "../src/run-ledger.ts";
import type { WalkResult } from "../src/walk.ts";
import { baseConfigLines, fakeDiscord, fixturesBin } from "./support.ts";

const REPO = "the-metafactory/soma";
const AT = "2026-10-14T07:00:00.000Z";
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function walkResult(): WalkResult {
 return {
  maps: [], spawnCapPerDay: 6,
  probeRequeues: { resumed: [], pending: [], errors: [], lanes: [] },
  intake: { threads: [] },
  ratify: { read: [], closing: [], vetoed: [], recovered: [], deferred: [], errors: [] },
 };
}

function fixture(ids = ["604"], bus = true) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-card-state-"));
 const discord = fakeDiscord();
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, [
  ...baseConfigLines(dir).map(line => line.replace("acme/widgets", REPO).replace("acme/*", "the-metafactory/*")),
  ...(bus ? ["bus:", "  principal: jc"] : []),
 ].join("\n"));
 const config = loadConfig(configPath, {}).config;
 const env = {
  PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
  FAKE_SOMA_DIR: dir,
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
  RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
  RANGER_DISCORD_MIN_INTERVAL_MS: "5",
  RANGER_DISCORD_TOKEN: "fake-bot-token",
  RANGER_RO_TEST: "ghp_ro",
  RANGER_UNDER_TEST: "1",
  RANGER_NOW: AT,
 };
 const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]));
 Object.assign(process.env, env);
 const node = (id: string, status = "open") => ({
  repo: REPO, ref: { id },
  node: { id, title: `Decision ${id}`, kind: "grilling", autonomy: "propose", checkpointId: `decision-${id}`, probes: [] },
  status, assignees: [], blockedBy: [], author: "alice",
  url: `https://github.com/${REPO}/issues/${id}`, typed: true, parent: { id: "1" },
 });
 const frontier = (active: string[]) => writeFileSync(join(dir, "the-metafactory__soma-frontier.json"), JSON.stringify({ repo: REPO, root: "1", frontier: active.map(id => node(id)) }));
 frontier(ids);
 writeFileSync(join(dir, "the-metafactory__soma-audit.json"), JSON.stringify({
  repo: REPO, root: "1", nodes: ids.length, closedWithoutReceipt: ["600"], openWithoutCheckpoint: [], openClaimed: [],
 }));
 const captured: ExecutionRunFinishedEvent[] = [];
 const run = (ledger: RunLedgerDeps = {}, overrides: Partial<TickDeps> = {}) => runTick(configPath, {
  loadCtx: () => ({ config, journal: new Journal(config.state.journalPath) }),
  now: () => new Date(process.env.RANGER_NOW!),
  escalateMaps: (config, journal) => escalateMaps(config, journal, { now: new Date(process.env.RANGER_NOW!) }),
  walk: async () => walkResult(),
  ledger: { env: {}, publisher: async event => { captured.push(event); }, ...ledger },
  ...overrides,
 });
 const journal = <T>(read: (j: Journal) => T) => {
  const j = new Journal(config.state.journalPath);
  try { return read(j); } finally { j.close(); }
 };
 return {
  dir, config, discord, captured, run, journal, frontier,
  setNow: (days: number) => { process.env.RANGER_NOW = new Date(Date.parse(AT) + days * DAY).toISOString(); },
  graphNode: (id: string, status = "open") => writeFileSync(join(dir, `the-metafactory__soma-node-${id}.json`), JSON.stringify(node(id, status))),
  cleanup: () => {
   discord.stop();
   for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
   }
   rmSync(dir, { recursive: true, force: true });
  },
 };
}

function states(events: ExecutionRunFinishedEvent[]) {
 return events.filter(event => event.input.payload.ran.kind === "node");
}
function checkBatch(events: ExecutionRunFinishedEvent[], expected: Record<string, string>, correlation?: string) {
 const tick = events.find(event => event.input.payload.ran.kind === "job")!;
 expect(events).toHaveLength(Object.keys(expected).length + 1);
 expect(states(events).map(event => [event.input.payload.ran.ref, event.input.payload.state?.value]).sort()).toEqual(
  Object.entries(expected).map(([id, value]) => [nodeKey(REPO, id), value]).sort(),
 );
 if (correlation) expect(tick.input.payload.correlation_id).toBe(correlation);
 else expect(tick.input.payload.correlation_id).toMatch(UUID);
 expect(new Set(events.map(event => event.input.payload.run_id)).size).toBe(events.length);
 for (const event of events) {
  expect(event.input.payload.run_id).toMatch(UUID);
  expect(event.input.payload.correlation_id).toBe(tick.input.payload.correlation_id);
  expect(validateExecutionRunFinished(createEnvelope({ ...event.input, sovereignty: event.input.sovereignty as MyelinEnvelope["sovereignty"] })).valid).toBe(true);
  if (event.input.payload.ran.kind === "node") {
   expect(event.input.payload.outcome).toBe("blocked");
   expect(event.input.payload.state?.subject).toBe(event.input.payload.ran.ref);
  } else expect(event.input.payload).not.toHaveProperty("state");
 }
}

describe("tick card-state ledger", () => {
 test("fresh, aging, overdue, queue exit and graph closure report their states; unchanged cards emit nothing", async () => {
  const f = fixture();
  try {
   const fresh = await f.run();
   expect(fresh.exitCode).toBe(0);
   expect(JSON.parse(fresh.report).escalate.maps[0].posted).toEqual(["604"]);
   checkBatch(f.captured.splice(0), { "604": "needs-principal" });
   expect(f.discord.posts).toHaveLength(1);
   await f.run();
   checkBatch(f.captured.splice(0), {});
   f.setNow(4);
   await f.run({ env: { MF_CORRELATION_ID: "scheduled-tick-4" } });
   checkBatch(f.captured.splice(0), { "604": "needs-principal" }, "scheduled-tick-4");
   f.setNow(8);
   await f.run();
   checkBatch(f.captured.splice(0), { "604": "overdue" });
   f.frontier([]);
   f.graphNode("604");
   f.setNow(9);
   const left = await f.run();
   expect(JSON.parse(left.report).escalate.maps[0].keptOpen).toEqual(["604"]);
   checkBatch(f.captured.splice(0), { "604": "overdue" });
   expect(f.journal(j => j.getEscalation(REPO, "604")?.status)).toBe("open");
   f.graphNode("604", "closed");
   const closed = await f.run();
   expect(JSON.parse(closed.report).escalate.maps[0].closed).toEqual(["604"]);
   checkBatch(f.captured.splice(0), { "604": "resolved" });
   expect(f.journal(j => j.getEscalation(REPO, "604")?.status)).toBe("closed");
   const edits = f.discord.edits.length;
   await f.run();
   checkBatch(f.captured.splice(0), {});
   expect(f.discord.edits).toHaveLength(edits);
  } finally { f.cleanup(); }
 });

 test("two edited cards use their individual 4- and 8-day ages; a 4-day queue-exit card stays needs-principal", async () => {
  const f = fixture(["604", "605"]);
  try {
   f.journal(j => {
    for (const [id, days] of [["604", 4], ["605", 8]] as const) {
     j.upsertEscalation({
      key: `${REPO}:${id}`, repo: REPO, root: 1, nodeId: id, title: `Decision ${id}`,
      route: "escalate-hitl", lastContent: "old card", messageId: `seed-${id}`, channelId: "1234567890",
      createdAt: new Date(Date.parse(AT) - days * DAY).toISOString(), status: "open", notedAt: null,
     });
    }
   });
   const edited = await f.run();
   expect(JSON.parse(edited.report).escalate.maps[0].edited.sort()).toEqual(["604", "605"]);
   checkBatch(f.captured, { "604": "needs-principal", "605": "overdue" });
   f.captured.length = 0;
   f.frontier(["605"]);
   f.graphNode("604");
   // Force a fresh frontier read while staying in the 4-day band.
   f.setNow(0.1);
   await f.run();
   checkBatch(f.captured, { "604": "needs-principal" });
   expect(f.journal(j => j.getEscalation(REPO, "604")?.status)).toBe("open");
  } finally { f.cleanup(); }
 });

 test("request-budget deferral has no node envelope", async () => {
  const ids = Array.from({ length: 46 }, (_, i) => String(604 + i));
  const f = fixture(ids);
  try {
   const result = await f.run();
   const map = JSON.parse(result.report).escalate.maps[0];
   expect(map.deferred).toHaveLength(1);
   expect(map.posted).toHaveLength(45);
   expect(states(f.captured)).toHaveLength(45);
   expect(states(f.captured).some(event => event.input.payload.ran.ref === nodeKey(REPO, map.deferred[0]))).toBe(false);
  } finally { f.cleanup(); }
 });

 test("failed edits and a thrown cards pass emit only the tick; walking still runs", async () => {
  const f = fixture();
  try {
   await f.run();
   f.captured.length = 0;
   f.discord.failEdits(403);
   f.setNow(4);
   const failed = await f.run();
   expect(JSON.parse(failed.report).escalate.maps[0].cardErrors).toHaveLength(1);
   checkBatch(f.captured.splice(0), {});
   let walked = false;
   const thrown = await f.run({}, {
    escalateMaps: async () => { throw new Error("cards unavailable"); },
    walk: async () => { walked = true; return walkResult(); },
   });
   expect(thrown.exitCode).toBe(2);
   expect(walked).toBe(true);
   checkBatch(f.captured, {});
   expect(f.captured[0].input.payload.outcome).toBe("failed");
  } finally { f.cleanup(); }
 });

 test("an absent card deferred across destinations reports resolved only when closure completes", async () => {
  const f = fixture([]);
  try {
   f.journal(j => {
    const key = `${REPO}:604`;
    j.upsertEscalation({ key, repo: REPO, root: 1, nodeId: "604", messageId: "old-card", channelId: "chan-0", createdAt: AT, status: "open" });
    for (let i = 0; i < 6; i++) j.setEscalationDestination(key, `chan-${i}`, `card-${i}`, AT);
   });
   f.graphNode("604", "closed");
   const deferred = await f.run();
   expect(JSON.parse(deferred.report).escalate.maps[0].deferred).toEqual(["604"]);
   checkBatch(f.captured.splice(0), {});
   expect(f.journal(j => j.getEscalation(REPO, "604")?.status)).toBe("open");
   const completed = await f.run();
   expect(JSON.parse(completed.report).escalate.maps[0].closed).toEqual(["604"]);
   checkBatch(f.captured, { "604": "resolved" });
   expect(f.discord.edits).toHaveLength(6);
  } finally { f.cleanup(); }
 });

 test("successful card state survives a thrown walk", async () => {
  const f = fixture();
  try {
   expect(await f.run({}, { walk: async () => { throw new Error("walk unavailable"); } })).toEqual({ exitCode: 1, report: "ranger tick: walk unavailable\n" });
   checkBatch(f.captured, { "604": "needs-principal" });
  } finally { f.cleanup(); }
 });

 test("absent bus publishes nothing even when a fresh card posts", async () => {
  const f = fixture(["604"], false);
  try {
   const result = await f.run({ makeTransport: () => { throw new Error("must not construct"); } });
   expect(result.exitCode).toBe(0);
   expect(f.discord.posts).toHaveLength(1);
   expect(f.captured).toEqual([]);
  } finally { f.cleanup(); }
 });

 test("unreachable NATS retains every envelope, logs once and preserves tick output; next batch replays", async () => {
  const f = fixture(["604", "605"]);
  const server = createServer();
  try {
   await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
   const port = (server.address() as { port: number }).port;
   await new Promise<void>(resolve => server.close(() => resolve()));
   f.config.bus!.url = `nats://127.0.0.1:${port}`;
   const baseline = await f.run();
   const escalation = JSON.parse(baseline.report).escalate as EscalateResult;
   const result = await f.run({ publisher: undefined }, { escalateMaps: async () => escalation });
   expect(result).toEqual(baseline);
   expect(f.journal(j => j.listEvents().filter(event => event.kind === "ledger-failed"))).toHaveLength(1);
   const records = readFileSync(runLedgerPath(f.config), "utf8").trim().split("\n").map(line => JSON.parse(line));
   expect(records).toHaveLength(3);
   expect(records.every(record => record.op === "put")).toBe(true);
   expect(new Set(records.map(record => record.envelope.payload.correlation_id)).size).toBe(1);
   const memory = new InMemoryTransport();
   const delivered: MyelinEnvelope[] = [];
   await memory.subscribe("local.jc.default.execution.run.finished", async envelope => { delivered.push(envelope); });
   let connections = 0;
   await f.run({ publisher: undefined, makeTransport: () => { connections++; return memory; } }, { escalateMaps: async () => escalation });
   expect(connections).toBe(1);
   expect(delivered).toHaveLength(6);
   expect(new Set(delivered.slice(0, 3).map(envelope => envelope.id))).toEqual(new Set(records.map(record => record.id)));
   expect(delivered.every(envelope => validateExecutionRunFinished(envelope).valid)).toBe(true);
  } finally { f.cleanup(); }
 });

 test("stalled NATS replay shares one connection and two-second ceiling with all card envelopes", async () => {
  const f = fixture(["604", "605"]);
  const sockets: Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); });
  try {
   await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
   f.config.bus!.url = `nats://127.0.0.1:${(server.address() as { port: number }).port}`;
   const baseline = await f.run();
   const escalation = JSON.parse(baseline.report).escalate as EscalateResult;
   const memory = new InMemoryTransport();
   await f.run({ publisher: undefined, makeTransport: () => ({
    publish: async () => { throw new Error("offline"); },
    request: memory.request.bind(memory), close: memory.close.bind(memory),
   }) }, { escalateMaps: async () => escalation });
   const before = f.journal(j => j.listEvents().filter(event => event.kind === "ledger-failed").length);
   const start = performance.now();
   const result = await f.run({ publisher: undefined }, { escalateMaps: async () => escalation });
   expect(result).toEqual(baseline);
   expect(performance.now() - start).toBeLessThan(2800);
   expect(sockets).toHaveLength(1);
   const failed = f.journal(j => j.listEvents().filter(event => event.kind === "ledger-failed"));
   expect(failed).toHaveLength(before + 1);
   expect(failed[0].detail).toContain("timed out after 2000 ms");
   const lines = readFileSync(runLedgerPath(f.config), "utf8").trim().split("\n").map(line => JSON.parse(line));
   expect(lines).toHaveLength(3);
   expect(lines.every(line => line.op === "put")).toBe(true);
  } finally {
   for (const socket of sockets) socket.destroy();
   await new Promise<void>(resolve => server.close(() => resolve()));
   await new Promise(resolve => setTimeout(resolve, 30));
   f.cleanup();
  }
 }, 5000);
});

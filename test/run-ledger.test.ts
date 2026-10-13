import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import {
 createEnvelope, InMemoryTransport, validateEnvelope, validateExecutionRunFinished,
 type ExecutionRunFinishedEvent, type MyelinEnvelope, type TransportPublisher,
} from "@the-metafactory/myelin";
import { runTick, type TickDeps } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import { runLedgerPath, type RunLedgerDeps } from "../src/run-ledger.ts";
import type { EscalateResult } from "../src/escalate.ts";
import type { WalkResult } from "../src/walk.ts";
import { runCli } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const AT = "2026-10-13T07:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixture(bus: string | null = "  principal: jc\n") {
 const dir = mkdtempSync(join(tmpdir(), "ranger-run-ledger-"));
 dirs.push(dir);
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, `maps:\n  - repo: acme/widgets\n    root: 1\nstate:\n  journalPath: ${join(dir, "state.sqlite")}\n${bus === null ? "" : `bus:\n${bus}`}`);
 const config = loadConfig(configPath, {}).config;
 return { configPath, config, spool: runLedgerPath(config), dir };
}
function walkResult(): WalkResult {
 return {
  maps: [{ repo: "acme/widgets", walkMode: "none", gated: false, announced: [], claimed: [], spawnCapExhausted: false, paused: false, errors: [] }],
  spawnCapPerDay: 6,
  probeRequeues: { resumed: [], pending: [], errors: [], lanes: [] },
  intake: { threads: [] },
  ratify: { read: [], closing: [], vetoed: [], recovered: [], deferred: [], errors: [] },
 };
}
function escalation(ok = true): EscalateResult {
 return { generatedAt: AT, maps: [{ repo: "acme/widgets", kind: "cards", ok, posted: [], edited: [], deferred: [], keptOpen: [], cardErrors: [], cards: [] }] };
}
function deps(ledger: RunLedgerDeps = {}, overrides: Partial<TickDeps> = {}): TickDeps {
 return {
  now: () => new Date(AT),
  escalateMaps: async () => escalation(),
  walk: async () => walkResult(),
  ledger: { env: {}, ...ledger },
  ...overrides,
 };
}
function failures(path: string) {
 const journal = new Journal(path);
 try { return journal.listEvents().filter(event => event.kind === "ledger-failed"); }
 finally { journal.close(); }
}
function received(event: ExecutionRunFinishedEvent) {
 return createEnvelope({ ...event.input, sovereignty: event.input.sovereignty as MyelinEnvelope["sovereignty"] });
}
function spoolLines(path: string): { op: string; id: string; subject: string; envelope: MyelinEnvelope }[] {
 return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

describe("tick run ledger", () => {
 test("one valid succeeded job per tick, fresh IDs, with times bracketing both passes", async () => {
  const f = fixture();
  const events: ExecutionRunFinishedEvent[] = [];
  let clock = 0;
  let closed = false;
  const ordered: string[] = [];
  const injected = deps({ publisher: async event => { expect(closed).toBe(false); events.push(event); ordered.push("emit"); } }, {
   now: () => { ordered.push("time"); return new Date(Date.parse(AT) + clock++ * 1000); },
   loadCtx: () => {
    const journal = new Journal(f.config.state.journalPath);
    const close = journal.close.bind(journal);
    journal.close = () => { closed = true; close(); ordered.push("close"); };
    return { config: f.config, journal };
   },
   escalateMaps: async () => { ordered.push("escalate"); return escalation(); },
   walk: async () => { ordered.push("walk"); return walkResult(); },
  });
  const result = await runTick(f.configPath, injected);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.report)).toEqual({ generatedAt: "2026-10-13T07:00:01.000Z", escalate: escalation(), walk: walkResult() });
  expect(ordered).toEqual(["time", "escalate", "walk", "time", "time", "emit", "close"]);
  expect(events).toHaveLength(1);
  const event = events[0];
  expect(event.subject).toBe("local.jc.default.execution.run.finished");
  expect(event.input.source).toBe("jc.ranger.run");
  expect(event.input.type).toBe("execution.run.finished");
  expect(event.input.sovereignty).toEqual({ classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any" });
  expect(event.input.payload).toMatchObject({
   producer: "ranger", ran: { kind: "job", ref: "ranger:tick" }, outcome: "succeeded",
   started_at: AT, ended_at: "2026-10-13T07:00:02.000Z", detail_ref: f.config.state.journalPath,
  });
  expect(event.input.payload.run_id).toMatch(UUID);
  expect(event.input.payload).not.toHaveProperty("serves");
  expect(event.input.payload).not.toHaveProperty("state");
  expect(validateExecutionRunFinished(received(event))).toEqual({ valid: true, errors: [] });
  expect(validateEnvelope(received(event))).toEqual({ valid: true, errors: [] });
  await runTick(f.configPath, deps({ publisher: async event => { events.push(event); } }));
  expect(events).toHaveLength(2);
  expect(events[1].input.payload.run_id).not.toBe(event.input.payload.run_id);
  expect(existsSync(f.spool)).toBe(false);
 });

 for (const scenario of ["escalate throws", "escalate map fails", "walk map errors", "intake error", "intake thread error", "intake gate errors"] as const) {
  test(`exit 2 still walks and emits once: ${scenario}`, async () => {
   const f = fixture();
   const events: ExecutionRunFinishedEvent[] = [];
   let walked = false;
   const options = deps({ publisher: async event => { events.push(event); } }, {
    escalateMaps: async () => {
     if (scenario === "escalate throws") throw new Error("desk locked");
     return escalation(scenario !== "escalate map fails");
    },
    walk: async () => {
     walked = true;
     const result = walkResult();
     if (scenario === "walk map errors") result.maps[0].errors.push("read failed");
     if (scenario === "intake error") result.intake.error = "intake failed";
     if (scenario.startsWith("intake thread") || scenario.startsWith("intake gate")) {
      result.intake.threads.push({ maps: ["acme/widgets#1"], channelId: "1", read: 0, drafted: [], alreadyDrafted: [], answered: [], cursor: null,
       ...(scenario === "intake thread error" ? { error: "thread failed" } : { gate: { read: [], filed: [], discarded: [], refused: [], deferred: [], errors: ["gate failed"] } }),
      });
     }
     return result;
    },
   });
   const result = await runTick(f.configPath, options);
   expect(result.exitCode).toBe(2);
   expect(walked).toBe(true);
   expect(events).toHaveLength(1);
   expect(events[0].input.payload.outcome).toBe("failed");
   expect(validateExecutionRunFinished(received(events[0])).valid).toBe(true);
   if (scenario === "escalate throws") expect(JSON.parse(result.report).escalate).toEqual({ error: "desk locked", maps: [] });
  });
 }

 test("thrown walk emits failed before journal closes; exit-1 error line is preserved", async () => {
  const f = fixture();
  const events: ExecutionRunFinishedEvent[] = [];
  const result = await runTick(f.configPath, deps({ publisher: async event => { events.push(event); } }, {
   walk: async () => { throw new Error("walk exploded"); },
  }));
  expect(result).toEqual({ exitCode: 1, report: "ranger tick: walk exploded\n" });
  expect(events).toHaveLength(1);
  expect(events[0].input.payload.outcome).toBe("failed");
 });

 test("bad config builds nothing, runs neither pass; commander retains stderr and exit 1", async () => {
  const f = fixture();
  writeFileSync(f.configPath, "maps: []\n");
  let calls = 0;
  const result = await runTick(f.configPath, deps({ publisher: async () => { calls++; } }, {
   escalateMaps: async () => { calls++; return escalation(); },
   walk: async () => { calls++; return walkResult(); },
  }));
  expect(result.exitCode).toBe(1);
  expect(result.report).toStartWith("ranger tick: invalid config");
  expect(calls).toBe(0);
  expect(existsSync(f.spool)).toBe(false);
  const cli = await runCli(["tick", "-c", f.configPath], { ...process.env, RANGER_JOURNAL_PATH: f.config.state.journalPath }, f.dir);
  expect(cli.code).toBe(1);
  expect(cli.stdout).toBe("");
  expect(cli.stderr).toBe(result.report);
 });

 test("loadCtx failure emits nothing", async () => {
  let emitted = false;
  const result = await runTick("unused", deps({ publisher: async () => { emitted = true; } }, {
   loadCtx: () => { throw new Error("journal unavailable"); },
  }));
  expect(result).toEqual({ exitCode: 1, report: "ranger tick: journal unavailable\n" });
  expect(emitted).toBe(false);
 });

 for (const correlation of [undefined, "", "fire-2026-10-13-0700", "  ", "11111111-1111-4111-8111-111111111111"]) {
  test(`correlation passes any nonempty string as-is, generates otherwise: ${JSON.stringify(correlation)}`, async () => {
   const f = fixture("  principal: jc\n  stack: work\n");
   let captured!: ExecutionRunFinishedEvent;
   await runTick(f.configPath, deps({ env: { MF_CORRELATION_ID: correlation }, publisher: async event => { captured = event; } }));
   expect(captured.subject).toBe("local.jc.work.execution.run.finished");
   if (correlation) expect(captured.input.payload.correlation_id).toBe(correlation);
   else expect(captured.input.payload.correlation_id).toMatch(UUID);
   expect(validateExecutionRunFinished(received(captured)).valid).toBe(true);
  });
 }

 for (const [goal, node] of [[undefined, undefined], ["", ""], ["goal-17", "repo#42"], ["goal-17", ""], ["", "repo#42"]]) {
  test(`serves contains only nonempty goal/node IDs: ${JSON.stringify([goal, node])}`, async () => {
   const f = fixture();
   let captured!: ExecutionRunFinishedEvent;
   await runTick(f.configPath, deps({ env: { MF_SERVES_GOAL: goal, MF_SERVES_NODE: node }, publisher: async event => { captured = event; } }));
   if (!goal && !node) expect(captured.input.payload).not.toHaveProperty("serves");
   else expect(captured.input.payload.serves).toEqual({ ...(goal ? { goal } : {}), ...(node ? { node } : {}) });
  });
 }

 test("absent bus skips building, transport construction and spool access", async () => {
  const f = fixture(null);
  let calls = 0;
  const result = await runTick(f.configPath, deps({
   env: { MF_SERVES_GOAL: "should-not-build" },
   publisher: async () => { calls++; },
   makeTransport: () => { calls++; throw new Error("must not connect"); },
  }));
  expect(result.exitCode).toBe(0);
  expect(calls).toBe(0);
  expect(existsSync(join(f.dir, "run-ledger"))).toBe(false);
 });

 test("real outbox over InMemoryTransport appends put then ack and delivers once", async () => {
  const f = fixture();
  const memory = new InMemoryTransport();
  const envelopes: MyelinEnvelope[] = [];
  await memory.subscribe("local.jc.default.execution.run.finished", async envelope => { envelopes.push(envelope); });
  const result = await runTick(f.configPath, deps({ makeTransport: () => memory }));
  expect(result.exitCode).toBe(0);
  expect(envelopes).toHaveLength(1);
  expect(validateExecutionRunFinished(envelopes[0])).toEqual({ valid: true, errors: [] });
  expect(validateEnvelope(envelopes[0])).toEqual({ valid: true, errors: [] });
  const records = spoolLines(f.spool);
  expect(records.map(record => record.op)).toEqual(["put", "ack"]);
  expect(records[0].envelope).toEqual(envelopes[0]);
  expect(records[1].id).toBe(envelopes[0].id);
  expect(failures(f.config.state.journalPath)).toEqual([]);
 });

 for (const mode of ["unreachable", "missing creds"] as const) {
  test(`real NATS ${mode}: unchanged report/exit, one failure and replayable put`, async () => {
   const server = createServer();
   await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
   const port = (server.address() as { port: number }).port;
   await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
   const f = fixture(`  principal: jc\n  url: nats://127.0.0.1:${port}\n${mode === "missing creds" ? `  creds: /nonexistent/ranger-node-258.creds\n` : ""}`);
   const baseline = await runTick(f.configPath, deps({ publisher: async () => {} }));
   const result = await runTick(f.configPath, deps());
   expect(result).toEqual(baseline);
   const logged = failures(f.config.state.journalPath);
   expect(logged).toHaveLength(1);
   expect(logged[0].detail).toMatch(mode === "missing creds" ? /credentials.*ENOENT/i : /refused/i);
   const records = spoolLines(f.spool);
   expect(records.map(record => record.op)).toEqual(["put"]);
   expect(validateExecutionRunFinished(records[0].envelope).valid).toBe(true);
   // Next start replays the retained envelope, then emits the current tick.
   const memory = new InMemoryTransport();
   const replayed: MyelinEnvelope[] = [];
   await memory.subscribe(records[0].subject, async event => { replayed.push(event); });
   await runTick(f.configPath, deps({ makeTransport: () => memory }));
   expect(replayed).toHaveLength(2);
   expect(replayed[0]).toEqual(records[0].envelope);
   expect(replayed[1].payload.run_id).not.toBe(replayed[0].payload.run_id);
   expect(spoolLines(f.spool).map(record => record.op)).toEqual(["put", "ack"]);
  });
 }

 test("publisher rejection cannot change exit-0, exit-2 or exit-1 output", async () => {
  for (const code of [0, 2, 1]) {
   const f = fixture();
   const overrides: Partial<TickDeps> = code === 0 ? {} : code === 2
    ? { escalateMaps: async () => { throw new Error("escalate failed"); } }
    : { walk: async () => { throw new Error("walk failed"); } };
   const baseline = await runTick(f.configPath, deps({ publisher: async () => {} }, overrides));
   const result = await runTick(f.configPath, deps({ publisher: async () => { throw new Error("delivery failed"); } }, overrides));
   expect(result).toEqual(baseline);
   expect(failures(f.config.state.journalPath)).toHaveLength(1);
   expect(failures(f.config.state.journalPath)[0].detail).toContain("delivery failed");
  }
 });

 test("stalled NATS connect is bounded, attempted once, and retains this tick during replay", async () => {
  const sockets: Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const f = fixture(`  principal: jc\n  url: nats://127.0.0.1:${port}\n`);
  const memory = new InMemoryTransport();
  try {
   await runTick(f.configPath, deps({ makeTransport: () => ({
    publish: async () => { throw new Error("offline"); },
    request: memory.request.bind(memory), close: memory.close.bind(memory),
   }) }));
   const previous = spoolLines(f.spool)[0].envelope;
   const start = performance.now();
   const result = await runTick(f.configPath, deps());
   expect(result.exitCode).toBe(0);
   expect(performance.now() - start).toBeLessThan(2800);
   expect(sockets).toHaveLength(1);
   expect(failures(f.config.state.journalPath)[0].detail).toContain("timed out after 2000 ms");
   const current = spoolLines(f.spool);
   expect(current.map(record => record.op)).toEqual(["put"]);
   expect(current[0].envelope.payload.run_id).not.toBe(previous.payload.run_id);
  } finally {
   for (const socket of sockets) socket.destroy();
   await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
   await new Promise(resolve => setTimeout(resolve, 30));
  }
 }, 5000);

 for (const stage of ["publisher", "publish", "close", "drain"] as const) {
  test(`whole emit gives up at two seconds during ${stage}`, async () => {
   const f = fixture();
   let release!: () => void;
   const hung = new Promise<void>(resolve => { release = resolve; });
   let published = 0;
   const memory = new InMemoryTransport();
   const inner: TransportPublisher = {
    publish: async () => { published++; if (stage === "publish" || stage === "drain") await hung; },
    request: memory.request.bind(memory),
    close: async () => { if (stage === "close") await hung; },
   };
   if (stage === "drain") {
    // Seed a pending envelope using the actual outbox, so startup replay stalls.
    await runTick(f.configPath, deps({ makeTransport: () => ({ ...inner, publish: async () => { throw new Error("offline"); } }) }));
    const j = new Journal(f.config.state.journalPath);
    // Keep the seeded failure distinct when counting this tick's diagnostic.
    const before = j.listEvents().length;
    j.close();
    expect(before).toBe(1);
   }
   const baseline = await runTick(f.configPath, deps({ publisher: async () => {} }));
   const start = performance.now();
   const result = await runTick(f.configPath, deps(stage === "publisher" ? { publisher: async () => { await hung; } } : { makeTransport: () => inner }));
   const duration = performance.now() - start;
   expect(result).toEqual(baseline);
   expect(duration).toBeGreaterThanOrEqual(1950);
   expect(duration).toBeLessThan(2800);
   const logged = failures(f.config.state.journalPath);
   expect(logged).toHaveLength(stage === "drain" ? 2 : 1);
   expect(logged[0].detail).toContain("timed out after 2000 ms");
   if (stage === "publish") expect(spoolLines(f.spool).map(record => record.op)).toEqual(["put"]);
   release();
   // Allow the late operation to finish; no second diagnostic after journal close.
   await new Promise(resolve => setTimeout(resolve, 30));
   expect(failures(f.config.state.journalPath)).toHaveLength(stage === "drain" ? 2 : 1);
   if (stage === "drain") {
    expect(published).toBe(1);
    expect(spoolLines(f.spool).map(record => record.op)).toEqual(["put"]);
   }
  }, 5000);
 }
});

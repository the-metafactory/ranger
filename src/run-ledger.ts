import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
 createEnvelope,
 createExecutionRunFinished,
 NATSTransport,
 type ExecutionRunFinishedEvent,
 type ExecutionRunFinishedPayloadInput,
 type RunOutcome,
 type Sovereignty,
 type TransportPublisher,
} from "@the-metafactory/myelin";
import { createOutbox } from "@the-metafactory/myelin/outbox";
import { expandHome, type RangerConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { nodeKey } from "./forge-ref.ts";
import { workerLogFile } from "./worker-log.ts";
import type { RunNodeOutcome } from "./worker.ts";
import { AGE_BAND_STATE, ageBand, type EscalateResult } from "./card-sync.ts";

const SOVEREIGNTY: Sovereignty = {
 classification: "local",
 data_residency: "CH",
 max_hop: 0,
 frontier_ok: false,
 model_class: "any",
};
const EMIT_TIMEOUT_MS = 2000;
type BusConfig = NonNullable<RangerConfig["bus"]>;

export interface RunLedgerDeps {
 /** Capture the built subject/input without constructing a transport or outbox. */
 publisher?: (event: ExecutionRunFinishedEvent) => Promise<void>;
 /** Exercise the real outbox over a test transport. */
 makeTransport?: (bus: BusConfig) => TransportPublisher;
 env?: NodeJS.ProcessEnv;
}

/** Dispose an established connection or one that completes after the deadline. */
class LedgerNatsTransport extends NATSTransport {
 private stopped = false;
 private connectOnce?: ReturnType<LedgerNatsTransport["dial"]>;

 protected override establishConnection() {
  return this.connectOnce ??= this.dial();
 }

 private async dial() {
  if (this.stopped) throw new Error("run-ledger transport stopped");
  const connection = await super.establishConnection();
  if (this.stopped) {
   await connection.close();
   throw new Error("run-ledger transport stopped");
  }
  return connection;
 }

 abort(): void {
  this.stopped = true;
  // close() drains and can itself stall; the deadline needs immediate disposal.
  void this.nc?.close().catch(() => {});
 }
}

function natsTransport(bus: BusConfig): LedgerNatsTransport {
 return new LedgerNatsTransport({
  servers: bus.url,
  name: `${bus.principal}-ranger-run`,
  credentials: bus.creds === undefined ? undefined : expandHome(bus.creds),
  requireAuth: bus.creds !== undefined,
  reconnect: false,
 });
}

export function runLedgerPath(config: RangerConfig): string {
 return join(dirname(expandHome(config.state.journalPath)), "run-ledger", "outbox.jsonl");
}

/** The settled run-node status mapping; skipped generations have no envelope. */
export function runNodeRunOutcome(status: RunNodeOutcome["status"]): RunOutcome | null {
 const outcomes: Record<RunNodeOutcome["status"], RunOutcome | null> = {
  success: "succeeded",
  failed: "failed",
  parked: "blocked",
  released: "cancelled",
  "awaiting-merge": "succeeded",
  proposed: "succeeded",
  refused: "blocked",
  skipped: null,
 };
 return outcomes[status];
}

export async function emitTickRunFinished(
 config: RangerConfig,
 journal: Pick<Journal, "recordEvent">,
 run: { startedAt: string; endedAt: string; exitCode: number; escalation?: EscalateResult | null },
 deps: RunLedgerDeps = {},
): Promise<void> {
 return emitRunFinished(config, journal, env => {
  const goal = env.MF_SERVES_GOAL || undefined;
  const node = env.MF_SERVES_NODE || undefined;
  return [{
   run_id: randomUUID(),
   producer: "ranger",
   ran: { kind: "job", ref: "ranger:tick" },
   outcome: run.exitCode === 0 ? "succeeded" : "failed",
   started_at: run.startedAt,
   ended_at: run.endedAt,
   detail_ref: config.state.journalPath,
   ...(goal || node ? { serves: { ...(goal ? { goal } : {}), ...(node ? { node } : {}) } } : {}),
  }, ...cardRunPayloads(config, run, env)];
 }, deps);
}

/** Only completed card actions report state; graph audit findings are not state. */
function cardRunPayloads(
 config: RangerConfig,
 run: { startedAt: string; endedAt: string; escalation?: EscalateResult | null },
 env: NodeJS.ProcessEnv,
): ExecutionRunFinishedPayloadInput[] {
 return (run.escalation?.maps ?? []).flatMap(map => {
  const cards = new Map(map.cards.map(card => [card.nodeId, card]));
  const closed = new Set(map.closed);
  return [...new Set([...map.posted, ...map.edited, ...map.keptOpen, ...map.closed])].map(id => {
   const node = nodeKey(map.repo, id);
   const card = cards.get(id);
   if (!closed.has(id) && card === undefined) throw new Error(`card state missing age for ${node}`);
   return {
    run_id: randomUUID(),
    producer: "ranger",
    ran: { kind: "node" as const, ref: node },
    serves: { node, ...(env.MF_SERVES_GOAL ? { goal: env.MF_SERVES_GOAL } : {}) },
    outcome: "blocked" as const,
    state: { subject: node, value: closed.has(id) ? "resolved" : AGE_BAND_STATE[ageBand(card!.ageDays)] },
    started_at: run.startedAt,
    ended_at: run.endedAt,
    detail_ref: config.state.journalPath,
   };
  });
 });
}

export async function emitNodeRunFinished(
 config: RangerConfig,
 journal: Pick<Journal, "recordEvent" | "path">,
 run: { repo: string; nodeId: string; generation: number; startedAt: string; endedAt: string; outcome: RunOutcome; mapRoot?: { id: string; serves?: unknown } },
 deps: RunLedgerDeps = {},
): Promise<void> {
 return emitRunFinished(config, journal, env => {
  const node = nodeKey(run.repo, run.nodeId);
  const root = run.mapRoot;
  const rootGoal = root?.serves;
  const validRootGoal = typeof rootGoal === "string" && /^G\d+$/.test(rootGoal) && rootGoal === rootGoal.trim();
  if (root !== undefined && rootGoal !== undefined && !validRootGoal) {
   try {
    journal.recordEvent("ledger-root-serves-invalid", {
     repo: run.repo, nodeId: root.id,
     detail: `ignoring malformed serves on map root ${nodeKey(run.repo, root.id)}; expected G<n>`,
    });
   } catch {} // A diagnostic must never suppress the envelope or change the run result.
  }
  const goal = validRootGoal ? rootGoal : env.MF_SERVES_GOAL;
  return [{
   run_id: randomUUID(),
   producer: "ranger",
   ran: { kind: "node", ref: node },
   serves: { node, ...(goal ? { goal } : {}) },
   outcome: run.outcome,
   started_at: run.startedAt,
   ended_at: run.endedAt,
   detail_ref: workerLogFile(journal.path, run.repo, run.nodeId, run.generation),
  }];
 }, deps);
}

/**
 * The result a job reported, as the ledger may carry it (myelin v0.10.0,
 * soma#842): a `soma:` relative path, and only on a succeeded run. Anything
 * else (a URL, a path with `..`) stays in the journal and off the envelope,
 * whose builder would refuse the whole emit for it.
 */
export function ledgerResultRef(result: string | null | undefined, outcome: RunOutcome): string | undefined {
 if (outcome !== "succeeded" || result == null) return undefined;
 const ref = result.trim();
 const path = ref.slice("soma:".length);
 const ok = ref.startsWith("soma:") && path.length > 0 && !path.startsWith("/")
  && !path.split("/").includes("..") && !path.includes("\\") && !path.includes("\0") && !/\s/.test(ref);
 return ok ? ref : undefined;
}

/**
 * One envelope per finished job run (node #301), `run_id` fixed at enqueue: the job name is `ran.ref`,
 * the session log the `detail_ref`. The envelope has no free text, so why a
 * run failed (budget, exit, crash) stays in the journal row.
 */
export async function emitJobRunFinished(
 config: RangerConfig,
 journal: Pick<Journal, "recordEvent">,
 run: { runUuid: string; name: string; startedAt: string; endedAt: string; outcome: RunOutcome; result?: string | null; log?: string | null },
 deps: RunLedgerDeps = {},
): Promise<void> {
 return emitRunFinished(config, journal, env => {
  const goal = env.MF_SERVES_GOAL || undefined;
  const resultRef = ledgerResultRef(run.result, run.outcome);
  return [{
   // The run's own id, so a repeat after a crash is the same run to a consumer.
   run_id: run.runUuid,
   producer: "ranger",
   ran: { kind: "job", ref: run.name },
   outcome: run.outcome,
   started_at: run.startedAt,
   ended_at: run.endedAt,
   detail_ref: run.log ?? config.state.journalPath,
   ...(goal ? { serves: { goal } } : {}),
   ...(resultRef === undefined ? {} : { result_ref: resultRef }),
  }];
 }, deps);
}

/** One fail-open funnel, with payload construction deferred until bus is configured. */
async function emitRunFinished(
 config: RangerConfig,
 journal: Pick<Journal, "recordEvent">,
 payloads: (env: NodeJS.ProcessEnv) => ExecutionRunFinishedPayloadInput[],
 deps: RunLedgerDeps,
): Promise<void> {
 const bus = config.bus;
 if (bus === undefined) return;
 let active = true;
 let failure: string | undefined;
 let abort = () => {};
 const log = (detail: string) => {
  if (active) failure ??= detail;
 };
 let timer: ReturnType<typeof setTimeout> | undefined;
 const deadline = new Promise<void>((resolve) => {
  timer = setTimeout(() => {
   failure = "run-ledger emit timed out after 2000 ms";
   active = false;
   try { abort(); } catch {} // Disposal is also fail-open.
   resolve();
  }, EMIT_TIMEOUT_MS);
 });
 const emit = (async () => {
  try {
   const env = deps.env ?? process.env;
   const correlation_id = env.MF_CORRELATION_ID || randomUUID();
   const events = payloads(env).map(payload => createExecutionRunFinished({
    source: `${bus.principal}.ranger.run`,
    principal: bus.principal,
    stack: bus.stack,
    sovereignty: SOVEREIGNTY,
    payload: {
     ...payload,
     correlation_id,
    },
   }));
   if (deps.publisher !== undefined) {
    const publisher = deps.publisher;
    await Promise.all(events.map(async event => {
     try { await publisher(event); }
     catch (error) { log(`run-ledger emit failed: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    return;
   }
   const inner = (deps.makeTransport ?? natsTransport)(bus);
   abort = () => {
    if (inner instanceof LedgerNatsTransport) inner.abort();
    else void inner.close().catch(() => {});
   };
   const envelopes = events.map(event => createEnvelope({ ...event.input, sovereignty: SOVEREIGNTY }));
   const currentIds = new Set(envelopes.map(envelope => envelope.id));
   const outbox = createOutbox({ path: runLedgerPath(config), log, inner: {
    publish: async (subject, pending) => {
     if (currentIds.has(pending.id)) {
      await outbox.drained;
      if (!active) throw new Error("run-ledger emit timed out");
     }
     await inner.publish(subject, pending);
    },
    request: (subject, pending, options) => inner.request(subject, pending, options),
    close: () => inner.close(),
   } });
   try {
    // Start every append before waiting for any delivery: a stalled replay
    // or connection must retain the entire tick's batch in the spool.
    // NATS connects lazily and once for all envelopes in this emit.
    await Promise.all(events.map((event, i) => outbox.publish(event.subject, envelopes[i])));
   } finally {
    if (active) await outbox.close();
   }
  } catch (error) {
   log(`run-ledger emit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
 })();
 try {
  await Promise.race([emit, deadline]);
 } finally {
  clearTimeout(timer);
  active = false;
  if (failure !== undefined) {
   try { journal.recordEvent("ledger-failed", { detail: failure }); }
   catch {} // Neither delivery nor its diagnostic may change the run's result.
  }
 }
}

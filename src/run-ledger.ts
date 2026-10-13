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
 run: { startedAt: string; endedAt: string; exitCode: number },
 deps: RunLedgerDeps = {},
): Promise<void> {
 return emitRunFinished(config, journal, env => {
  const goal = env.MF_SERVES_GOAL || undefined;
  const node = env.MF_SERVES_NODE || undefined;
  return {
   run_id: randomUUID(),
   producer: "ranger",
   ran: { kind: "job", ref: "ranger:tick" },
   outcome: run.exitCode === 0 ? "succeeded" : "failed",
   started_at: run.startedAt,
   ended_at: run.endedAt,
   detail_ref: config.state.journalPath,
   ...(goal || node ? { serves: { ...(goal ? { goal } : {}), ...(node ? { node } : {}) } } : {}),
  };
 }, deps);
}

export async function emitNodeRunFinished(
 config: RangerConfig,
 journal: Pick<Journal, "recordEvent" | "path">,
 run: { repo: string; nodeId: string; generation: number; startedAt: string; endedAt: string; outcome: RunOutcome },
 deps: RunLedgerDeps = {},
): Promise<void> {
 return emitRunFinished(config, journal, env => {
  const node = nodeKey(run.repo, run.nodeId);
  return {
   run_id: randomUUID(),
   producer: "ranger",
   ran: { kind: "node", ref: node },
   serves: { node, ...(env.MF_SERVES_GOAL ? { goal: env.MF_SERVES_GOAL } : {}) },
   outcome: run.outcome,
   started_at: run.startedAt,
   ended_at: run.endedAt,
   detail_ref: workerLogFile(journal.path, run.repo, run.nodeId, run.generation),
  };
 }, deps);
}

/** One fail-open funnel, with payload construction deferred until bus is configured. */
async function emitRunFinished(
 config: RangerConfig,
 journal: Pick<Journal, "recordEvent">,
 payload: (env: NodeJS.ProcessEnv) => ExecutionRunFinishedPayloadInput,
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
   const event = createExecutionRunFinished({
    source: `${bus.principal}.ranger.run`,
    principal: bus.principal,
    stack: bus.stack,
    sovereignty: SOVEREIGNTY,
    payload: {
     ...payload(env),
     ...(env.MF_CORRELATION_ID ? { correlation_id: env.MF_CORRELATION_ID } : {}),
    },
   });
   if (deps.publisher !== undefined) {
    await deps.publisher(event);
    return;
   }
   const inner = (deps.makeTransport ?? natsTransport)(bus);
   abort = () => {
    if (inner instanceof LedgerNatsTransport) inner.abort();
    else void inner.close().catch(() => {});
   };
   const envelope = createEnvelope({ ...event.input, sovereignty: SOVEREIGNTY });
   const outbox = createOutbox({ path: runLedgerPath(config), log, inner: {
    publish: async (subject, pending) => {
     if (pending.id === envelope.id) {
      await outbox.drained;
      if (!active) throw new Error("run-ledger emit timed out");
     }
     await inner.publish(subject, pending);
    },
    request: (subject, pending, options) => inner.request(subject, pending, options),
    close: () => inner.close(),
   } });
   try {
    // Spool this run before waiting for replay. Its inner publish awaits
    // drained, so a stalled replay retains this run too. NATS connects lazily
    // and once per emit, including a failed connection or missing credentials.
    await outbox.publish(event.subject, envelope);
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

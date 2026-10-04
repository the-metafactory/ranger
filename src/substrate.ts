/**
 * Substrate selection (node #45): route implement sessions, fix passes and
 * sage reviews across Claude, Codex and Pi by remaining 5h/7d quota.
 *
 * Strong substrates (Claude, Codex) are eligible while every reported
 * window's used% is under its max-used threshold; once both are capped, Pi is
 * the fallback. Review selection prefers a substrate other than the one that
 * wrote the PR head; when no other substrate is eligible the review runs on
 * the author's own (best-effort independence, not a guarantee).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig } from "./config.ts";
import { runCmd } from "./exec.ts";
import type { Journal, SubstrateReading } from "./journal.ts";
import type { SubstrateName } from "./store/schema.ts";
import { workerHostEnv } from "./worker-env.ts";
import { isFresh, STRONG_SUBSTRATES, type SubstrateConfig } from "./substrate-policy.ts";

// ---- types ----

export type { SubstrateName };
export * from "./substrate-policy.ts";

export interface QuotaWindow {
 kind: "five_hour" | "seven_day";
 /** 0–100 usage percent. */
 usedPct: number;
 /** Epoch seconds when this window resets. */
 resetsAt: number;
}

export interface QuotaReading {
 substrate: SubstrateName;
 readAt: Date;
 windows: QuotaWindow[];
 capped: boolean;
 /** When capped: the reset the substrate itself reported (epoch seconds). */
 cappedUntil: number | null;
}

/** Quota readers, injectable so tests never spawn the real CLIs. */
export interface SubstrateReaders {
 codex?: () => Promise<QuotaReading>;
 claude?: () => Promise<QuotaReading>;
}

// ---- Codex quota parser ----

export interface CodexRateLimitEntry {
 usedPercent: number;
 windowDurationMins: number;
 resetsAt: number;
}

/** The `result` of `account/rateLimits/read` (only the fields ranger reads). */
export interface CodexRateLimitsResponse {
 ordinaryUsageAllowed?: boolean;
 rateLimits: {
  primary: CodexRateLimitEntry | null;
  secondary: CodexRateLimitEntry | null;
  rateLimitReachedType: string | null;
 };
}

/** Windows are identified by duration (300 = 5h, 10080 = 7d), never by slot. */
function codexWindowKind(mins: number): QuotaWindow["kind"] | null {
 if (mins === 300) return "five_hour";
 if (mins === 10080) return "seven_day";
 return null;
}

export function parseCodexQuota(resp: CodexRateLimitsResponse, now = new Date()): QuotaReading {
 const windows: QuotaWindow[] = [];
 for (const slot of [resp.rateLimits.primary, resp.rateLimits.secondary]) {
  if (slot === null) continue;
  const kind = codexWindowKind(slot.windowDurationMins);
  if (kind === null) continue;
  windows.push({ kind, usedPct: slot.usedPercent, resetsAt: slot.resetsAt });
 }
 const capped =
  resp.rateLimits.rateLimitReachedType !== null || resp.ordinaryUsageAllowed === false;
 return {
  substrate: "codex",
  readAt: now,
  windows,
  capped,
  cappedUntil: capped ? earliestReset(windows) : null,
 };
}

function earliestReset(windows: QuotaWindow[]): number | null {
 return windows.length === 0 ? null : Math.min(...windows.map((w) => w.resetsAt));
}

/**
 * `codex app-server` speaks newline-delimited JSON-RPC on stdio. Split the
 * complete lines off a buffer; the trailing partial line stays for the next
 * chunk.
 */
export function drainJsonLines(buffer: string): { messages: unknown[]; rest: string } {
 const messages: unknown[] = [];
 let start = 0;
 for (;;) {
  const end = buffer.indexOf("\n", start);
  if (end < 0) break;
  const line = buffer.slice(start, end).trim();
  start = end + 1;
  if (line.length === 0) continue;
  try {
   messages.push(JSON.parse(line));
  } catch {
   // a non-JSON line (a log line) is not a protocol message
  }
 }
 return { messages, rest: buffer.slice(start) };
}

const CODEX_RATE_LIMITS_ID = 3;

/**
 * Read Codex quota (free): spawn `codex app-server`, send `initialize`, the
 * `initialized` notification and `account/rateLimits/read`, parse the reply.
 */
export function readCodexQuota(opts: { timeoutMs?: number } = {}): Promise<QuotaReading> {
 const timeout = opts.timeoutMs ?? 30_000;
 return new Promise((resolve, reject) => {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  let done = false;
  const settle = (fn: () => void) => {
   if (done) return;
   done = true;
   clearTimeout(timer);
   child.kill("SIGTERM");
   fn();
  };
  const timer = setTimeout(
   () => settle(() => reject(new Error("codex app-server timed out"))),
   timeout,
  );

  child.stdout.on("data", (chunk: Buffer) => {
   const drained = drainJsonLines(buffer + chunk.toString());
   buffer = drained.rest;
   for (const msg of drained.messages) {
    const m = msg as { id?: number; result?: unknown; error?: { message?: string } };
    if (m.id !== CODEX_RATE_LIMITS_ID) continue;
    if (m.result === undefined) {
     settle(() => reject(new Error(`codex rateLimits/read failed: ${m.error?.message ?? "no result"}`)));
     return;
    }
    settle(() => {
     try {
      resolve(parseCodexQuota(m.result as CodexRateLimitsResponse));
     } catch (e) {
      reject(e);
     }
    });
    return;
   }
  });
  child.on("error", (err) =>
   settle(() => reject(new Error(`codex app-server failed to spawn: ${err.message}`))),
  );
  child.on("close", () =>
   settle(() => reject(new Error("codex app-server exited before responding"))),
  );

  // A spawn failure or early exit surfaces as EPIPE on stdin: settle, never throw.
  child.stdin.on("error", (err) =>
   settle(() => reject(new Error(`codex app-server stdin failed: ${err.message}`))),
  );
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
   jsonrpc: "2.0",
   id: 1,
   method: "initialize",
   params: { clientInfo: { name: "ranger", version: "1.0.0" } },
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  send({ jsonrpc: "2.0", id: CODEX_RATE_LIMITS_ID, method: "account/rateLimits/read", params: {} });
 });
}

// ---- Claude quota parser ----

export interface ClaudeRateLimitEvent {
 type: "rate_limit_event";
 rate_limit_info: {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: {
   five_hour?: { utilization: number; resetsAt: number };
   seven_day?: { utilization: number; resetsAt: number };
  };
 };
}

/**
 * Statuses that still allow requests. `allowed_warning` is Claude's
 * approaching-the-limit notice, not a cap: the max-used thresholds already
 * keep a near-limit Claude out of selection. Anything else (`rejected`, or a
 * status ranger does not know) counts as capped, so the rule fails closed.
 */
const CLAUDE_UNCAPPED_STATUSES = new Set(["allowed", "allowed_warning"]);

export function isClaudeCappedStatus(status: string): boolean {
 return !CLAUDE_UNCAPPED_STATUSES.has(status);
}

export function parseClaudeRateLimitEvent(event: ClaudeRateLimitEvent, now = new Date()): QuotaReading {
 const info = event.rate_limit_info;
 const windows: QuotaWindow[] = [];
 for (const kind of ["five_hour", "seven_day"] as const) {
  const w = info.unifiedWindows?.[kind];
  if (w !== undefined) {
   windows.push({ kind, usedPct: Math.round(w.utilization * 100), resetsAt: w.resetsAt });
  }
 }
 const capped = isClaudeCappedStatus(info.status);
 return {
  substrate: "claude",
  readAt: now,
  windows,
  capped,
  cappedUntil: capped ? (info.resetsAt ?? earliestReset(windows)) : null,
 };
}

/**
 * Every top-level `rate_limit_event` in a Claude stream-json stdout, in
 * order. Only whole lines that parse as an event count: model and tool text
 * sits inside JSON strings, so a worker cannot forge one.
 */
export function* claudeRateLimitEvents(lines: string[]): Generator<ClaudeRateLimitEvent> {
 for (const line of lines) {
  if (!line.includes("rate_limit_event")) continue;
  try {
   const obj = JSON.parse(line) as { type?: string; rate_limit_info?: { status?: unknown } };
   if (obj.type === "rate_limit_event" && typeof obj.rate_limit_info?.status === "string") {
    yield obj as ClaudeRateLimitEvent;
   }
  } catch {
   continue;
  }
 }
}

/**
 * The only Claude stream-json lines ranger reads: rate_limit_events and the
 * final result event. A worker run keeps just these as they stream (the
 * verbose stream carries every tool result). A quoted `"type":"result"`
 * inside a JSON string is escaped, so only a real key matches; the parsers
 * re-check the top-level type.
 */
export function isClaudeSignalLine(line: string): boolean {
 return line.includes("rate_limit_event") || line.includes('"type":"result"');
}

/**
 * The final summary text of a Claude stream-json run (its `result` event),
 * so worker logs read as the plain `claude -p` output did. Raw stdout when
 * the stream carries no result event.
 */
export function extractClaudeResultText(lines: string[], raw: string): string {
 for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i].trim();
  if (!line.startsWith("{")) continue;
  try {
   const obj = JSON.parse(line) as { type?: string; result?: unknown };
   if (obj.type === "result" && typeof obj.result === "string") return obj.result;
  } catch {
   continue;
  }
 }
 return raw;
}

/** Cache the last rate_limit_event of a Claude run as the current reading. */
export function cacheClaudeRateLimitEvents(lines: string[], journal: Journal, now = new Date()): void {
 let latest: ClaudeRateLimitEvent | null = null;
 for (const event of claudeRateLimitEvents(lines)) latest = event;
 if (latest !== null) persistReading(journal, parseClaudeRateLimitEvent(latest, now));
}

/**
 * Probe Claude's quota with a one-turn haiku call. It runs in a fresh private
 * scratch dir (mkdtemp, mode 0700) so no planted project settings or hooks
 * load, with the worker host env (no RANGER_* tokens). A capped probe may
 * exit non-zero, so the stream is read before the exit code.
 */
export async function probeClaudeQuota(opts: { timeoutMs?: number } = {}): Promise<QuotaReading> {
 const scratch = mkdtempSync(join(tmpdir(), "ranger-probe-"));
 let result: Awaited<ReturnType<typeof runCmd>>;
 try {
  result = await runCmd(
   "claude",
   ["-p", "ok", "--model", "haiku", "--output-format", "stream-json", "--verbose"],
   { cwd: scratch, env: workerHostEnv(), timeoutMs: opts.timeoutMs ?? 60_000 },
  );
 } finally {
  rmSync(scratch, { recursive: true, force: true });
 }
 for (const event of claudeRateLimitEvents(result.stdout.split("\n"))) {
  return parseClaudeRateLimitEvent(event);
 }
 throw new Error(
  `claude haiku probe emitted no rate_limit_event (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-300)}`,
 );
}

// ---- reading persistence ----

/**
 * Persist a fresh reading. A capped-until still in the future survives a
 * fresh reading: it is its own eligibility condition (node #45 brief).
 */
export function persistReading(journal: Journal, reading: QuotaReading): void {
 const prior = journal.getSubstrateReading(reading.substrate);
 const priorUntil =
  prior?.cappedUntil != null && Date.parse(prior.cappedUntil) > reading.readAt.getTime()
   ? prior.cappedUntil
   : null;
 const fiveHour = reading.windows.find((w) => w.kind === "five_hour");
 const sevenDay = reading.windows.find((w) => w.kind === "seven_day");
 const resets = earliestReset(reading.windows);
 journal.upsertSubstrateReading({
  substrate: reading.substrate,
  readAt: reading.readAt.toISOString(),
  fiveHourUsedPct: fiveHour?.usedPct ?? null,
  sevenDayUsedPct: sevenDay?.usedPct ?? null,
  resetsAt: resets === null ? null : epochIso(resets),
  capped: reading.capped,
  cappedUntil: reading.cappedUntil !== null ? epochIso(reading.cappedUntil) : priorUntil,
 });
}

function epochIso(seconds: number): string {
 return new Date(seconds * 1000).toISOString();
}

// ---- per-substrate command builders ----

/**
 * The worker command + leading args for a substrate; the caller appends the
 * prompt as the final arg. Headless flags follow sage's substrates
 * (sage src/substrate/{claude,codex,pi}.ts).
 */
export function workerCommandFor(substrate: SubstrateName, config: RangerConfig): string[] {
 switch (substrate) {
  case "claude":
   return ["claude", "-p", "--output-format", "stream-json", "--verbose"];
  case "codex":
   return ["codex", "exec"];
  case "pi":
   return ["pi", "-p", "--provider", config.substrates.pi.provider, "--model", config.substrates.pi.model];
 }
}

// ---- refresh ----

function readerFor(substrate: "claude" | "codex", readers: SubstrateReaders | undefined) {
 return substrate === "codex"
  ? (readers?.codex ?? (() => readCodexQuota()))
  : (readers?.claude ?? (() => probeClaudeQuota()));
}

/**
 * Refresh a strong substrate's reading when it is missing or stale. A failed
 * read persists nothing: the stale or missing reading stays, and selection
 * treats it as ineligible (fail closed).
 */
export async function ensureFreshReading(
 substrate: SubstrateName,
 journal: Journal,
 config: SubstrateConfig,
 now: Date,
 readers?: SubstrateReaders,
): Promise<void> {
 if (substrate === "pi") return;
 const existing = journal.getSubstrateReading(substrate);
 if (existing !== null && isFresh(existing, config, now)) return;
 try {
  persistReading(journal, await readerFor(substrate, readers)());
 } catch {
  // fail closed: see above
 }
}

/** Refresh both strong substrates concurrently, then return every reading. */
export async function freshReadings(
 journal: Journal,
 config: SubstrateConfig,
 now: Date,
 readers?: SubstrateReaders,
): Promise<SubstrateReading[]> {
 await Promise.all(
  STRONG_SUBSTRATES.map((name) => ensureFreshReading(name, journal, config, now, readers)),
 );
 return journal.listSubstrateReadings();
}

// ---- mid-session cap detection ----

export interface CapSignal {
 substrate: SubstrateName;
 resetsAt: number | null;
}

/** A Claude stream's own cap signal: a rate_limit_event with a capped status (see isClaudeCappedStatus). */
export function detectClaudeCap(lines: string[]): CapSignal | null {
 for (const event of claudeRateLimitEvents(lines)) {
  if (isClaudeCappedStatus(event.rate_limit_info.status)) {
   const reading = parseClaudeRateLimitEvent(event);
   return { substrate: "claude", resetsAt: reading.cappedUntil };
  }
 }
 return null;
}

/**
 * After a failed run or review: was it the substrate's limit? Only the
 * substrate's own structured signal answers — the Claude stream's
 * rate_limit_event, else a fresh quota read (Codex `rateLimitReachedType` /
 * `ordinaryUsageAllowed`, the Claude probe's status). Never the run's text,
 * which carries worker- and repo-controlled output. The fresh reading is
 * persisted either way.
 */
export async function confirmCap(
 substrate: SubstrateName,
 journal: Journal,
 opts: { lines?: string[]; readers?: SubstrateReaders },
): Promise<CapSignal | null> {
 if (substrate === "pi") return null;
 if (substrate === "claude" && opts.lines !== undefined) {
  const cap = detectClaudeCap(opts.lines);
  if (cap !== null) return cap;
 }
 let reading: QuotaReading;
 try {
  reading = await readerFor(substrate, opts.readers)();
 } catch {
  return null; // no confirming signal: an ordinary failure
 }
 persistReading(journal, reading);
 return reading.capped ? { substrate, resetsAt: reading.cappedUntil } : null;
}

/** Fallback cap window when the substrate reported no reset time. */
const DEFAULT_CAP_MS = 30 * 60_000;

/** Mark a substrate capped until its reported reset (or 30 minutes). */
export function markSubstrateCapped(
 journal: Journal,
 substrate: SubstrateName,
 resetsAt: number | null,
 now: Date,
): void {
 const reading = journal.getSubstrateReading(substrate);
 const until =
  resetsAt !== null && resetsAt * 1000 > now.getTime()
   ? epochIso(resetsAt)
   : new Date(now.getTime() + DEFAULT_CAP_MS).toISOString();
 journal.upsertSubstrateReading({
  substrate,
  readAt: reading?.readAt ?? now.toISOString(),
  fiveHourUsedPct: reading?.fiveHourUsedPct ?? null,
  sevenDayUsedPct: reading?.sevenDayUsedPct ?? null,
  resetsAt: reading?.resetsAt ?? until,
  capped: true,
  cappedUntil: until,
 });
}

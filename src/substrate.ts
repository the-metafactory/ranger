/**
 * Substrate selection (node #45): route implement sessions, fix passes and
 * sage reviews across Claude, Codex and Pi by remaining 5h/7d quota.
 *
 * Strong substrates (Claude, Codex) are eligible while their reading is
 * fresh, reports at least one window, and every window's used% is under its
 * max-used threshold. Once neither is eligible (over threshold, stale or
 * failed read, no windows, or capped), Pi is the fallback. Review selection
 * prefers a substrate other than the one that wrote the PR head; when no
 * other substrate is eligible the review runs on the author's own
 * (best-effort independence, not a guarantee).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig } from "./config.ts";
import { runCmd, splitLines, type RunOptions, type RunResult } from "./exec.ts";
import type { Journal, SubstrateReading } from "./journal.ts";
import type { SubstrateName } from "./store/schema.ts";
import { workerHostEnv } from "./worker-env.ts";
import {
 activeCappedUntil,
 describeReadings,
 isFresh,
 STRONG_SUBSTRATES,
 type SelectionInput,
 type SubstrateConfig,
} from "./substrate-policy.ts";

// ---- types ----

export type { SubstrateName };

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

/**
 * A window of a duration ranger does not know throws: dropping it would leave
 * a reading that looks unlimited, so the read fails and the missing reading
 * keeps Codex ineligible (fail closed).
 */
export function parseCodexQuota(resp: CodexRateLimitsResponse, now = new Date()): QuotaReading {
 const windows: QuotaWindow[] = [];
 for (const slot of [resp.rateLimits.primary, resp.rateLimits.secondary]) {
  if (slot === null) continue;
  const kind = codexWindowKind(slot.windowDurationMins);
  if (kind === null) {
   throw new Error(`codex reports a ${slot.windowDurationMins}-minute window ranger cannot judge`);
  }
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
 const { lines, rest } = splitLines(buffer);
 const messages: unknown[] = [];
 for (const raw of lines) {
  const line = raw.trim();
  if (line.length === 0) continue;
  // a non-JSON line (a log line) is not a protocol message
  const msg = tryParseJson(line);
  if (msg !== undefined) messages.push(msg);
 }
 return { messages, rest };
}

/** A line's JSON value, or undefined when it is not JSON. */
function tryParseJson(line: string): unknown {
 try {
  return JSON.parse(line) as unknown;
 } catch {
  return undefined;
 }
}

const CODEX_RATE_LIMITS_ID = 3;

/**
 * Read Codex quota (free): spawn `codex app-server`, send `initialize`, the
 * `initialized` notification and `account/rateLimits/read`, parse the reply.
 * Like the Claude probe it runs in a private scratch dir with the worker host
 * env (no RANGER_* tokens; HOME and CODEX_* pass, so codex finds its auth).
 */
export function readCodexQuota(opts: { timeoutMs?: number } = {}): Promise<QuotaReading> {
 const timeout = opts.timeoutMs ?? 30_000;
 return new Promise((resolve, reject) => {
  const scratch = mkdtempSync(join(tmpdir(), "ranger-codex-"));
  const child = spawn("codex", ["app-server"], {
   cwd: scratch,
   env: workerHostEnv(),
   stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = "";
  let done = false;
  const settle = (fn: () => void) => {
   if (done) return;
   done = true;
   clearTimeout(timer);
   child.kill("SIGTERM");
   fn();
   try {
    rmSync(scratch, { recursive: true, force: true });
   } catch {
    // a leftover empty scratch dir never blocks the read
   }
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

/**
 * A `rate_limit_event` line of `claude -p … --output-format stream-json
 * --verbose`, shaped after the sample captured for the node #45 brief.
 */
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
  const obj = tryParseJson(line) as
   | { type?: string; rate_limit_info?: { status?: unknown } }
   | undefined;
  if (obj?.type === "rate_limit_event" && typeof obj.rate_limit_info?.status === "string") {
   yield obj as ClaudeRateLimitEvent;
  }
 }
}

/**
 * The only Claude stream-json lines ranger reads: rate_limit_events and the
 * final result event. A worker run keeps just these as they stream (the
 * verbose stream carries every tool result). A quoted `"type":...` key
 * inside a JSON string is escaped, so only a real key matches; the parsers
 * re-check the top-level type.
 */
export function isClaudeSignalLine(line: string): boolean {
 return line.includes('"type":"rate_limit_event"') || line.includes('"type":"result"');
}

/**
 * The final summary text of a Claude stream-json run (its `result` event),
 * so worker logs read as the plain `claude -p` output did. `fallback` when
 * the stream carries no result event (a crash before it).
 */
export function extractClaudeResultText(lines: string[], fallback: string): string {
 for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i].trim();
  if (!line.startsWith("{")) continue;
  const obj = tryParseJson(line) as { type?: string; result?: unknown } | undefined;
  if (obj?.type === "result" && typeof obj.result === "string") return obj.result;
 }
 return fallback;
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
 const priorUntil = prior === null ? null : activeCappedUntil(prior, reading.readAt);
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
 * prompt as the final arg. Claude and Pi take sage's headless flags (sage
 * src/substrate/{claude,pi}.ts). Codex does not: sage only reviews, and a bare
 * `codex exec` runs in Codex's read-only sandbox, where a build session cannot
 * write. A worker gets `--sandbox workspace-write` (its cwd, the worktree) plus
 * the canonical clone's `.git` via `--add-dir`, because a worktree commits
 * into the common git dir, which lies outside the worktree.
 */
export function workerCommandFor(
 substrate: SubstrateName,
 config: RangerConfig,
 opts: { writableGitDir?: string } = {},
): string[] {
 switch (substrate) {
  case "claude":
   return ["claude", "-p", "--output-format", "stream-json", "--verbose"];
  case "codex":
   return [
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    ...(opts.writableGitDir !== undefined ? ["--add-dir", opts.writableGitDir] : []),
   ];
  case "pi":
   return ["pi", "-p", "--provider", config.substrates.pi.provider, "--model", config.substrates.pi.model];
 }
}

/** How a worker run's output is read on its substrate. */
export interface WorkerOutput {
 /** Run options the substrate's output needs (stream filtering). */
 runOptions: Pick<RunOptions, "keepStdoutLine">;
 /**
  * The run as the worker log carries it, plus the stream lines the
  * substrate's quota and cap signals are read from (none for plain output).
  * Caches any quota reading the stream carries.
  */
 read(raw: RunResult, journal: Journal): { result: RunResult; lines?: string[] };
}

const PLAIN_OUTPUT: WorkerOutput = { runOptions: {}, read: (raw) => ({ result: raw }) };

/**
 * A Claude worker streams JSON, kept to its signal lines as it runs: its
 * rate_limit_events are the current reading and its cap signal, and its
 * result event is the summary. A run that crashes before the result event
 * logs its unfiltered stdout tail and stderr instead.
 */
const CLAUDE_STREAM_OUTPUT: WorkerOutput = {
 runOptions: { keepStdoutLine: isClaudeSignalLine },
 read(raw, journal) {
  const lines = raw.stdout.split("\n");
  cacheClaudeRateLimitEvents(lines, journal);
  return {
   result: { ...raw, stdout: extractClaudeResultText(lines, raw.stdoutTail ?? raw.stdout) },
   lines,
  };
 },
};

/** The output reader for a substrate; an unlabelled run is plain text. */
export function workerOutputFor(substrate: SubstrateName | undefined): WorkerOutput {
 return substrate === "claude" ? CLAUDE_STREAM_OUTPUT : PLAIN_OUTPUT;
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

/**
 * Refresh the readings, leave out the substrates capped earlier in this run,
 * and pick with `pick` (selectForBuild, or selectForReview for a head).
 * `chosenOn` describes every reading the choice was made on.
 */
export async function selectSubstrate(
 journal: Journal,
 opts: {
  config: SubstrateConfig;
  excluded: ReadonlySet<SubstrateName>;
  readers: SubstrateReaders | undefined;
  pick: (input: SelectionInput) => SubstrateName;
 },
): Promise<{ substrate: SubstrateName; chosenOn: string }> {
 const { config, excluded, readers, pick } = opts;
 const now = new Date();
 const readings = await freshReadings(journal, config, now, readers);
 const selectable = readings.filter((r) => !excluded.has(r.substrate));
 return {
  substrate: pick({ readings: selectable, now, config }),
  chosenOn: describeReadings(readings, now),
 };
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

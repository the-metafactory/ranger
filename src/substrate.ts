/**
 * Substrate selection (node #45): route implement sessions, fix passes and
 * sage reviews across Claude, Codex and Pi by remaining 5h/7d quota.
 *
 * Strong substrates (Claude, Codex) are eligible while every reported window
 * is under its reserve; once both are capped, Pi is the fallback. Review
 * selection cross-matches: the reviewer runs on a substrate other than the
 * one that wrote the PR head.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { RangerConfig } from "./config.ts";
import { runCmd } from "./exec.ts";
import type { Journal, SubstrateReading } from "./journal.ts";

// ---- types ----

export type SubstrateName = "claude" | "codex" | "pi";
export const STRONG_SUBSTRATES: SubstrateName[] = ["claude", "codex"];

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

export function parseClaudeRateLimitEvent(event: ClaudeRateLimitEvent, now = new Date()): QuotaReading {
 const info = event.rate_limit_info;
 const windows: QuotaWindow[] = [];
 for (const kind of ["five_hour", "seven_day"] as const) {
  const w = info.unifiedWindows?.[kind];
  if (w !== undefined) {
   windows.push({ kind, usedPct: Math.round(w.utilization * 100), resetsAt: w.resetsAt });
  }
 }
 // The node #45 brief: any status other than "allowed" counts as capped.
 const capped = info.status !== "allowed";
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
 * Probe Claude's quota with a one-turn haiku call in a scratch cwd. A capped
 * probe may exit non-zero, so the stream is read before the exit code.
 */
export async function probeClaudeQuota(opts: { timeoutMs?: number } = {}): Promise<QuotaReading> {
 const result = await runCmd(
  "claude",
  ["-p", "ok", "--model", "haiku", "--output-format", "stream-json", "--verbose"],
  { cwd: tmpdir(), timeoutMs: opts.timeoutMs ?? 60_000 },
 );
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

/** One line per reading for journal events: what a selection was made on. */
export function describeReadings(readings: SubstrateReading[], now: Date): string {
 const parts = STRONG_SUBSTRATES.map((name) => {
  const r = readings.find((x) => x.substrate === name);
  if (r === undefined) return `${name} unread`;
  const age = Math.round((now.getTime() - Date.parse(r.readAt)) / 60_000);
  const windows = [
   r.fiveHourUsedPct === null ? null : `5h ${r.fiveHourUsedPct}%`,
   r.sevenDayUsedPct === null ? null : `7d ${r.sevenDayUsedPct}%`,
  ].filter((w) => w !== null);
  const capped = r.capped || (r.cappedUntil !== null && Date.parse(r.cappedUntil) > now.getTime());
  return `${name} ${windows.join(" ") || "no windows"} read ${age}m ago${capped ? " CAPPED" : ""}`;
 });
 return parts.join("; ");
}

// ---- selection policy (pure functions, unit-tested) ----

export interface SubstrateConfig {
 fiveHourMaxUsedPct: number;
 sevenDayMaxUsedPct: number;
 claudeProbeMaxAgeMin: number;
 codexReadMaxAgeMin: number;
}

export interface SelectionInput {
 readings: SubstrateReading[];
 now: Date;
 config: SubstrateConfig;
}

export interface EligibleSubstrate {
 name: SubstrateName;
 headroom: number;
}

export function maxReadingAgeMs(name: SubstrateName, config: SubstrateConfig): number {
 return (name === "claude" ? config.claudeProbeMaxAgeMin : config.codexReadMaxAgeMin) * 60_000;
}

export function isFresh(reading: SubstrateReading, config: SubstrateConfig, now: Date): boolean {
 const ageMs = now.getTime() - Date.parse(reading.readAt);
 return ageMs <= maxReadingAgeMs(reading.substrate as SubstrateName, config);
}

/**
 * A strong substrate is eligible when its reading is fresh, it is neither
 * capped nor capped-until in the future, and every reported window is under
 * its reserve. Missing or stale readings fail closed.
 */
export function isEligible(
 reading: SubstrateReading | null,
 config: SubstrateConfig,
 now: Date,
): EligibleSubstrate | null {
 if (reading === null) return null;
 const name = reading.substrate as SubstrateName;
 if (name !== "claude" && name !== "codex") return null;
 if (!isFresh(reading, config, now)) return null;
 if (reading.capped) return null;
 if (reading.cappedUntil !== null && Date.parse(reading.cappedUntil) > now.getTime()) return null;

 // Headroom: the smallest (threshold − used%) over the reported windows.
 let headroom = Infinity;
 if (reading.fiveHourUsedPct !== null) {
  headroom = Math.min(headroom, config.fiveHourMaxUsedPct - reading.fiveHourUsedPct);
 }
 if (reading.sevenDayUsedPct !== null) {
  headroom = Math.min(headroom, config.sevenDayMaxUsedPct - reading.sevenDayUsedPct);
 }
 if (headroom <= 0) return null;
 // A fresh reading with no windows: eligible, with the least headroom.
 if (headroom === Infinity) headroom = 1;
 return { name, headroom };
}

/** The eligible strong substrates, most headroom first. */
export function eligibleStrong(input: SelectionInput): EligibleSubstrate[] {
 return STRONG_SUBSTRATES.map((name) =>
  isEligible(input.readings.find((r) => r.substrate === name) ?? null, input.config, input.now),
 )
  .filter((e): e is EligibleSubstrate => e !== null)
  .sort((a, b) => b.headroom - a.headroom);
}

/** Implement session or fix pass: the eligible strong substrate with the most headroom, else Pi. */
export function selectForBuild(input: SelectionInput): SubstrateName {
 return eligibleStrong(input)[0]?.name ?? "pi";
}

/**
 * Sage review: an eligible substrate other than the head's author
 * (Claude-written → Codex and vice versa); a Pi-written head gets the
 * strongest eligible. No other substrate eligible → the author's substrate
 * if eligible, else Pi.
 */
export function selectForReview(input: SelectionInput, authorSubstrate: SubstrateName): SubstrateName {
 const eligible = eligibleStrong(input);
 return (
  eligible.find((e) => e.name !== authorSubstrate)?.name ??
  eligible.find((e) => e.name === authorSubstrate)?.name ??
  "pi"
 );
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
  ? (readers?.codex ?? (() => readCodexQuota({ timeoutMs: 30_000 })))
  : (readers?.claude ?? (() => probeClaudeQuota({ timeoutMs: 60_000 })));
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

/** A Claude stream's own cap signal: a rate_limit_event whose status is not "allowed". */
export function detectClaudeCap(lines: string[]): CapSignal | null {
 for (const event of claudeRateLimitEvents(lines)) {
  if (event.rate_limit_info.status !== "allowed") {
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

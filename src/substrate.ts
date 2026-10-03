/**
 * Substrate selection (node #44): route implement sessions, fix passes and
 * sage reviews across Claude, Codex and Pi by remaining 5h/7d quota.
 *
 * Strong substrates (Claude, Codex) are eligible while every reported window
 * is under its reserve; once both are capped, Pi is the fallback. Review
 * selection cross-matches: the reviewer runs on a substrate other than the
 * one that wrote the PR head.
 */
import type { RangerConfig } from "./config.ts";
import { runCmd, type RunResult } from "./exec.ts";
import type { Journal, SubstrateReading } from "./journal.ts";

// ---- types ----

export type SubstrateName = "claude" | "codex" | "pi";
export const STRONG_SUBSTRATES: SubstrateName[] = ["claude", "codex"];
export const ALL_SUBSTRATES: SubstrateName[] = ["claude", "codex", "pi"];

export interface QuotaWindow {
 /** "five_hour" | "seven_day" */
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
 /** The earliest resetsAt from the reported windows (epoch seconds). */
 cappedUntil: number | null;
}

// ---- Codex quota parser ----

export interface CodexRateLimitEntry {
 usedPercent: number;
 windowDurationMins: number;
 resetsAt: number;
}

export interface CodexRateLimitsResponse {
 rateLimits: {
  primary: CodexRateLimitEntry | null;
  secondary: CodexRateLimitEntry | null;
  rateLimitReachedType: string | null;
 };
}

/** Map codex windowDurationMins to our window kind. */
function codexWindowKind(mins: number): "five_hour" | "seven_day" | null {
 if (mins === 300) return "five_hour";
 if (mins === 10080) return "seven_day";
 return null;
}

export function parseCodexQuota(resp: CodexRateLimitsResponse): QuotaReading {
 const windows: QuotaWindow[] = [];
 for (const slot of [resp.rateLimits.primary, resp.rateLimits.secondary]) {
  if (slot === null) continue;
  const kind = codexWindowKind(slot.windowDurationMins);
  if (kind === null) continue;
  windows.push({ kind, usedPct: slot.usedPercent, resetsAt: slot.resetsAt });
 }
 const capped = resp.rateLimits.rateLimitReachedType !== null;
 const resets = windows.map((w) => w.resetsAt);
 return {
  substrate: "codex",
  readAt: new Date(),
  windows,
  capped,
  cappedUntil: capped && resets.length > 0 ? Math.min(...resets) : null,
 };
}

// ---- Claude quota parser ----

export interface ClaudeRateLimitEvent {
 type: "rate_limit_event";
 rate_limit_info: {
  status: string;
  resetsAt: number;
  rateLimitType: string;
  unifiedWindows?: {
   five_hour?: { utilization: number; resetsAt: number };
   seven_day?: { utilization: number; resetsAt: number };
  };
 };
}

export function parseClaudeRateLimitEvent(event: ClaudeRateLimitEvent): QuotaReading {
 const info = event.rate_limit_info;
 const windows: QuotaWindow[] = [];
 const uw = info.unifiedWindows;
 if (uw?.five_hour !== undefined) {
  windows.push({
   kind: "five_hour",
   usedPct: Math.round(uw.five_hour.utilization * 100),
   resetsAt: uw.five_hour.resetsAt,
  });
 }
 if (uw?.seven_day !== undefined) {
  windows.push({
   kind: "seven_day",
   usedPct: Math.round(uw.seven_day.utilization * 100),
   resetsAt: uw.seven_day.resetsAt,
  });
 }
 const capped = info.status !== "allowed";
 const resets = windows.map((w) => w.resetsAt);
 return {
  substrate: "claude",
  readAt: new Date(),
  windows,
  capped,
  cappedUntil: capped && resets.length > 0 ? Math.min(...resets) : null,
 };
}

/**
 * Extract the final result text from a Claude stream-json stdout. Each line is
 * a JSON object; the `result` event carries the summary text that the old
 * plain-text stdout contained.
 */
export function extractClaudeResultText(stdout: string): string {
 const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
 for (let i = lines.length - 1; i >= 0; i--) {
  try {
   const obj = JSON.parse(lines[i]) as { type?: string; result?: string; subtype?: string };
   if (obj.type === "result" && typeof obj.result === "string") {
    return obj.result;
   }
  } catch {
   continue;
  }
 }
 // No result event found — return raw stdout as fallback.
 return stdout;
}

/**
 * Cache every rate_limit_event seen in a Claude stream-json run. Called by
 * the supervisor after a worker or review completes on Claude.
 */
export function cacheClaudeRateLimitEvents(
 stdout: string,
 journal: Journal,
): void {
 const lines = stdout.split("\n");
 let latest: QuotaReading | null = null;
 for (const line of lines) {
  if (!line.includes("rate_limit_event")) continue;
  try {
   const obj = JSON.parse(line) as { type?: string };
   if (obj.type === "rate_limit_event") {
    latest = parseClaudeRateLimitEvent(obj as ClaudeRateLimitEvent);
   }
  } catch {
   continue;
  }
 }
 if (latest !== null) {
  persistReading(journal, latest);
 }
}

// ---- reading persistence ----

export function persistReading(journal: Journal, reading: QuotaReading): void {
 const fiveHour = reading.windows.find((w) => w.kind === "five_hour");
 const sevenDay = reading.windows.find((w) => w.kind === "seven_day");
 journal.upsertSubstrateReading({
  substrate: reading.substrate,
  readAt: reading.readAt.toISOString(),
  fiveHourUsedPct: fiveHour?.usedPct ?? null,
  sevenDayUsedPct: sevenDay?.usedPct ?? null,
  resetsAt:
   reading.cappedUntil !== null
    ? new Date(reading.cappedUntil * 1000).toISOString()
    : (fiveHour !== undefined || sevenDay !== undefined
       ? new Date(Math.min(...reading.windows.map((w) => w.resetsAt)) * 1000).toISOString()
       : null),
  capped: reading.capped,
  cappedUntil:
   reading.cappedUntil !== null
    ? new Date(reading.cappedUntil * 1000).toISOString()
    : null,
 });
}

// ---- quota readers (spawn the substrates) ----

/**
 * Read Codex quota via the app-server JSON-RPC protocol (LSP-style stdio).
 * Spawns `codex app-server`, sends initialize + initialized + account/rateLimits/read,
 * and parses the response.
 */
export async function readCodexQuota(opts: {
 timeoutMs?: number;
}): Promise<QuotaReading> {
 const timeout = opts.timeoutMs ?? 30_000;
 return new Promise((resolve, reject) => {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const child = spawn("codex", ["app-server"], {
   stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let done = false;

  const timer = setTimeout(() => {
   if (!done) {
    done = true;
    child.kill("SIGKILL");
    reject(new Error("codex app-server timed out"));
   }
  }, timeout);

  child.stdout.on("data", (chunk: Buffer) => {
   stdout += chunk.toString();
   // Look for the rateLimits response.
   const match = stdout.match(/Content-Length: (\d+)\r\n\r\n/g);
   if (match === null) return;
   // Parse all complete messages, keep the last one with a result.
   let offset = 0;
   while (offset < stdout.length) {
    const headerEnd = stdout.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) break;
    const clMatch = stdout.slice(offset, headerEnd).match(/Content-Length: (\d+)/);
    if (clMatch === null) break;
    const bodyStart = headerEnd + 4;
    const bodyLen = Number(clMatch[1]);
    if (stdout.length < bodyStart + bodyLen) break; // incomplete
    const body = stdout.slice(bodyStart, bodyStart + bodyLen);
    offset = bodyStart + bodyLen;
    try {
     const msg = JSON.parse(body) as { id?: number; result?: unknown };
     if (msg.id === 3 && msg.result !== undefined) {
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      try {
       resolve(parseCodexQuota(msg.result as CodexRateLimitsResponse));
      } catch (e) {
       reject(e);
      }
      return;
     }
    } catch {
     // not JSON — skip
    }
   }
  });

  child.on("error", (err) => {
   if (!done) {
    done = true;
    clearTimeout(timer);
    reject(new Error(`codex app-server failed to spawn: ${err.message}`));
   }
  });

  child.on("close", () => {
   if (!done) {
    done = true;
    clearTimeout(timer);
    reject(new Error("codex app-server exited before responding"));
   }
  });

  // Send the three JSON-RPC messages.
  const send = (msg: object) => {
   const json = JSON.stringify(msg);
   const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
   child.stdin.write(header + json);
  };

  send({
   jsonrpc: "2.0",
   id: 1,
   method: "initialize",
   params: { clientInfo: { name: "ranger", version: "1.0.0" } },
  });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  send({
   jsonrpc: "2.0",
   id: 3,
   method: "account/rateLimits/read",
   params: {},
  });
 });
}

/**
 * Probe Claude's quota with a cheap one-turn haiku call. The stream-json
 * output carries rate_limit_event lines with the current quota.
 */
export async function probeClaudeQuota(opts: {
 timeoutMs?: number;
}): Promise<QuotaReading> {
 const timeout = opts.timeoutMs ?? 60_000;
 const tmpDir = require("node:os").tmpdir();
 const result = await runCmd(
  "claude",
  ["-p", "ok", "--model", "haiku", "--output-format", "stream-json", "--verbose"],
  { cwd: tmpDir, timeoutMs: timeout },
 );
 if (result.code !== 0) {
  throw new Error(`claude haiku probe exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-300)}`);
 }
 // Parse rate_limit_event from stdout.
 const lines = result.stdout.split("\n");
 for (const line of lines) {
  if (!line.includes("rate_limit_event")) continue;
  try {
   const obj = JSON.parse(line) as { type?: string };
   if (obj.type === "rate_limit_event") {
    return parseClaudeRateLimitEvent(obj as ClaudeRateLimitEvent);
   }
  } catch {
   continue;
  }
 }
 throw new Error("claude haiku probe emitted no rate_limit_event");
}

// ---- selection policy (pure function, unit-tested) ----

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

/**
 * Determine if a strong substrate is eligible: it has a fresh reading, every
 * reported window is under the reserve, and it is not marked capped in the
 * future.
 */
export function isEligible(
 reading: SubstrateReading | null,
 config: SubstrateConfig,
 now: Date,
): EligibleSubstrate | null {
 if (reading === null) return null;

 const name = reading.substrate as SubstrateName;
 if (name !== "claude" && name !== "codex") return null;

 // Max age check: a stale reading counts as capped (fail closed).
 const ageMs = now.getTime() - new Date(reading.readAt).getTime();
 const maxAgeMs =
  name === "claude"
   ? config.claudeProbeMaxAgeMin * 60_000
   : config.codexReadMaxAgeMin * 60_000;
 if (ageMs > maxAgeMs) return null;

 // Capped: the substrate itself reported a cap that extends into the future.
 if (reading.capped) {
  if (reading.cappedUntil !== null && new Date(reading.cappedUntil).getTime() > now.getTime()) {
   return null;
  }
  // capped flag but cappedUntil in the past — treat as stale-capped, ineligible.
  return null;
 }

 // Window checks: every reported window must be under its reserve.
 const thresholds: Record<string, number> = {
  five_hour: config.fiveHourMaxUsedPct,
  seven_day: config.sevenDayMaxUsedPct,
 };
 // Compute headroom: the smallest of (threshold - used%) across reported windows.
 let headroom = Infinity;
 if (reading.fiveHourUsedPct !== null) {
  const margin = thresholds.five_hour - reading.fiveHourUsedPct;
  if (margin <= 0) return null;
  headroom = Math.min(headroom, margin);
 }
 if (reading.sevenDayUsedPct !== null) {
  const margin = thresholds.seven_day - reading.sevenDayUsedPct;
  if (margin <= 0) return null;
  headroom = Math.min(headroom, margin);
 }
 // No windows reported at all — treat as fresh but unknown: eligible with minimum headroom.
 if (headroom === Infinity) headroom = 1;

 return { name, headroom };
}

/**
 * Select the substrate for an implement session or fix pass: the eligible
 * strong substrate with the most headroom, else Pi.
 */
export function selectForBuild(input: SelectionInput): SubstrateName {
 const eligible: EligibleSubstrate[] = [];
 for (const name of STRONG_SUBSTRATES) {
  const reading = input.readings.find((r) => r.substrate === name) ?? null;
  const e = isEligible(reading, input.config, input.now);
  if (e !== null) eligible.push(e);
 }
 if (eligible.length === 0) return "pi";
 eligible.sort((a, b) => b.headroom - a.headroom);
 return eligible[0].name;
}

/**
 * Select the substrate for a sage review: prefers a substrate OTHER than the
 * one that wrote the PR head (cross-model review).
 *
 * - Claude-written → Codex if eligible, else Pi
 * - Codex-written → Claude if eligible, else Pi
 * - Pi-written → the eligible strong substrate with most headroom, else Pi
 * - No other substrate eligible → the author's substrate if eligible, else Pi
 */
export function selectForReview(
 input: SelectionInput,
 authorSubstrate: SubstrateName,
): SubstrateName {
 const eligible: EligibleSubstrate[] = [];
 for (const name of STRONG_SUBSTRATES) {
  const reading = input.readings.find((r) => r.substrate === name) ?? null;
  const e = isEligible(reading, input.config, input.now);
  if (e !== null) eligible.push(e);
 }

 if (authorSubstrate === "pi") {
  // Pi-written: pick the strongest eligible.
  if (eligible.length === 0) return "pi";
  eligible.sort((a, b) => b.headroom - a.headroom);
  return eligible[0].name;
 }

 // Cross-model: prefer a strong substrate other than the author.
 const others = eligible.filter((e) => e.name !== authorSubstrate);
 if (others.length > 0) {
  others.sort((a, b) => b.headroom - a.headroom);
  return others[0].name;
 }

 // No other strong substrate eligible — fall back to the author if eligible, else Pi.
 const author = eligible.find((e) => e.name === authorSubstrate);
 return author !== undefined ? author.name : "pi";
}

// ---- per-substrate command builders ----

/**
 * Build the worker command + args for a given substrate. The prompt is
 * appended as the final arg by the caller.
 *
 * - Claude: `claude -p --output-format stream-json --verbose`
 * - Codex: `codex exec`
 * - Pi: `pi -p --provider <provider> --model <model>`
 */
export function workerCommandFor(
 substrate: SubstrateName,
 config: RangerConfig,
): string[] {
 switch (substrate) {
  case "claude":
   return ["claude", "-p", "--output-format", "stream-json", "--verbose"];
  case "codex":
   return ["codex", "exec"];
  case "pi":
   return [
    "pi",
    "-p",
    "--provider",
    config.substrates.pi.provider,
    "--model",
    config.substrates.pi.model,
   ];
 }
}

// ---- refresh logic ----

/**
 * Refresh a substrate reading if stale. Returns the reading (fresh or cached).
 * Only refreshes strong substrates; Pi has no quota.
 */
export async function ensureFreshReading(
 substrate: SubstrateName,
 journal: Journal,
 config: SubstrateConfig,
 now: Date,
 /** Injectable readers for tests. */
 readers?: {
  codex?: () => Promise<QuotaReading>;
  claude?: () => Promise<QuotaReading>;
 },
): Promise<SubstrateReading | null> {
 if (substrate === "pi") return null;

 const existing = journal.getSubstrateReading(substrate);
 if (existing !== null) {
  const ageMs = now.getTime() - new Date(existing.readAt).getTime();
  const maxAgeMs =
   substrate === "claude"
    ? config.claudeProbeMaxAgeMin * 60_000
    : config.codexReadMaxAgeMin * 60_000;
  if (ageMs <= maxAgeMs) return existing;
 }

 // Stale or missing: refresh.
 try {
  const reader = substrate === "codex"
   ? (readers?.codex ?? (() => readCodexQuota({ timeoutMs: 30_000 })))
   : (readers?.claude ?? (() => probeClaudeQuota({ timeoutMs: 60_000 })));
  const reading = await reader();
  persistReading(journal, reading);
  return journal.getSubstrateReading(substrate);
 } catch {
  // Failed to read — mark as capped (fail closed).
  return existing;
 }
}

// ---- mid-session cap detection ----

export interface CapSignal {
 substrate: SubstrateName;
 resetsAt: number | null;
}

/**
 * Detect a mid-session rate limit from a Claude stream-json run. Returns a
 * CapSignal if the run hit a limit, null otherwise.
 */
export function detectClaudeCap(result: RunResult): CapSignal | null {
 const lines = result.stdout.split("\n");
 for (const line of lines) {
  if (!line.includes("rate_limit_event")) continue;
  try {
   const obj = JSON.parse(line) as { type?: string; rate_limit_info?: { status?: string; resetsAt?: number } };
   if (obj.type === "rate_limit_event" && obj.rate_limit_info?.status !== "allowed") {
    return {
     substrate: "claude",
     resetsAt: obj.rate_limit_info?.resetsAt ?? null,
    };
   }
  } catch {
   continue;
  }
 }
 return null;
}

/**
 * Detect a mid-session rate limit from a Codex run. Returns a CapSignal if
 * the run's stderr/stdout contains a rate limit indicator.
 */
export function detectCodexCap(result: RunResult): CapSignal | null {
 const combined = result.stdout + result.stderr;
 if (
  combined.includes("rateLimitReachedType") ||
  combined.includes("rate limit") ||
  combined.includes("Rate limit")
 ) {
  return { substrate: "codex", resetsAt: null };
 }
 return null;
}

/**
 * Mark a substrate as capped in the journal until a given epoch.
 */
export function markSubstrateCapped(
 journal: Journal,
 substrate: SubstrateName,
 resetsAt: number | null,
 now: Date,
): void {
 const reading = journal.getSubstrateReading(substrate);
 const cappedUntilIso = resetsAt !== null
  ? new Date(resetsAt * 1000).toISOString()
  : new Date(now.getTime() + 30 * 60_000).toISOString(); // 30 min default
 journal.upsertSubstrateReading({
  substrate,
  readAt: (reading?.readAt ?? now.toISOString()),
  fiveHourUsedPct: reading?.fiveHourUsedPct ?? null,
  sevenDayUsedPct: reading?.sevenDayUsedPct ?? null,
  resetsAt: cappedUntilIso,
  capped: true,
  cappedUntil: cappedUntilIso,
 });
}

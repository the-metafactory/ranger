import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DAY_FILE, DAY_MS, MAX_DAY_BYTES, type CallRecord, type GaugeRecord, type OpaqueRecord, type RefusalKind, type UsageRecord } from "./github-usage.ts";

const WINDOW_MS = 3_600_000;
const TOP_SPENDERS = 5;

export interface Spender {
 component: string;
 source: string;
 calls: number;
 endpoints: { endpoint: string; calls: number }[];
}

export interface OpaqueSummary {
 component: string;
 source: string;
 runs: number;
 refused: number;
 seconds: number;
}

export interface RefusalEntry {
 at: string;
 component: string;
 source: string;
 refusal: RefusalKind;
 endpoint?: string;
 status?: number;
 resource?: string;
 remaining?: number;
 retryAfter?: number;
}

/**
 * One budget window: a resource and its reset time. Tokens on one account share
 * a window, so it is reported whole, even past the chosen period. `used` splits
 * into `recordedCalls` and three kinds of spend ranger did not count:
 * `duringOpaque` is an upper bound for each run, and `outsideRanger` is spend
 * with no recorded soma or sage run going, which a worker's own `gh` can be.
 */
export interface WindowReport {
 resource: string;
 reset: number;
 resetAt: string;
 limit: number;
 sources: string[];
 used: number;
 lowestRemaining: number;
 exhausted: boolean;
 recordedCalls: number;
 topSpenders: { component: string; calls: number }[];
 duringOpaque: Record<string, number>;
 outsideRanger: number;
 beforeRecordBegan: number;
}

export interface UsageReport {
 since: string;
 until: string;
 spenders: Spender[];
 opaque: OpaqueSummary[];
 refusals: RefusalEntry[];
 windows: WindowReport[];
 cappedDays: string[];
 malformedLines: number;
 caveats: string[];
}

function isUsageRecord(value: unknown): value is UsageRecord {
 if (value === null || typeof value !== "object") return false;
 const { kind, at, component } = value as Record<string, unknown>;
 return (kind === "call" || kind === "gauge" || kind === "opaque") && typeof component === "string" && typeof at === "string" && !Number.isNaN(Date.parse(at));
}

function parseUsageLine(line: string): UsageRecord | null {
 try {
  const parsed: unknown = JSON.parse(line);
  return isUsageRecord(parsed) ? parsed : null;
 } catch {
  return null;
 }
}

function readDay(file: string): { records: UsageRecord[]; malformed: number } {
 const records: UsageRecord[] = [];
 let malformed = 0;
 for (const line of readFileSync(file, "utf8").split("\n")) {
  if (line.length === 0) continue;
  const record = parseUsageLine(line);
  if (record === null) malformed++;
  else records.push(record);
 }
 return { records, malformed };
}

const ms = (iso: string): number => Date.parse(iso);

type Observation = CallRecord | GaugeRecord;

function bump<K>(counts: Map<K, number>, key: K, by = 1): void {
 counts.set(key, (counts.get(key) ?? 0) + by);
}

const byCount = <T extends { calls: number }>(rank: (item: T) => string) => (a: T, b: T): number =>
 b.calls - a.calls || rank(a).localeCompare(rank(b));

function rankSpenders(calls: CallRecord[]): Spender[] {
 const groups = new Map<string, { component: string; source: string; calls: number; endpoints: Map<string, number> }>();
 for (const call of calls) {
  const key = `${call.component}\0${call.source}`;
  const group = groups.get(key) ?? { component: call.component, source: call.source, calls: 0, endpoints: new Map<string, number>() };
  group.calls++;
  bump(group.endpoints, call.endpoint);
  groups.set(key, group);
 }
 return [...groups.values()]
  .map((group) => ({
   component: group.component, source: group.source, calls: group.calls,
   endpoints: [...group.endpoints].map(([endpoint, calls]) => ({ endpoint, calls })).sort(byCount((e) => e.endpoint)),
  }))
  .sort(byCount((s) => s.component));
}

function summariseOpaque(runs: OpaqueRecord[]): OpaqueSummary[] {
 const groups = new Map<string, OpaqueSummary>();
 for (const run of runs) {
  const key = `${run.component}\0${run.source}`;
  const group = groups.get(key) ?? { component: run.component, source: run.source, runs: 0, refused: 0, seconds: 0 };
  group.runs++;
  if (run.refusal !== undefined) group.refused++;
  group.seconds += Math.round((ms(run.endedAt) - ms(run.at)) / 1000);
  groups.set(key, group);
 }
 return [...groups.values()].sort((a, b) => b.runs - a.runs || a.component.localeCompare(b.component));
}

function longestOverlappingRun(runs: OpaqueRecord[], from: number, to: number): OpaqueRecord | undefined {
 let best: OpaqueRecord | undefined;
 let bestOverlap = -1;
 for (const run of runs) {
  const overlap = Math.min(to, ms(run.endedAt)) - Math.max(from, ms(run.at));
  if (overlap >= 0 && overlap > bestOverlap) {
   best = run;
   bestOverlap = overlap;
  }
 }
 return best;
}

function reportWindow(observations: Observation[], opaque: OpaqueRecord[], recordBegan: number): WindowReport {
 const sorted = [...observations].sort((a, b) => ms(a.at) - ms(b.at));
 const { resource = "unknown", reset = 0 } = sorted[0];
 const limit = sorted.find((o) => o.limit !== undefined)?.limit ?? sorted[0].remaining ?? 0;
 const sources = [...new Set(sorted.map((o) => o.source))].sort();
 const windowRuns = opaque.filter((run) => sources.includes(run.source));
 const spend = attributeSpend(sorted, windowRuns, { limit, windowStart: reset * 1000 - WINDOW_MS, recordBegan });
 const spenders = new Map<string, number>();
 for (const observation of sorted) if (observation.kind === "call") bump(spenders, observation.component);
 return {
  resource, reset, resetAt: new Date(reset * 1000).toISOString(), limit, sources, used: limit - spend.lowest, lowestRemaining: spend.lowest,
  exhausted: spend.lowest === 0 || sorted.some((o) => o.kind === "call" && o.refusal === "primary"),
  recordedCalls: sorted.filter((o) => o.kind === "call").length,
  topSpenders: [...spenders].map(([component, calls]) => ({ component, calls })).sort(byCount((s) => s.component)).slice(0, TOP_SPENDERS),
  duringOpaque: spend.duringOpaque, outsideRanger: spend.outsideRanger, beforeRecordBegan: spend.beforeRecordBegan,
 };
}

function attributeSpend(sorted: Observation[], runs: OpaqueRecord[], window: { limit: number; windowStart: number; recordBegan: number }) {
 const duringOpaque: Record<string, number> = {};
 let outsideRanger = 0;
 let beforeRecordBegan = 0;
 let lowest = window.limit;
 let uncounted = 0;
 let previous = window.windowStart;
 let first = true;
 for (const observation of sorted) {
  if (observation.kind === "call") uncounted++;
  const { remaining } = observation;
  if (remaining === undefined) continue;
  const now = ms(observation.at);
  const unexplained = Math.max(0, lowest - remaining - uncounted);
  if (unexplained > 0) {
   const run = longestOverlappingRun(runs, previous, now);
   if (first && window.recordBegan > previous) beforeRecordBegan += unexplained;
   else if (run !== undefined) duringOpaque[run.component] = (duringOpaque[run.component] ?? 0) + unexplained;
   else outsideRanger += unexplained;
  }
  lowest = Math.min(lowest, remaining);
  uncounted = 0;
  previous = now;
  first = false;
 }
 return { duringOpaque, outsideRanger, beforeRecordBegan, lowest };
}

function refusalEntry(record: CallRecord | OpaqueRecord): RefusalEntry | null {
 if (record.refusal === undefined) return null;
 const common = { at: record.at, component: record.component, source: record.source, refusal: record.refusal };
 if (record.kind === "opaque") return common;
 return {
  ...common, endpoint: record.endpoint,
  ...(record.status === undefined ? {} : { status: record.status }),
  ...(record.resource === undefined ? {} : { resource: record.resource }),
  ...(record.remaining === undefined ? {} : { remaining: record.remaining }),
  ...(record.retryAfter === undefined ? {} : { retryAfter: record.retryAfter }),
 };
}

function dayFiles(directory: string): string[] {
 if (!existsSync(directory)) return [];
 return readdirSync(directory).filter((name) => DAY_FILE.test(name)).sort();
}

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

function loadRecords(directory: string, since: Date, until: Date) {
 const firstDay = dayOf(new Date(Math.max(0, since.getTime() - DAY_MS)));
 const lastDay = dayOf(new Date(until.getTime() + DAY_MS));
 const records: UsageRecord[] = [];
 const cappedDays: string[] = [];
 let malformedLines = 0;
 let recordBegan: number | null = null;
 for (const name of dayFiles(directory)) {
  const day = name.slice(0, 10);
  const wanted = day >= firstDay && day <= lastDay;
  if (!wanted && recordBegan !== null) continue;
  const read = readDay(join(directory, name));
  if (recordBegan === null && read.records.length > 0) recordBegan = ms(read.records[0].at);
  if (!wanted) continue;
  for (const record of read.records) records.push(record);
  malformedLines += read.malformed;
  if (day >= dayOf(since) && day <= dayOf(until) && statSync(join(directory, name)).size >= MAX_DAY_BYTES) cappedDays.push(day);
 }
 return { records, cappedDays, malformedLines, recordBegan: recordBegan ?? Number.POSITIVE_INFINITY };
}

const CAVEATS = [
 "A soma or sage run gets all the spend between the two budget readings around it, so a during figure is an upper bound.",
 "Spend with no soma or sage run going can be a worker's own gh, your own gh, gh pr merge from the dashboard, or a run that was killed or has not finished.",
 "The calls inside soma and sage are not counted.",
];

/**
 * Rank what spent GitHub budget in a period, from the record alone. Calls, runs
 * and refusals are those in the period. A window any of them touches is shown
 * whole, and so the days around the period are read as well.
 */
export function buildUsageReport(directory: string, since: Date, until: Date): UsageReport {
 const { records, cappedDays, malformedLines, recordBegan } = loadRecords(directory, since, until);
 const inPeriod = (at: string): boolean => ms(at) >= since.getTime() && ms(at) <= until.getTime();
 const calls =records.filter((r): r is CallRecord => r.kind === "call");
 const opaqueRuns = records.filter((r): r is OpaqueRecord => r.kind === "opaque");
 const observations = records.filter((r): r is Observation => r.kind !== "opaque" && r.reset !== undefined && r.resource !== undefined);
 const windowKey = (o: Observation): string => `${o.resource}:${o.reset}`;
 const touched = new Set(observations.filter((o) => inPeriod(o.at)).map(windowKey));
 const groups = new Map<string, Observation[]>();
 for (const observation of observations) {
  const key = windowKey(observation);
  if (!touched.has(key)) continue;
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [observation]);
  else group.push(observation);
 }
 const inPeriodCalls = calls.filter((c) => inPeriod(c.at));
 const inPeriodRuns = opaqueRuns.filter((r) => ms(r.at) <= until.getTime() && ms(r.endedAt) >= since.getTime());
 return {
  since: since.toISOString(),
  until: until.toISOString(),
  spenders: rankSpenders(inPeriodCalls),
  opaque: summariseOpaque(inPeriodRuns),
  refusals: [...inPeriodCalls, ...inPeriodRuns]
   .map(refusalEntry)
   .filter((entry): entry is RefusalEntry => entry !== null)
   .sort((a, b) => ms(a.at) - ms(b.at)),
  windows: [...groups.values()].map((group) => reportWindow(group, opaqueRuns, recordBegan)).sort((a, b) => a.reset - b.reset || a.resource.localeCompare(b.resource)),
  cappedDays,
  malformedLines,
  caveats: CAVEATS,
 };
}

function renderWindow(window: WindowReport): string {
 const during = Object.entries(window.duringOpaque).map(([component, calls]) => `at most ${calls} during ${component}`);
 const parts = [
  `used ${window.used}/${window.limit}`,
  `ranger's calls ${window.recordedCalls}`,
  ...during,
  `with no soma or sage run going ${window.outsideRanger}`,
  ...(window.beforeRecordBegan > 0 ? [`before the record began ${window.beforeRecordBegan}`] : []),
 ];
 const top = window.topSpenders.map((s) => `${s.component} ${s.calls}`).join(", ");
 return [
  ` ${window.resource} until ${window.resetAt}${window.exhausted ? " EXHAUSTED" : ""} (${window.sources.join(", ")}): ${parts.join(", ")}`,
  ...(top.length > 0 ? [`   top spenders: ${top}`] : []),
 ].join("\n");
}

function renderRefusal(refusal: RefusalEntry): string {
 const left = refusal.remaining === undefined ? "" : `, ${refusal.remaining} left`;
 const retry = refusal.retryAfter === undefined ? "" : `, retry after ${refusal.retryAfter} s`;
 const what = [refusal.resource, refusal.endpoint].filter((part) => part !== undefined).join(" ");
 return ` ${refusal.at} ${refusal.refusal} ${refusal.component} [${refusal.source}]${what.length > 0 ? ` ${what}` : ""}${left}${retry}`;
}

/** The report as text for the operator. */
export function renderUsageReport(report: UsageReport): string {
 const empty = report.spenders.length === 0 && report.opaque.length === 0 && report.refusals.length === 0 && report.windows.length === 0;
 const lines = [`GitHub use from ${report.since} to ${report.until}`];
 if (empty) lines.push("no GitHub use recorded in this period");
 if (report.spenders.length > 0) {
  lines.push("", "Calls by component:");
  for (const spender of report.spenders) {
   const endpoints = spender.endpoints.slice(0, 3).map((e) => `${e.endpoint} ${e.calls}`).join(", ");
   lines.push(` ${spender.calls} ${spender.component} [${spender.source}]: ${endpoints}`);
  }
 }
 if (report.opaque.length > 0) {
  lines.push("", "Runs whose calls cannot be counted:");
  for (const run of report.opaque) lines.push(` ${run.runs} ${run.component} [${run.source}]: ${run.seconds} s${run.refused > 0 ? `, ${run.refused} refused` : ""}`);
 }
 if (report.refusals.length > 0) {
  lines.push("", "Refusals:");
  for (const refusal of report.refusals) lines.push(renderRefusal(refusal));
 }
 if (report.windows.length > 0) {
  lines.push("", "Budget windows:");
  for (const window of report.windows) lines.push(renderWindow(window));
 }
 if (report.cappedDays.length > 0) lines.push("", `Incomplete: the record reached its daily cap on ${report.cappedDays.join(", ")}.`);
 if (report.malformedLines > 0) lines.push("", `${report.malformedLines} unreadable line(s) in the record were skipped.`);
 if (!empty) lines.push("", ...report.caveats);
 return lines.join("\n");
}

const DURATION = /^(\d+)([smhd])$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS };

/** A period boundary: a duration back from now (`90m`, `2d`), or a timestamp. */
export function parsePeriodStart(text: string, now: Date, flag = "--since"): Date {
 const duration = DURATION.exec(text);
 if (duration !== null) return new Date(now.getTime() - Number(duration[1]) * UNIT_MS[duration[2]]);
 const parsed = /^\d{4}-\d{2}-\d{2}/.test(text) ? Date.parse(text) : Number.NaN;
 if (Number.isNaN(parsed)) throw new Error(`${flag} must be a duration such as 90m or 2d, or a timestamp, not ${JSON.stringify(text)}`);
 return new Date(parsed);
}

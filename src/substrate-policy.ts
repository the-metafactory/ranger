/**
 * Substrate selection policy (node #45): pure functions over the persisted
 * quota readings, unit-tested and shared by the selector and `ranger serve`.
 * Kept apart from the quota readers so a read-only consumer imports no
 * spawning code.
 */
import type { RangerConfig } from "./config.ts";
import type { SubstrateReading } from "./journal.ts";
import type { SubstrateName } from "./store/schema.ts";

export const STRONG_SUBSTRATES: SubstrateName[] = ["claude", "codex"];

export type SubstrateConfig = Omit<RangerConfig["substrates"], "pi" | "codex">;

export interface SelectionInput {
 readings: SubstrateReading[];
 now: Date;
 config: SubstrateConfig;
}

export interface EligibleSubstrate {
 name: SubstrateName;
 headroom: number;
}

export type QuotaWindowKind = "five_hour" | "seven_day";

/** The configured reserve decays linearly over its own quota window. */
export function effectiveThreshold(
 window: QuotaWindowKind,
 reading: SubstrateReading,
 now: Date,
 config: SubstrateConfig,
): number {
 const fiveHour = window === "five_hour";
 const fixed = fiveHour ? config.fiveHourMaxUsedPct : config.sevenDayMaxUsedPct;
 const reset = fiveHour ? reading.fiveHourResetsAt : reading.sevenDayResetsAt;
 if (reset === null) return fixed;
 const resetMs = Date.parse(reset);
 if (!Number.isFinite(resetMs)) return fixed;
 const lengthMs = (fiveHour ? 5 * 60 : 7 * 24 * 60) * 60_000;
 const remaining = Math.min(1, Math.max(0, (resetMs - now.getTime()) / lengthMs));
 return 100 - (100 - fixed) * remaining;
}

export function maxReadingAgeMs(name: SubstrateName, config: SubstrateConfig): number {
 return (name === "claude" ? config.claudeProbeMaxAgeMin : config.codexReadMaxAgeMin) * 60_000;
}

export function isFresh(reading: SubstrateReading, config: SubstrateConfig, now: Date): boolean {
 const ageMs = now.getTime() - Date.parse(reading.readAt);
 return ageMs <= maxReadingAgeMs(reading.substrate, config);
}

/** Minutes since the reading was taken (never negative). */
export function readingAgeMin(reading: SubstrateReading, now: Date): number {
 return Math.max(0, Math.round((now.getTime() - Date.parse(reading.readAt)) / 60_000));
}

/** The reading's capped-until while it is still in the future, else null. */
export function activeCappedUntil(reading: SubstrateReading, now: Date): string | null {
 return reading.cappedUntil !== null && Date.parse(reading.cappedUntil) > now.getTime()
  ? reading.cappedUntil
  : null;
}

/** Capped now: the reading says so, or a capped-until is still in the future. */
export function isCappedAt(reading: SubstrateReading, now: Date): boolean {
 return reading.capped || activeCappedUntil(reading, now) !== null;
}

/**
 * A strong substrate is eligible when its reading is fresh, it is neither
 * capped nor capped-until in the future, it reports at least one window, and
 * every reported window's used% is under its effective threshold. Missing,
 * stale or window-less readings fail closed: a reading with no windows says
 * nothing about the reserve, so it must not look unlimited.
 */
export function isEligible(
 reading: SubstrateReading | null,
 config: SubstrateConfig,
 now: Date,
): EligibleSubstrate | null {
 if (reading === null) return null;
 const name = reading.substrate;
 if (!STRONG_SUBSTRATES.includes(name)) return null;
 if (!isFresh(reading, config, now)) return null;
 if (isCappedAt(reading, now)) return null;

 // Headroom: the smallest (threshold − used%) over the reported windows.
 let headroom = Infinity;
 if (reading.fiveHourUsedPct !== null) {
  headroom = Math.min(headroom, effectiveThreshold("five_hour", reading, now, config) - reading.fiveHourUsedPct);
 }
 if (reading.sevenDayUsedPct !== null) {
  headroom = Math.min(headroom, effectiveThreshold("seven_day", reading, now, config) - reading.sevenDayUsedPct);
 }
 // No window reported (Infinity) or one at/over its threshold: ineligible.
 if (headroom === Infinity || headroom <= 0) return null;
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
 * if eligible, else Pi. Cross-model is preferred, not guaranteed: a Pi-written
 * head reviewed when both strong substrates are out runs on Pi too.
 */
export function selectForReview(input: SelectionInput, authorSubstrate: SubstrateName): SubstrateName {
 const eligible = eligibleStrong(input);
 return (
  eligible.find((e) => e.name !== authorSubstrate)?.name ??
  eligible.find((e) => e.name === authorSubstrate)?.name ??
  "pi"
 );
}

/** A review round that runs on Pi by rotation (substrates.pi.reviewEvery), not by quota. */
export function isPiReviewTurn(round: number, every: number): boolean {
 return every > 0 && round % every === 0;
}

/** One line per reading for journal events: what a selection was made on. */
export function describeReadings(readings: SubstrateReading[], now: Date, config: SubstrateConfig): string {
 const parts = STRONG_SUBSTRATES.map((name) => {
  const r = readings.find((x) => x.substrate === name);
  if (r === undefined) return `${name} unread`;
  const age = readingAgeMin(r, now);
  const windows = (["five_hour", "seven_day"] as const).flatMap((window) => {
   const used = window === "five_hour" ? r.fiveHourUsedPct : r.sevenDayUsedPct;
   if (used === null) return [];
   const reset = window === "five_hour" ? r.fiveHourResetsAt : r.sevenDayResetsAt;
   const remaining = reset === null ? "reset unknown" : formatTimeToReset(Date.parse(reset) - now.getTime());
   return [`${window === "five_hour" ? "5h" : "7d"} ${used}% < ${effectiveThreshold(window, r, now, config).toFixed(1)}% (${remaining})`];
  });
  const capped = isCappedAt(r, now);
  return `${name} ${windows.join(" ") || "no windows"} read ${age}m ago${capped ? " CAPPED" : ""}`;
 });
 return parts.join("; ");
}

function formatTimeToReset(ms: number): string {
 if (!Number.isFinite(ms)) return "reset unknown";
 if (ms <= 0) return "reset reached";
 const hours = ms / 3_600_000;
 const amount = hours >= 24 ? hours / 24 : hours;
 const rounded = amount.toFixed(1).replace(/\.0$/, "");
 return `${rounded}${hours >= 24 ? "d" : "h"} to reset`;
}

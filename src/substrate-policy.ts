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

export type SubstrateConfig = Omit<RangerConfig["substrates"], "pi">;

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
 * capped nor capped-until in the future, and every reported window's used% is
 * under its max-used threshold. Missing or stale readings fail closed.
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

/** One line per reading for journal events: what a selection was made on. */
export function describeReadings(readings: SubstrateReading[], now: Date): string {
 const parts = STRONG_SUBSTRATES.map((name) => {
  const r = readings.find((x) => x.substrate === name);
  if (r === undefined) return `${name} unread`;
  const age = readingAgeMin(r, now);
  const windows = [
   r.fiveHourUsedPct === null ? null : `5h ${r.fiveHourUsedPct}%`,
   r.sevenDayUsedPct === null ? null : `7d ${r.sevenDayUsedPct}%`,
  ].filter((w) => w !== null);
  const capped = isCappedAt(r, now);
  return `${name} ${windows.join(" ") || "no windows"} read ${age}m ago${capped ? " CAPPED" : ""}`;
 });
 return parts.join("; ");
}

import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { implementLane, IMPLEMENT_LANES, type ImplementLane, type LaneMap } from "./lanes.ts";

export const LAST_IMPLEMENT_MAP = "implement.lastMap";
export function lastImplementMaps(journal: Pick<Journal, "getHealth"> | null): Record<ImplementLane, string | null> {
 return Object.fromEntries(IMPLEMENT_LANES.map(lane => [lane,
  journal?.getHealth(`${LAST_IMPLEMENT_MAP}.${lane}`) ?? journal?.getHealth(LAST_IMPLEMENT_MAP) ?? null,
 ])) as Record<ImplementLane, string | null>;
}

export function recordImplementStart(journal: Journal, map: LaneMap): void {
 journal.setHealth(LAST_IMPLEMENT_MAP, mapKey(map));
 journal.setHealth(`${LAST_IMPLEMENT_MAP}.${implementLane(map)}`, mapKey(map));
}
export function mapKey(map: { repo: string; root: number }): string {
 return `${map.repo}#${map.root}`;
}

export function pickMap(config: RangerConfig, selector?: string): RangerMapConfig {
 const matches = selector === undefined ? config.maps : config.maps.filter(
  m => selector === m.repo || selector === mapKey(m),
 );
 if (matches.length === 1) return matches[0];
 if (matches.length === 0) throw new Error(`no map registered for '${selector}'`);
 throw new Error(`--map owner/name#root is required; candidates: ${matches.map(mapKey).join(", ")}`);
}

/** The journal supplies the root; a repo-only resume selector need not disambiguate it. */
export function resumeMap(config: RangerConfig, rows: WorkerRow[], nodeId: string, selector?: string): RangerMapConfig {
 const matches = rows.filter(w => w.nodeId === nodeId && (
  selector === undefined || selector === w.repo || selector === mapKey(w)
 ));
 if (matches.length !== 1) throw new Error(`no unique journal row for node ${nodeId}; candidates: ${matches.map(mapKey).join(", ") || "none"}`);
 return pickMap(config, mapKey(matches[0]));
}

/** Rotate past the map of the last implement start; empty/gated maps are skipped by planning. */
export function mapOrder<T extends { repo: string; root: number }>(maps: readonly T[], last: string | null): T[] {
 const at = maps.findIndex(m => mapKey(m) === last);
 return at < 0 ? [...maps] : [...maps.slice(at + 1), ...maps.slice(0, at + 1)];
}

/** Each resource lane rotates independently, retaining the config's lane slots. */
export function implementMapOrder<T extends { repo: string; root: number }>(
 maps: readonly T[],
 lastByLane: Partial<Record<ImplementLane, string | null>>,
 laneOf: (map: T) => ImplementLane,
): T[] {
 const queues = Object.fromEntries(IMPLEMENT_LANES.map(lane => [
  lane, mapOrder(maps.filter(m => laneOf(m) === lane), lastByLane[lane] ?? null),
 ])) as Record<ImplementLane, T[]>;
 return maps.map(map => queues[laneOf(map)].shift()!);
}

import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal, WorkerRow } from "./journal.ts";

export const LAST_IMPLEMENT_MAP = "implement.lastMap";
export function recordImplementStart(journal: Journal, map: { repo: string; root: number }): void {
 journal.setHealth(LAST_IMPLEMENT_MAP, mapKey(map));
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

/** Rotate past the last successful implement claim; empty/gated maps are skipped by planning. */
export function mapOrder<T extends { repo: string; root: number }>(maps: readonly T[], last: string | null): T[] {
 const at = maps.findIndex(m => mapKey(m) === last);
 return at < 0 ? [...maps] : [...maps.slice(at + 1), ...maps.slice(0, at + 1)];
}

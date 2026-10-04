import type { Database } from "bun:sqlite";

function hasRootColumn(sqlite: Database, table: string): boolean {
 const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
 return columns.some(c => c.name === "root");
}

/** Persist custom migration inputs before Drizzle starts its schema transaction. */
export function seedLegacyRoots(
 sqlite: Database,
 maps: readonly { repo: string; root: number }[],
 legacyMapRoots: Readonly<Record<string, number>>,
): void {
 if (hasRootColumn(sqlite, "workers")) return;
 const legacyRepos = new Set<string>();
 for (const table of ["workers", "escalations"]) {
  const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.length === 0 || columns.some(c => c.name === "root")) continue;
  const rows = sqlite.query(`SELECT DISTINCT repo FROM ${table}`).all() as { repo: string }[];
  for (const { repo } of rows) legacyRepos.add(repo);
 }
 if ((sqlite.query("PRAGMA table_info(health)").all()).length > 0) {
  const rows = sqlite.query("SELECT key FROM health WHERE key LIKE 'digest.%' OR key LIKE 'escalate.%'").all() as { key: string }[];
  for (const { key } of rows) {
   const repo = /^(?:digest\.|escalate\.(?:cursor|absentCursor)\.)([^/#]+\/[^/#]+)$/.exec(key)?.[1];
   if (repo !== undefined) legacyRepos.add(repo);
  }
 }
 const roots = new Map<string, number>();
 for (const repo of legacyRepos) {
  const candidates = maps.filter(m => m.repo === repo);
  const explicit = legacyMapRoots[repo];
  if (explicit !== undefined && (!Number.isSafeInteger(explicit) || explicit <= 0)) {
   throw new Error(`state.legacyMapRoots.${repo} must be a positive integer`);
  }
  if (explicit !== undefined || candidates.length === 1) roots.set(repo, explicit ?? candidates[0].root);
 }
 const unresolved = [...legacyRepos].filter(repo => !roots.has(repo)).sort();
 if (unresolved.length > 0) {
  throw new Error(`Cannot backfill legacy map roots for: ${unresolved.join(", ")}. Register one map per repo or set state.legacyMapRoots to its original root, including for deregistered repos.`);
 }
 sqlite.transaction(() => {
  // Only prepare cutover inputs before workers have acquired their root column.
  if (hasRootColumn(sqlite, "workers")) return;
  sqlite.run("CREATE TABLE IF NOT EXISTS ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
  for (const repo of legacyRepos) {
   sqlite.run("INSERT OR REPLACE INTO ranger_legacy_roots VALUES (?, ?)", [repo, roots.get(repo)!]);
  }
 })();
}

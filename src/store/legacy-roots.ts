import type { Database } from "bun:sqlite";

/** Persist custom migration inputs before Drizzle starts its schema transaction. */
export function seedLegacyRoots(
 sqlite: Database,
 maps: readonly { repo: string; root: number }[],
 legacyMapRoots: Readonly<Record<string, number>>,
): void {
 const legacyRepos = new Set<string>();
 for (const table of ["workers", "escalations"]) {
  const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.length === 0 || columns.some(c => c.name === "root")) continue;
  const rows = sqlite.query(`SELECT DISTINCT repo FROM ${table}`).all() as { repo: string }[];
  for (const { repo } of rows) legacyRepos.add(repo);
 }
 const roots = new Map<string, number>();
 for (const repo of legacyRepos) {
  const candidates = maps.filter(m => m.repo === repo);
  const explicit = legacyMapRoots[repo];
  if (explicit !== undefined && !candidates.some(m => m.root === explicit)) {
   throw new Error(`state.legacyMapRoots.${repo} must name a registered root`);
  }
  if (explicit !== undefined || candidates.length === 1) roots.set(repo, explicit ?? candidates[0].root);
 }
 const unresolved = [...legacyRepos].filter(repo => !roots.has(repo)).sort();
 if (unresolved.length > 0) {
  throw new Error(`Cannot backfill legacy map roots for: ${unresolved.join(", ")}. Register one map per repo or set state.legacyMapRoots to its registered legacy root.`);
 }
 sqlite.transaction(() => {
  // Only prepare cutover inputs before workers have acquired their root column.
  const columns = sqlite.query("PRAGMA table_info(workers)").all() as { name: string }[];
  if (columns.some(c => c.name === "root")) return;
  sqlite.run("CREATE TABLE IF NOT EXISTS ranger_legacy_roots (repo text PRIMARY KEY, root integer NOT NULL)");
  for (const repo of legacyRepos) {
   sqlite.run("INSERT OR REPLACE INTO ranger_legacy_roots VALUES (?, ?)", [repo, roots.get(repo)!]);
  }
 })();
}

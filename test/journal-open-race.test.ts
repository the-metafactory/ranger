import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";

/**
 * Several processes opening one fresh journal at the same instant: the tick,
 * `ranger serve`'s verbs, run-node supervisors, or two test CLIs. Each open
 * switches the file to WAL and runs the migrations; a loser of either race
 * used to fail with "database is locked" or "table already exists" (the
 * escalate overlapping-runs e2e test flaked on it in CI).
 */

const journalModule = join(import.meta.dir, "../src/journal.ts");
const OPENERS = 6;
const MIGRATIONS = readdirSync(join(import.meta.dir, "../drizzle")).filter((f) => f.endsWith(".sql")).length;

function openAt(path: string, at: number): Promise<{ code: number; stderr: string }> {
 return new Promise((resolve) => {
  // Each child spins to the shared start instant, so the opens truly overlap.
  const script = `import { Journal } from ${JSON.stringify(journalModule)};
while (Date.now() < ${at}) {}
new Journal(${JSON.stringify(path)}).close();`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
 });
}

describe("journal open race", () => {
 test("six processes opening one fresh journal at once all succeed, and it is migrated once", async () => {
  for (let round = 0; round < 3; round++) {
   const dir = mkdtempSync(join(tmpdir(), "ranger-open-race-"));
   try {
    const path = join(dir, "state.sqlite");
    const at = Date.now() + 750;
    const runs = await Promise.all(Array.from({ length: OPENERS }, () => openAt(path, at)));
    expect(runs.filter((r) => r.code !== 0).map((r) => r.stderr.slice(-300))).toEqual([]);
    const journal = new Journal(path);
    try {
     expect(journal.listWorkers("acme/widgets")).toEqual([]);
    } finally {
     journal.close();
    }
    const sqlite = new Database(path, { readonly: true });
    try {
     const { n } = sqlite.query("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
     expect(n).toBe(MIGRATIONS);
    } finally {
     sqlite.close();
    }
   } finally {
    rmSync(dir, { recursive: true, force: true });
   }
  }
 });
});

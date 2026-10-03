import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunResult } from "./exec.ts";

/**
 * Keep each worker session's output (design §8 reading order: "journal row →
 * worker transcript log → PR/review → receipt"). Without it a worker that
 * exits 0 having done nothing leaves no trace of why (found live on seelite
 * #669). One file per node and generation, next to the journal, 0600.
 */
export function saveWorkerLog(
 journalPath: string,
 repo: string,
 nodeId: string,
 generation: number,
 label: string,
 result: RunResult,
): string {
 const dir = join(dirname(journalPath), "logs", "workers");
 mkdirSync(dir, { recursive: true, mode: 0o700 });
 const file = join(dir, `${repo.replace("/", "__")}-${nodeId}-g${generation}.log`);
 appendFileSync(
  file,
  [
   `===== ${new Date().toISOString()} ${label} — exit ${result.code}`,
   "----- stdout",
   result.stdout,
   "----- stderr",
   result.stderr,
   "",
  ].join("\n"),
  { mode: 0o600 },
 );
 return file;
}

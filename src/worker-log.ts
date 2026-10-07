import { encodeForgeRef, parseForgeRef } from "./forge-ref.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunResult } from "./exec.ts";

/** The node and generation's log file: one per node and generation, next to the journal. */
export function workerLogFile(journalPath: string, repo: string, nodeId: string, generation: number): string {
 return join(dirname(journalPath), "logs", "workers", `${encodeForgeRef(parseForgeRef(repo), nodeId).fileStem}-g${generation}.log`);
}

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
 const file = workerLogFile(journalPath, repo, nodeId, generation);
 mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
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

/**
 * `saveWorkerLog` that never throws: the log is evidence, never a gate
 * (node #107). Returns the file, or why it could not be written.
 */
export function tryWorkerLog(
 journalPath: string,
 repo: string,
 nodeId: string,
 generation: number,
 label: string,
 result: RunResult,
): { file: string } | { error: string } {
 try {
  return { file: saveWorkerLog(journalPath, repo, nodeId, generation, label, result) };
 } catch (error) {
  return { error: error instanceof Error ? error.message : String(error) };
 }
}

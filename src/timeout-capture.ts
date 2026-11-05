import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "./exec.ts";

const PS_TIMEOUT_MS = 10_000;
const SAMPLE_TIMEOUT_MS = 10_000;
const SAMPLE_SECONDS = "1";
const MOST_PROCESSES_SAMPLED = 24;
const SAMPLE_REPORT_CHARS = 6_000;
const PS_COLUMNS = "pid=,ppid=,pgid=,stat=,etime=,time=,%cpu=,command=";
const CALL_GRAPH_HEADING = "Call graph:";

/** The longest a run's kill can wait for `captureProcessGroup`; past its own tool limits, this is only a backstop. */
export const TIMEOUT_CAPTURE_LIMIT_MS = 30_000;

export interface ProcessRow {
 pid: number;
 ppid: number;
 pgid: number;
 stat: string;
 line: string;
}

function parseRow(line: string): ProcessRow | null {
 const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s/.exec(line);
 if (match === null) return null;
 return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4], line: line.trim() };
}

/** A process group's rows from a `ps` listing, plus every descendant: a child that left the group can be the one holding the run open. */
export function processTree(listing: string, pgid: number): ProcessRow[] {
 const rows = listing.split("\n").map(parseRow).filter((row) => row !== null);
 const kept = new Set(rows.filter((row) => row.pgid === pgid).map((row) => row.pid));
 let size = 0;
 while (kept.size !== size) {
  size = kept.size;
  for (const row of rows) if (kept.has(row.ppid)) kept.add(row.pid);
 }
 return rows.filter((row) => kept.has(row.pid));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function sampleProcess(pid: number): Promise<string> {
 const dir = await mkdtemp(join(tmpdir(), "ranger-sample-"));
 try {
  const file = join(dir, "report.txt");
  const result = await runCmd("sample", [String(pid), SAMPLE_SECONDS, "-file", file], { timeoutMs: SAMPLE_TIMEOUT_MS });
  if (result.code !== 0) return `sample failed (exit ${result.code}): ${result.stderr.trim()}`;
  const report = await readFile(file, "utf8");
  const start = report.indexOf(CALL_GRAPH_HEADING);
  return report.slice(Math.max(start, 0), Math.max(start, 0) + SAMPLE_REPORT_CHARS);
 } catch (error) {
  return `sample failed: ${message(error)}`;
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
}

async function samples(tree: ProcessRow[], platform: NodeJS.Platform): Promise<string[]> {
 if (platform !== "darwin") return [`sample: not available on ${platform}`];
 const live = tree.filter((row) => !row.stat.startsWith("Z"));
 const sampled = live.slice(0, MOST_PROCESSES_SAMPLED);
 const reports = await Promise.all(sampled.map(async (row) => `----- sample ${row.pid}\n${await sampleProcess(row.pid)}`));
 const skipped = live.length - sampled.length;
 return skipped > 0 ? [...reports, `sample: ${skipped} more process(es) not sampled`] : reports;
}

/** What a process group is doing right now: its `ps` rows and, on macOS, a stack sample per process. For the worker log, just before a timeout's kill. */
export async function captureProcessGroup(pgid: number, platform: NodeJS.Platform = process.platform): Promise<string> {
 const listing = await runCmd("ps", ["-A", "-ww", "-o", PS_COLUMNS], { timeoutMs: PS_TIMEOUT_MS });
 const tree = processTree(listing.stdout, pgid);
 return [
  "pid ppid pgid stat elapsed cputime %cpu command",
  ...tree.map((row) => row.line),
  ...(await samples(tree, platform)),
 ].join("\n");
}

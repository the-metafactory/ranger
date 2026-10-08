import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Child user + system CPU observed by the opt-in shadow timer; absent if unavailable. */
  cpuTimeSeconds?: number;
  /**
   * With `keepStdoutLine`: the last unfiltered stdout lines (each cut to a
   * bounded length), so a run that dies before its signal lines still leaves
   * diagnostics.
   */
  stdoutTail?: string;
}

/** Stdout tail kept beside a filtered stream: lines, and characters per line. */
const TAIL_LINES = 50;
const TAIL_LINE_CHARS = 2_000;

/** Split complete lines off a buffer; the trailing partial line is `rest`. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines, rest };
}

export interface RunOptions {
  /** Full env for the child. When `env` is provided it replaces the child env entirely. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Run the child as the leader of its own process group, and on timeout kill
   * the whole group, not just the child (#23 amendment F1). A headless worker
   * starts grandchildren (test runners, git, reviewers); killing only the
   * direct child leaves them running in the worktree.
   */
  processGroup?: boolean;
  /** Called with the child's PID once it has spawned (the group id when `processGroup`). */
  onSpawn?: (pid: number) => void;
  /**
   * Keep only the stdout lines this accepts, filtered as they stream: a long
   * verbose stream (Claude stream-json) is never held whole in memory.
   */
  keepStdoutLine?: (line: string) => boolean;
  /**
   * Run the child at this lower CPU priority (`nice -n`), so timing-
   * sensitive work on the same host (the browser probes) keeps the CPU.
   * Undefined or 0: the caller's own priority.
   */
  nice?: number;
}

/**
 * Run one command, capturing stdout/stderr. Errors on spawn failure; a
 * non-zero exit is returned as `code`, not thrown — callers decide what a
 * non-zero means.
 */
export function runCmd(
  bin: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    // `nice` execs the command in place: the PID (and so the process group)
    // is the command's own.
    const niced = opts.nice !== undefined && opts.nice > 0;
    const child = spawn(niced ? "nice" : bin, niced ? ["-n", String(opts.nice), bin, ...args] : args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: opts.processGroup === true,
    });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    let stdout = "";
    let stderr = "";
    const keep = opts.keepStdoutLine;
    // A partial line accumulates as chunks and is joined once its newline
    // arrives: a multi-MB stream line is never re-copied per chunk.
    let partial: string[] = [];
    const tail: string[] = [];
    const keepLine = (line: string) => {
      if (keep?.(line)) stdout += `${line}\n`;
      tail.push(line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}…` : line);
      if (tail.length > TAIL_LINES) tail.shift();
    };
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (keep === undefined) {
        stdout += text;
        return;
      }
      if (!text.includes("\n")) {
        partial.push(text);
        return;
      }
      const { lines, rest } = splitLines(partial.join("") + text);
      partial = rest.length > 0 ? [rest] : [];
      for (const line of lines) keepLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (opts.processGroup === true && child.pid !== undefined) {
              killProcessGroup(child.pid);
            } else {
              child.kill("SIGKILL");
            }
          }, opts.timeoutMs);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`failed to spawn ${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (keep === undefined) {
        resolvePromise({ code: code ?? -1, stdout, stderr });
        return;
      }
      if (partial.length > 0) keepLine(partial.join(""));
      resolvePromise({ code: code ?? -1, stdout, stderr, stdoutTail: tail.join("\n") });
    });
  });
}

/** SIGKILL a whole process group. Returns false when the group is already gone. */
export function killProcessGroup(pgid: number): boolean {
  if (pgid <= 1) return false;
  try {
    process.kill(-pgid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * The command lines of every live process in a group. Sweep uses this to
 * confirm a recorded group is still ranger's worker before killing it: a
 * recycled group id must never be killed on the journal's word alone.
 */
export async function processGroupCommands(pgid: number): Promise<string[]> {
  if (pgid <= 1) return [];
  const result = await runCmd("ps", ["-A", "-ww", "-o", "pgid=,command="], {
    timeoutMs: 10_000,
  });
  if (result.code !== 0) return [];
  const commands: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match !== null && Number(match[1]) === pgid) commands.push(match[2]);
  }
  return commands;
}

/** Is a PID alive on this host? `kill(pid, 0)` is a pure liveness probe. */
export function pidAlive(pid: number | null): boolean {
 if (pid === null || pid <= 0) return false;
 try {
  process.kill(pid, 0);
  return true;
 } catch {
  return false;
 }
}

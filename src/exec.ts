import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Full env for the child. When `env` is provided it replaces the child env entirely. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
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
    const child = spawn(bin, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`failed to spawn ${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

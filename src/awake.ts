import { spawn } from "node:child_process";

/**
 * Keep the host awake while a run-node supervisor lives (found live
 * 2026-10-04: the Mac idle-slept at 03:50 during #658's probe run, the run
 * timed out, and the retry read silence from the audio probes).
 *
 * On macOS, `caffeinate -i -w <pid>` holds an idle-sleep assertion until the
 * watched process exits, so the worker session, the sage rounds and the probe
 * tier all run on an awake machine, and nothing is left holding it after a
 * crash. The display may still sleep: the probe tier passed with the display
 * off (#662), so only system sleep is prevented.
 */
export function caffeinateArgs(pid: number): string[] {
 return ["-i", "-w", String(pid)];
}

export function holdAwake(
 pid: number = process.pid,
 platform: NodeJS.Platform = process.platform,
 spawnFn: typeof spawn = spawn,
): boolean {
 if (platform !== "darwin") return false;
 try {
  const child = spawnFn("caffeinate", caffeinateArgs(pid), {
   detached: true,
   stdio: "ignore",
  });
  child.on("error", () => {
   /* no caffeinate: run without the assertion rather than fail the node */
  });
  child.unref();
  return true;
 } catch {
  return false;
 }
}

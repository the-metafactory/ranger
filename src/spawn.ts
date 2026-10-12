import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mapKey } from "./maps.ts";

export interface SpawnRunNodeArgs {
 nodeId: string;
 repo: string;
 root: number;
 cliEntry: string;
 configPath: string;
}

/**
 * Bun arguments for a detached run-node. The child inherits the tokens and
 * the caller's cwd, so bun reads ranger's own bunfig.toml (its default is
 * $cwd/bunfig.toml, whose `preload` runs first) and no .env (whose
 * `SAGE_X=$GH_TOKEN` would copy a token into a name the worker env
 * forwards) — the same pins as ops/bin/ranger.example (node #66).
 */
export function runNodeArgv(args: SpawnRunNodeArgs): string[] {
 return [
  `--config=${join(dirname(args.cliEntry), "..", "bunfig.toml")}`,
  "--no-env-file",
  args.cliEntry,
  "run-node",
  args.nodeId,
  "--map",
  mapKey(args),
  "--config",
  args.configPath,
 ];
}

/**
 * Launch a detached `ranger run-node` that outlives this tick (design §1).
 * Returns the child PID (null when no process was spawned).
 */
export async function spawnRunNodeDetached(
 args: SpawnRunNodeArgs,
): Promise<number | null> {
 // Test/operational seam: claim without spawning a worker (simulation, or a
 // run where the operator drives run-node by hand).
 if (process.env.RANGER_NO_SPAWN === "1") {
  return null;
 }
 const child = spawn(
  process.execPath,
  runNodeArgv(args),
  {
   detached: true,
   stdio: "ignore",
   env: process.env,
  },
 );
 // A spawn that fails (ENOENT, EACCES) has no pid and emits `error` later;
 // unhandled, that error would kill the caller after its `claimed` row.
 // The null pid is the caller's signal that no worker started.
 child.on("error", () => {});
 child.unref();
 return child.pid ?? null;
}

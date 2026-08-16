import { runCmd, type RunOptions } from "./exec.ts";
import { writeEnv } from "./identity.ts";

/**
 * The graph-MUTATING `soma graph` surface, reachable only from walker
 * components (claim/run-node/sweep) — never from scout, whose read-only
 * surface lives in graph.ts and mechanically refuses every verb outside
 * `frontier`/`node`/`audit`. Callers pass the machine-account write token; this
 * module pins it via `writeEnv` (no `SOMA_GRAPH_READONLY`).
 */

export class GraphWriteError extends Error {
 override readonly name = "GraphWriteError";
}

export interface ClaimResult {
 repo: string;
 node: string;
 /** `soma graph claim` resolves the race by re-reading after writing. */
 held: boolean;
 /** The race winner, when the claim was lost. */
 holder?: string | null;
 assignees: string[];
}

export interface ReleaseResult {
 repo: string;
 node: string;
 released: boolean;
 assignees: string[];
}

export interface CloseResult {
 repo: string;
 node: string;
 closed: boolean;
 /** Close receipt text (or refusal reason) from the verb. */
 detail: string;
}

export interface DecisionsResult {
 repo: string;
 root: string;
 written: boolean;
 detail: string;
}

interface CallWriteResult {
 code: number;
 stdout: string;
 stderr: string;
}

async function callWrite(
  args: string[],
  token: string,
  opts: RunOptions = {},
): Promise<CallWriteResult> {
  const gated = writeEnv(token);
  try {
    return await runCmd("soma", args, { ...opts, env: gated.env });
  } finally {
    gated.cleanup();
  }
}

/**
 * Claim a node under the bot identity. A lost race is NOT an error — the verb
 * re-reads and resolves the tie, and returns exit 1 with the JSON on stderr.
 * Returns `held: false` in that case; the caller treats it as "skip".
 */
export async function graphClaim(
 repo: string,
 id: string,
 identity: string,
 token: string,
 opts: RunOptions = {},
): Promise<ClaimResult> {
 const args = ["graph", "claim", id, "--identity", identity, "--repo", repo, "--json"];
 const result = await callWrite(args, token, opts);
 const payload = parsePayload(result, "claim");
 if (result.code === 0) {
  return payload as unknown as ClaimResult;
 }
 // Exit 1 = race lost (SomaCliError with JSON payload). Anything else is a real
 // failure worth surfacing.
 const parsed = payload as unknown as ClaimResult;
 if (result.code === 1 && typeof parsed.held === "boolean") {
  return parsed;
 }
 throw new GraphWriteError(
  `soma graph claim ${id} (${repo}) failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
 );
}

/** Release a claim under the bot identity (self-release only). */
export async function graphRelease(
 repo: string,
 id: string,
 identity: string,
 token: string,
 opts: RunOptions = {},
): Promise<ReleaseResult> {
 const args = ["graph", "release", id, "--identity", identity, "--repo", repo, "--json"];
 const result = await callWrite(args, token, opts);
 if (result.code !== 0) {
  throw new GraphWriteError(
   `soma graph release ${id} (${repo}) failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
  );
 }
 return parsePayload(result, "release") as unknown as ReleaseResult;
}

export interface CloseOptions {
 resolutionFile: string;
 gist?: string;
 checkpointId?: string;
 dryRun?: boolean;
}

/**
 * Close a node under the bot identity. `close` has no `--json` surface yet
 * (soma note: "close --json remains optional follow-up"), so success is exit 0
 * and the stdout receipt text is captured as `detail`. A refused close (exit 1)
 * returns `closed: false` with the refusal reason in `detail` — callers decide
 * whether that is a park signal, never a silent pass.
 */
export async function graphClose(
 repo: string,
 id: string,
 identity: string,
 token: string,
 options: CloseOptions,
 opts: RunOptions = {},
): Promise<CloseResult> {
 const args = [
  "graph", "close", id,
  "--resolution-file", options.resolutionFile,
  "--identity", identity,
  "--repo", repo,
 ];
 if (options.gist !== undefined) args.push("--gist", options.gist);
 if (options.checkpointId !== undefined) args.push("--checkpoint", options.checkpointId);
 if (options.dryRun === true) args.push("--dry-run");
 const result = await callWrite(args, token, opts);
 const detail = (result.stdout || result.stderr).trim();
 if (result.code === 0) {
  return { repo, node: id, closed: true, detail };
 }
 return { repo, node: id, closed: false, detail };
}

/** Re-project the map's decision index from close receipts. */
export async function graphDecisions(
 repo: string,
 root: string,
 token: string,
 opts: RunOptions = {},
): Promise<DecisionsResult> {
 const args = ["graph", "decisions", root, "--write", "--repo", repo];
 const result = await callWrite(args, token, opts);
 const detail = (result.stdout || result.stderr).trim();
 if (result.code !== 0) {
  throw new GraphWriteError(
   `soma graph decisions --write ${root} (${repo}) failed (exit ${result.code}): ${detail}`,
  );
 }
 return { repo, root, written: true, detail };
}

function parsePayload(
 result: CallWriteResult,
 label: string,
): Record<string, unknown> {
 const raw = (result.code === 0 ? result.stdout : result.stderr).trim();
 try {
  return JSON.parse(raw) as Record<string, unknown>;
 } catch {
  throw new GraphWriteError(
   `unparseable JSON from soma graph ${label} (exit ${result.code}): ${raw || "(empty)"}`,
  );
 }
}

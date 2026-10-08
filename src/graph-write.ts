import { somaRepo } from "./graph.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import { writeEnv } from "./identity.ts";
import { parseForgeRef, normalizeNodeId, type ForgeRef } from "./forge-ref.ts";

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

function writeNodeId(ref: ForgeRef, value: unknown): string {
 try {
  if (typeof value !== "string") throw new Error(`missing or non-string node id for ${somaRepo(ref)}`);
  return normalizeNodeId(ref, value);
 } catch (error) { throw new GraphWriteError((error as Error).message); }
}

function withNode<T extends { node: string }>(ref: ForgeRef, result: T): T {
 return { ...result, node: writeNodeId(ref, result.node) };
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
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 const args = ["graph", "claim", id, "--identity", identity, "--repo", somaRepo(ref), "--json"];
 const result = await callWrite(args, token, opts);
 const payload = parsePayload(result, "claim");
 if (result.code === 0) {
  const parsed = payload as unknown as ClaimResult;
  return withNode(ref, parsed);
 }
 // Exit 1 = race lost (SomaCliError with JSON payload). Anything else is a real
 // failure worth surfacing.
 const parsed = payload as unknown as ClaimResult;
 if (result.code === 1 && typeof parsed.held === "boolean") {
  return withNode(ref, parsed);
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
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 const args = ["graph", "release", id, "--identity", identity, "--repo", somaRepo(ref), "--json"];
 const result = await callWrite(args, token, opts);
 if (result.code !== 0) {
  throw new GraphWriteError(
   `soma graph release ${id} (${repo}) failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
  );
 }
 const parsed = parsePayload(result, "release") as unknown as ReleaseResult;
 return withNode(ref, parsed);
}

export interface CloseOptions {
 resolutionFile: string;
 gist?: string;
 checkpointId?: string;
 dryRun?: boolean;
 /** `<checkRunId>@<headSha>` — soma requires a successful CI run to close an auto node. */
 ci?: string;
 /** Informational evidence entries (soma derives the gating kinds itself). */
 evidence?: { kind: string; summary: string; pointer: string }[];
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
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 const args = [
  "graph", "close", id,
  "--resolution-file", options.resolutionFile,
  "--identity", identity,
  "--repo", somaRepo(ref),
 ];
 if (options.gist !== undefined) args.push("--gist", options.gist);
 if (options.checkpointId !== undefined) args.push("--checkpoint", options.checkpointId);
 if (options.ci !== undefined) args.push("--ci", options.ci);
 for (const entry of options.evidence ?? []) {
  args.push("--evidence", JSON.stringify(entry));
 }
 if (options.dryRun === true) args.push("--dry-run");
 const result = await callWrite(args, token, opts);
 const detail = (result.stdout || result.stderr).trim();
 if (result.code === 0) {
  return { repo, node: id, closed: true, detail };
 }
 return { repo, node: id, closed: false, detail };
}

export interface AddSpec {
 title: string;
 autonomy: "auto" | "propose" | "approve";
 /** Minted at add time: no verb attaches a checkpoint later. */
 checkpoint: string;
 kind?: string;
 labels?: string[];
 body?: string;
}

export interface AddResult {
 repo: string;
 node: string;
 parent: string;
}

/**
 * Create a node below `parent` (the spawning node, never the map root).
 * Exit 1 with `attached: false` means the node exists but hangs off no
 * parent; that is a failure, and the message names the created node so a
 * retry's duplicate can be traced.
 */
export async function graphAdd(
 repo: string,
 parent: string,
 spec: AddSpec,
 token: string,
 opts: RunOptions = {},
): Promise<AddResult> {
 const ref = parseForgeRef(repo);
 parent = writeNodeId(ref, parent);
 const args = [
  "graph", "add", parent,
  "--title", spec.title,
  "--autonomy", spec.autonomy,
  "--checkpoint", spec.checkpoint,
 ];
 if (spec.kind !== undefined) args.push("--kind", spec.kind);
 for (const label of spec.labels ?? []) args.push("--label", label);
 if (spec.body !== undefined) args.push("--body", spec.body);
 args.push("--repo", somaRepo(ref), "--json");
 const result = await callWrite(args, token, opts);
 if (result.code !== 0) {
  let created = "";
  try {
   const payload = parsePayload(result, "add");
   if (typeof payload.node === "string") created = ` — created ${payload.node} but left it unattached`;
  } catch { /* no payload: nothing was created */ }
  throw new GraphWriteError(
   `soma graph add below ${parent} (${repo}) failed (exit ${result.code})${created}: ${(result.stderr || result.stdout).trim()}`.slice(0, 600),
  );
 }
 const payload = parsePayload(result, "add");
 return { repo, node: writeNodeId(ref, payload.node), parent };
}

/** Re-project the map's decision index from close receipts. */
export async function graphDecisions(
 repo: string,
 root: string,
 token: string,
 opts: RunOptions = {},
): Promise<DecisionsResult> {
 const ref = parseForgeRef(repo);
 root = writeNodeId(ref, root);
 const args = ["graph", "decisions", root, "--write", "--repo", somaRepo(ref)];
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
  const payload: unknown = JSON.parse(raw);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
  return payload as Record<string, unknown>;
 } catch {
  throw new GraphWriteError(
   `unparseable JSON from soma graph ${label} (exit ${result.code}): ${raw || "(empty)"}`,
  );
 }
}

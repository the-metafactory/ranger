import { GRAPH_CALL_TIMEOUT_MS, somaRepo, type FrontierEntryNode } from "./graph.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import { writeEnvForRepo } from "./identity.ts";
import { parseForgeRef, normalizeNodeId, type ForgeRef } from "./forge-ref.ts";

/**
 * The graph-MUTATING `soma graph` surface, reachable only from walker
 * components (claim/run-node/sweep) — never from scout, whose read-only
 * surface lives in graph.ts and mechanically refuses every verb outside
 * `frontier`/`node`/`audit`. Callers pass the machine-account write token; this
 * module pins it via `writeEnvForRepo` (GitLab writes use per-call config).
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
 timedOut?: boolean;
}

export interface DecisionsResult {
 repo: string;
 root: string;
 written: boolean;
 detail: string;
}

export interface GraphWriteRunOptions extends RunOptions {
 runner?: typeof runCmd;
}

interface CallWriteResult {
 code: number;
 stdout: string;
 stderr: string;
 timedOut?: boolean;
}

async function callWrite(
  repo: string,
  args: string[],
  token: string,
  opts: GraphWriteRunOptions = {},
): Promise<CallWriteResult> {
  const gated = writeEnvForRepo(repo, token, opts.env);
  try {
    return await (opts.runner ?? runCmd)("soma", args, { ...opts, env: gated.env });
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
 opts: GraphWriteRunOptions = {},
): Promise<ClaimResult> {
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 const args = ["graph", "claim", id, "--identity", identity, "--repo", somaRepo(ref), "--json"];
 const result = await callWrite(repo, args, token, opts);
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
 opts: GraphWriteRunOptions = {},
): Promise<ReleaseResult> {
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 const args = ["graph", "release", id, "--identity", identity, "--repo", somaRepo(ref), "--json"];
 const result = await callWrite(repo, args, token, opts);
 if (result.code !== 0) {
  throw new GraphWriteError(
   `soma graph release ${id} (${repo}) failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
  );
 }
 const parsed = parsePayload(result, "release") as unknown as ReleaseResult;
 return withNode(ref, parsed);
}

export interface CloseOptions {
 /** Required unless `proposalComment` names the proposal whose body is the resolution. */
 resolutionFile?: string;
 /**
  * A ratified proposal (node #250): soma reads the comment's reactions and
  * records `approved` evidence for a non-proposer 👍; the comment's body
  * is the resolution.
  */
 proposalComment?: string;
 gist?: string;
 checkpointId?: string;
 dryRun?: boolean;
 /** `<checkRunId>@<headSha>` — soma requires a successful CI run to close an auto node. */
 ci?: string;
 /** Informational evidence entries (soma derives the gating kinds itself). */
 evidence?: { kind: string; summary: string; pointer: string }[];
}

const CLOSE_PROBE_MARGIN_MS = 60_000;

/**
 * The timeout for a `soma graph close` call. The close gate runs the node's
 * command probes inside the call, each up to its `timeoutSec`, so the call
 * must outlast their sum plus a margin; never below `floorMs`.
 */
export function closeTimeoutMs(
 probes: readonly { type: string; [key: string]: unknown }[] | undefined,
 floorMs = GRAPH_CALL_TIMEOUT_MS,
): number {
 let probeMs = 0;
 for (const probe of probes ?? []) {
  if (probe.type === "command" && typeof probe.timeoutSec === "number" && probe.timeoutSec > 0) {
   probeMs += probe.timeoutSec * 1000;
  }
 }
 return probeMs === 0 ? floorMs : Math.max(floorMs, probeMs + CLOSE_PROBE_MARGIN_MS);
}

/**
 * The timeout for closing `node`: soma's own reported close deadline plus a
 * margin, so the outer call outlasts the probes soma runs inside it. A node
 * read without a positive finite `closeDeadlineSec` (a soma older than
 * soma#1079) falls back to the sum of its command probes.
 */
export function closeTimeoutForNode(
 node: { closeDeadlineSec?: unknown; node: Pick<FrontierEntryNode, "probes"> },
 floorMs = GRAPH_CALL_TIMEOUT_MS,
): number {
 const deadline = node.closeDeadlineSec;
 if (typeof deadline === "number" && Number.isFinite(deadline) && deadline > 0) {
  return Math.max(floorMs, deadline * 1000 + CLOSE_PROBE_MARGIN_MS);
 }
 return closeTimeoutMs(node.node.probes, floorMs);
}

/**
 * Close a node under the bot identity. `close` has no `--json` surface yet
 * (soma note: "close --json remains optional follow-up"), so success is exit 0
 * and the stdout receipt text is captured as `detail`. A refused close (exit 1)
 * returns `closed: false` with the refusal reason in `detail` — callers decide
 * whether that is a park signal, never a silent pass. The call runs as its own
 * process group: on timeout the whole group dies (the `soma` launcher's
 * child keeps running the gate's probes otherwise and finishes the close
 * behind ranger's back), and the result is `timedOut` with a timeout
 * `detail`, never soma's output.
 */
export async function graphClose(
 repo: string,
 id: string,
 identity: string,
 token: string,
 options: CloseOptions,
 opts: GraphWriteRunOptions = {},
): Promise<CloseResult> {
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 if (options.resolutionFile === undefined && options.proposalComment === undefined) {
  throw new GraphWriteError(`soma graph close ${id} (${repo}): no resolution file and no proposal comment`);
 }
 if (options.proposalComment !== undefined && !/^\d+$/.test(options.proposalComment)) {
  throw new GraphWriteError(`soma graph close ${id} (${repo}): proposal comment id ${JSON.stringify(options.proposalComment)} is not numeric`);
 }
 const args = ["graph", "close", id];
 if (options.resolutionFile !== undefined) args.push("--resolution-file", options.resolutionFile);
 if (options.proposalComment !== undefined) args.push("--proposal-comment", options.proposalComment);
 args.push("--identity", identity, "--repo", somaRepo(ref));
 if (options.gist !== undefined) args.push("--gist", options.gist);
 if (options.checkpointId !== undefined) args.push("--checkpoint", options.checkpointId);
 if (options.ci !== undefined) args.push("--ci", options.ci);
 for (const entry of options.evidence ?? []) {
  args.push("--evidence", JSON.stringify(entry));
 }
 if (options.dryRun === true) args.push("--dry-run");
 const timeoutMs = opts.timeoutMs ?? GRAPH_CALL_TIMEOUT_MS;
 const result = await callWrite(repo, args, token, { ...opts, timeoutMs, processGroup: true });
 if (result.timedOut === true) {
  const seconds = timeoutMs / 1000;
  return {
   repo,
   node: id,
   closed: false,
   timedOut: true,
   detail: `soma graph close ${id} (${repo}) timed out after ${seconds}s; its process group was killed`,
  };
 }
 const detail = (result.stdout || result.stderr).trim();
 if (result.code === 0) {
  return { repo, node: id, closed: true, detail };
 }
 return { repo, node: id, closed: false, detail };
}

export interface ProposeResult {
 repo: string;
 node: string;
 /** Exit 0: soma posted the proposal comment. */
 posted: boolean;
 /**
  * The proposal comment's id: soma's `--json` payload when it has one
  * (ruling D18), else parsed from `Posted proposal comment <id>`. Null when
  * neither names it; ranger never guesses an id.
  */
 commentId: string | null;
 /** The comment's URL when soma printed one. */
 commentUrl: string | null;
 /** Stdout (or the refusal on stderr) from the verb. */
 detail: string;
}

const POSTED_PROPOSAL = /Posted proposal comment (\d+)/;
const PROPOSAL_URL = /^url: (https:\/\/\S+)$/m;

/**
 * The proposal comment id and URL from `close --propose` output. Soma prints
 * text today and ignores `--json` on close; once it answers in JSON (ruling
 * D18) a numeric id there wins, and the text parse stays the fallback.
 */
export function parseProposal(stdout: string): { commentId: string | null; commentUrl: string | null } {
 try {
  const payload: unknown = JSON.parse(stdout);
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
   const record = payload as Record<string, unknown>;
   const comment = record.comment !== null && typeof record.comment === "object" ? record.comment as Record<string, unknown> : {};
   const id = [record.commentId, record.proposalComment, record.proposalCommentId, comment.id]
    .map((value) => typeof value === "number" ? String(value) : value)
    .find((value): value is string => typeof value === "string" && /^\d+$/.test(value));
   const url = [record.url, record.commentUrl, comment.url].find((value): value is string => typeof value === "string" && value.startsWith("https://"));
   if (id !== undefined) return { commentId: id, commentUrl: url ?? null };
  }
 } catch { /* text output: parse it below */ }
 return {
  commentId: POSTED_PROPOSAL.exec(stdout)?.[1] ?? null,
  commentUrl: PROPOSAL_URL.exec(stdout)?.[1] ?? null,
 };
}

/**
 * Propose a close under the bot identity (node #246, design §5): `soma graph
 * close --propose --body-file` posts the body as a proposal comment and
 * closes nothing. Soma refuses `--resolution-file` and `--dry-run` with
 * `--propose` (the body is the resolution). A refusal (non-zero exit)
 * returns `posted: false` with the reason in `detail`.
 */
export async function graphPropose(
 repo: string,
 id: string,
 identity: string,
 token: string,
 options: { bodyFile: string },
 opts: GraphWriteRunOptions = {},
): Promise<ProposeResult> {
 const ref = parseForgeRef(repo);
 id = writeNodeId(ref, id);
 const args = [
  "graph", "close", id,
  "--propose", "--body-file", options.bodyFile,
  "--identity", identity,
  "--repo", somaRepo(ref),
  "--json",
 ];
 const result = await callWrite(repo, args, token, opts);
 const detail = (result.stdout || result.stderr).trim();
 if (result.code !== 0) return { repo, node: id, posted: false, commentId: null, commentUrl: null, detail };
 return { repo, node: id, posted: true, ...parseProposal(result.stdout.trim()), detail };
}

export interface AddSpec {
 title: string;
 autonomy: "auto" | "propose" | "approve";
 /** Minted at add time: no verb attaches a checkpoint later. */
 checkpoint: string;
 kind?: string;
 /** Each one is passed as its own `--probe <json>`. */
 probes?: readonly unknown[];
 labels?: string[];
 body?: string;
 /** Blocking edges, wired before the node is attached to its parent. */
 blockedBy?: string[];
}

export interface AddResult {
 repo: string;
 node: string;
 parent: string;
}

/**
 * `soma graph add` created the node but did not attach it to its parent: it
 * exists, on no frontier. `node` is its id, so the caller can finish the
 * job with `graphLink` instead of adding a second node.
 */
export class GraphAddUnattached extends GraphWriteError {
 constructor(message: string, readonly node: string, readonly parent: string) {
  super(message);
 }
}

/**
 * Create a node below `parent` (the spawning node, never the map root).
 * Exit 1 with `attached: false` means the node exists but hangs off no
 * parent: that throws `GraphAddUnattached` naming the created node. Any
 * other failure throws `GraphWriteError`; one without a payload (a killed
 * or timed-out call included) cannot say whether a node was created.
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
 for (const probe of spec.probes ?? []) args.push("--probe", JSON.stringify(probe));
 for (const label of spec.labels ?? []) args.push("--label", label);
 if (spec.body !== undefined) args.push("--body", spec.body);
 for (const blocker of spec.blockedBy ?? []) args.push("--blocked-by", writeNodeId(ref, blocker));
 args.push("--repo", somaRepo(ref), "--json");
 const result = await callWrite(repo, args, token, opts);
 if (result.code !== 0) {
  const message = (created: string) =>
   `soma graph add below ${parent} (${repo}) failed (exit ${result.code})${created}: ${(result.stderr || result.stdout).trim()}`.slice(0, 600);
  let node: string | null = null;
  try {
   const payload = parsePayload(result, "add");
   if (payload.attached === false && typeof payload.node === "string") node = writeNodeId(ref, payload.node);
  } catch { /* no payload: whether a node was created is unknown */ }
  if (node !== null) throw new GraphAddUnattached(message(` — created ${node} but left it unattached`), node, parent);
  throw new GraphWriteError(message(""));
 }
 const payload = parsePayload(result, "add");
 return { repo, node: writeNodeId(ref, payload.node), parent };
}

/**
 * Attach an existing node below `parent`, wiring `blockedBy` edges first:
 * the repair for an add that left its node unattached or an edge missing.
 * `soma graph link` skips a parent or edge the node already has, so a
 * re-run is safe; exit 1 (the attach failed) throws.
 */
export async function graphLink(
 repo: string,
 node: string,
 parent: string,
 token: string,
 opts: RunOptions & { blockedBy?: string[] } = {},
): Promise<void> {
 const ref = parseForgeRef(repo);
 node = writeNodeId(ref, node);
 parent = writeNodeId(ref, parent);
 const { blockedBy = [], ...run } = opts;
 const args = ["graph", "link", node, ...blockedBy.flatMap((id) => ["--blocked-by", writeNodeId(ref, id)]), "--parent", parent, "--repo", somaRepo(ref), "--json"];
 const result = await callWrite(repo, args, token, run);
 if (result.code !== 0) {
  throw new GraphWriteError(
   `soma graph link ${node} --parent ${parent} (${repo}) failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`.slice(0, 600),
  );
 }
 const status = parsePayload(result, "link").parentStatus;
 if (status !== "attached" && status !== "already") {
  throw new GraphWriteError(`soma graph link ${node} --parent ${parent} (${repo}) did not attach it: parentStatus ${String(status)}`);
 }
}

/** Re-project the map's decision index from close receipts. */
export async function graphDecisions(
 repo: string,
 root: string,
 token: string,
 opts: GraphWriteRunOptions = {},
): Promise<DecisionsResult> {
 const ref = parseForgeRef(repo);
 root = writeNodeId(ref, root);
 const args = ["graph", "decisions", root, "--write", "--repo", somaRepo(ref)];
 const result = await callWrite(repo, args, token, opts);
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

import { runReadRetryingTransient } from "./transient.ts";
import { gatedEnv, type ResolvedToken } from "./token-gate.ts";
import { parseForgeRef, qualifiedRepo, normalizeNodeId, type ForgeRef } from "./forge-ref.ts";

/**
 * The read-only `soma graph` surface. Scout never calls any other verb —
 * the map constraint fixes the read-only verb surface to
 * `audit` / `frontier` / `node` (design §2), and the token gate here enforces
 * it mechanically: any verb outside the set is refused before a process spawns.
 */

export const READONLY_VERBS = ["frontier", "node", "audit"] as const;
export type ReadonlyVerb = (typeof READONLY_VERBS)[number];

export class GraphError extends Error {
  override readonly name: string = "GraphError";
}

/**
 * A graph read GitHub refused for rate limiting — the hourly allowance or a
 * secondary (burst/concurrency) limit. Distinct from GraphError so callers
 * can defer instead of failing (src/budget.ts sets a cooldown on it).
 */
export class RateLimitError extends GraphError {
  override readonly name = "RateLimitError";
}

/**
 * The forge-qualified repo `soma graph --repo` needs. Soma resolves a bare
 * `owner/name` only from a checkout with an origin remote, and launchd runs
 * ranger from `/` — every scheduled tick from 2026-09-25 failed on it. Ranger
 * keeps GitHub `map.repo` bare (token prefixes, `gh api repos/…`, journal
 * keys). GitLab refs retain their forge and host at every boundary.
 */
export function somaRepo(repo: string | ForgeRef): string {
  return qualifiedRepo(typeof repo === "string" ? parseForgeRef(repo) : repo);
}

const RATE_LIMITED = /rate limit/i;

/** The error for a failed graph verb: RateLimitError when GitHub throttled it. */
export function graphFailure(
  message: string,
  stderr: string,
): GraphError {
  return RATE_LIMITED.test(stderr)
    ? new RateLimitError(message)
    : new GraphError(message);
}

export interface FrontierEntryNode {
  id: string;
  title: string;
  kind: string;
  autonomy: string;
  checkpointId?: string;
  probes?: { type: string; [key: string]: unknown }[];
}

export interface FrontierEntry {
  ref: { id: string };
  node: FrontierEntryNode;
  status: string;
  assignees: string[];
  blockedBy: { id: string; status: string }[];
  author: string;
  url: string;
  typed: boolean;
  parent?: { id: string };
  /** Node body (question/prose) — carried at the entry top level by the verb. */
  body?: string;
}

export interface FrontierResult {
  repo: string;
  root: string;
  frontier: FrontierEntry[];
}

export interface AuditResult {
  repo: string;
  root: string;
  nodes: number;
  closedWithoutReceipt: string[];
  openWithoutCheckpoint: string[];
  openClaimed: { id: string; assignees: string[] }[];
}

export interface NodeResult {
  repo: string;
  ref: { id: string };
  node: FrontierEntryNode;
  status: string;
  assignees: string[];
  blockedBy: { id: string; status: string }[];
  author: string;
  url: string;
  typed: boolean;
  parent?: { id: string };
  /** Node body (question/prose) — carried at the node-result top level by the verb. */
  body?: string;
}

function isReadonlyVerb(verb: string): verb is ReadonlyVerb {
  return (READONLY_VERBS as readonly string[]).includes(verb);
}

export interface GraphCallOptions {
  cwd?: string;
  timeoutMs?: number;
}

/** Hard timeout for every graph CLI call (round-29): a hung `soma` subprocess
 *  must not hold the tick past its bound. Generous: the CLI responds in
 *  seconds; this covers slow networks without letting a hang block the pass
 *  bound. Shared by the escalation pass and walk's fresh-read (round-33:
 *  walk.ts's re-fetch was previously unbounded).
 */
export const GRAPH_CALL_TIMEOUT_MS = 60_000;

interface CallGraphArgs {
  verb: ReadonlyVerb;
  root: string;
  repo: string;
  token: ResolvedToken;
  opts?: GraphCallOptions;
}

/**
 * Run one read-only soma graph verb. `GH_TOKEN` is always pinned to the
 * resolved read-only token via the gated env, and the verb is refused unless
 * it is on the fixed read-only surface.
 */
async function callGraph(
  args: CallGraphArgs,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { verb, root, repo, token, opts = {} } = args;
  if (!isReadonlyVerb(verb)) {
    throw new GraphError(
      `refusing non-read-only verb '${verb}' — scout only calls ${READONLY_VERBS.join("/")}`,
    );
  }
  const gated = gatedEnv(token.token);
  try {
    const cliArgs = [
      "graph",
      verb,
      graphNodeId(parseForgeRef(repo), String(root)),
      "--repo",
      somaRepo(repo),
      "--json",
    ];
    return await runReadRetryingTransient("soma", cliArgs, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      env: gated.env,
    });
  } finally {
    gated.cleanup();
  }
}

function parseJson<T>(label: string, stdout: string): T {
  try {
    return JSON.parse(stdout.trim()) as T;
  } catch {
    throw new GraphError(`unparseable JSON from soma graph ${label}`);
  }
}

export async function graphFrontier(
  repo: string,
  root: number,
  token: ResolvedToken,
  opts: GraphCallOptions = {},
): Promise<FrontierResult> {
  const result = await callGraph({
    verb: "frontier",
    root: String(root),
    repo,
    token,
    opts,
  });
  if (result.code !== 0) {
    throw graphFailure(
      `soma graph frontier ${root} (${repo}) failed (exit ${result.code}): ${result.stderr.trim()}`,
      result.stderr,
    );
  }
  return normalizeFrontier(repo, parseJson<FrontierResult>("frontier", result.stdout));
}

export async function graphAudit(
  repo: string,
  root: number,
  token: ResolvedToken,
  opts: GraphCallOptions = {},
): Promise<AuditResult> {
  const result = await callGraph({
    verb: "audit",
    root: String(root),
    repo,
    token,
    opts,
  });
  if (result.code !== 0) {
    throw graphFailure(
      `soma graph audit ${root} (${repo}) failed (exit ${result.code}): ${result.stderr.trim()}`,
      result.stderr,
    );
  }
  return normalizeAudit(repo, parseJson<AuditResult>("audit", result.stdout));
}

export async function graphNode(
  repo: string,
  id: string,
  token: ResolvedToken,
  opts: GraphCallOptions = {},
): Promise<NodeResult> {
  const result = await callGraph({ verb: "node", root: id, repo, token, opts });
  if (result.code !== 0) {
    throw graphFailure(
      `soma graph node ${id} (${repo}) failed (exit ${result.code}): ${result.stderr.trim()}`,
      result.stderr,
    );
  }
  return normalizeGraphNode(repo, parseJson<NodeResult>("node", result.stdout));
}

/** Normalize every graph id before it reaches routing, journal or commands. */
export function normalizeGraphNode<T extends NodeResult | FrontierEntry>(repo: string, node: T): T {
  const ref = parseForgeRef(repo);
  const id = (value: string) => graphNodeId(ref, value);
  try {
    return {
      ...node,
      ref: { ...node.ref, id: id(node.ref.id) },
      node: { ...node.node, id: id(node.node.id) },
      blockedBy: node.blockedBy.map(n => ({ ...n, id: id(n.id) })),
      ...(node.parent === undefined ? {} : { parent: { ...node.parent, id: id(node.parent.id) } }),
    };
  } catch (error) { throw new GraphError((error as Error).message); }
}

export function normalizeFrontier(repo: string, result: FrontierResult): FrontierResult {
  return {
    ...result,
    root: graphNodeId(parseForgeRef(repo), result.root),
    frontier: result.frontier.map(node => normalizeGraphNode(repo, node)),
  };
}

export function normalizeAudit(repo: string, result: AuditResult): AuditResult {
  const ref = parseForgeRef(repo);
  const id = (value: string) => graphNodeId(ref, value);
  return {
    ...result, root: id(result.root),
    closedWithoutReceipt: result.closedWithoutReceipt.map(id),
    openWithoutCheckpoint: result.openWithoutCheckpoint.map(id),
    openClaimed: result.openClaimed.map(n => ({ ...n, id: id(n.id) })),
  };
}

function graphNodeId(ref: ForgeRef, value: string): string {
  try { return normalizeNodeId(ref, value); }
  catch (error) { throw new GraphError((error as Error).message); }
}

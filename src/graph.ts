import { runReadRetryingTransient } from "./transient.ts";
import { gatedEnv, assertGitLabReadGrant, type ResolvedToken } from "./token-gate.ts";
import { glabConfigEnvAsync } from "./glab-config-dir.ts";
import { runCmd } from "./exec.ts";
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
  /** Soma's persisted binding for a gated close. */
  completion?: { closer: string; receiptCommentId: string; closedAt: string };
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
  /**
   * Soma's `build-brief-not-ready` finding (soma#753): open `kind: build`
   * nodes whose body lacks a required section or carries a clarification
   * marker, with the items `missing`. Absent from an older soma — absent
   * refuses nothing.
   */
  buildBriefNotReady?: BuildBriefNotReady[];
}

/** One `buildBriefNotReady` entry: the node and what its brief lacks. */
export interface BuildBriefNotReady {
  id: string;
  missing: string[];
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
  /** Stubbed subprocess seam; GitLab still creates and cleans the real config. */
  runner?: typeof runCmd;
}

/** Hard timeout for every graph CLI call (round-29): a hung `soma` subprocess
 *  must not hold the tick past its bound. Generous: the CLI responds in
 *  seconds; this covers slow networks without letting a hang block the pass
 *  bound. Shared by the escalation pass and walk's fresh-read (round-33:
 *  walk.ts's re-fetch was previously unbounded).
 */
export const GRAPH_CALL_TIMEOUT_MS = 60_000;

async function graphReadBackend(ref: ForgeRef, token: ResolvedToken) {
  if (ref.forge === "gitlab") {
    assertGitLabReadGrant(qualifiedRepo(ref), token);
    return {
      ...await glabConfigEnvAsync(ref.host, token.token),
      runner: runCmd,
      timeoutMs: GRAPH_CALL_TIMEOUT_MS,
    };
  }
  return { ...gatedEnv(token.token), runner: runReadRetryingTransient, timeoutMs: undefined };
}

interface CallGraphArgs {
  verb: ReadonlyVerb;
  root: string;
  repo: string;
  token: ResolvedToken;
  opts?: GraphCallOptions;
}

/**
 * Run one read-only soma graph verb under the forge's isolated credential.
 * GitLab also requires a checked project grant. The verb is refused unless
 * it is on the fixed read-only surface.
 */
export async function callGraph(
  args: CallGraphArgs,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { verb, root, repo, token, opts = {} } = args;
  if (!isReadonlyVerb(verb)) {
    throw new GraphError(
      `refusing non-read-only verb '${verb}' — scout only calls ${READONLY_VERBS.join("/")}`,
    );
  }
  const ref = parseForgeRef(repo);
  const backend = await graphReadBackend(ref, token);
  try {
    const cliArgs = [
      "graph",
      verb,
      graphNodeId(ref, String(root)),
      "--repo",
      somaRepo(ref),
      "--json",
    ];
    const runner = opts.runner ?? backend.runner;
    return await runner("soma", cliArgs, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? backend.timeoutMs,
      env: backend.env,
    });
  } finally {
    await backend.cleanup();
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
  const audit = parseJson<AuditResult>("audit", result.stdout);
  assertBriefShape(audit.buildBriefNotReady);
  return normalizeAudit(repo, audit);
}

/**
 * The finding's shape is soma#753's `[{ id, missing: string[] }]`. Anything
 * else is refused, not adapted to: a malformed finding reads as an audit
 * failure, which holds build nodes (src/frontier-cache.ts), never as "none
 * listed".
 */
function assertBriefShape(value: unknown): void {
  if (value === undefined) return;
  const entryOk = (e: unknown) =>
    typeof e === "object" && e !== null &&
    typeof (e as BuildBriefNotReady).id === "string" &&
    Array.isArray((e as BuildBriefNotReady).missing) &&
    (e as BuildBriefNotReady).missing.every(m => typeof m === "string");
  if (!Array.isArray(value) || !value.every(entryOk)) {
    throw new GraphError("soma graph audit: buildBriefNotReady is not [{ id, missing: string[] }] (soma#753)");
  }
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
  // A foreign dependency is not a local actionable node. Preserve its located
  // identity so routing can still see the blocker without truncating it.
  const relationId = (value: string) => {
    const hash = value.lastIndexOf("#");
    if (hash >= 0 && value.slice(0, hash) !== ref.path) return value;
    return id(value);
  };
  try {
    return {
      ...node,
      ref: { ...node.ref, id: id(node.ref.id) },
      node: { ...node.node, id: id(node.node.id) },
      blockedBy: node.blockedBy.map(n => ({ ...n, id: relationId(n.id) })),
      ...(node.parent === undefined ? {} : { parent: { ...node.parent, id: relationId(node.parent.id) } }),
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
    ...(result.buildBriefNotReady === undefined
      ? {}
      : { buildBriefNotReady: result.buildBriefNotReady.map(n => ({ ...n, id: id(n.id) })) }),
  };
}

function graphNodeId(ref: ForgeRef, value: string): string {
  try { return normalizeNodeId(ref, value); }
  catch (error) { throw new GraphError((error as Error).message); }
}

import { join } from "node:path";
import { graphReadToken, laneCredentialRefusal, type ReadGate } from "./forge-lanes.ts";
import type { ResolvedToken } from "./token-gate.ts";
import { budgetPolicy } from "./budget.ts";
import { ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import { principalLoginForRepo, type RangerConfig, type RangerMapConfig } from "./config.ts";
import { cachedRootAuthor } from "./root-author.ts";
import { readFrontier } from "./frontier-cache.ts";
import { type BriefAudit, type FrontierEntry, GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import type { OwnedCheck } from "./lock.ts";
import { implementLane } from "./lanes.ts";
import { laneHeldMessage } from "./maps.ts";
import {
 briefHoldReason,
 classifyFrontier,
 ESCALATE_REASONS,
 loadProbeRegistry,
 type ClassifiedNode,
 type ProbeRegistry,
} from "./route.ts";
import {
 claimNode,
 type AnnounceFn,
 type ClaimFn,
} from "./walk.ts";
import type { SpawnRunNodeArgs } from "./spawn.ts";

/**
 * `ranger build-now <id>` (node #58) — the walk's claim for one chosen node,
 * started now. It reads the map's frontier and classifies it exactly as the
 * walk does (`classifyFrontier`, `readFrontier`), then hands the node to the
 * walk's own `claimNode`: announce, claim under the bot identity, the spawn
 * count, the fresh `claimed` row and event, and a detached `run-node`.
 *
 * It refuses everything the walk would not take, before any announce or
 * claim: a paused run, a node off the frontier, one that does not route to
 * the implement or research lane as walkable (HITL, provisioning, skip-listed,
 * off the allowlist, a `propose` node authored by the bot — node #9, a build
 * node whose brief soma's audit reports not ready — node #154), a vetoed node, one
 * already in flight, an exhausted daily spawn cap, and, without `--force`, a
 * held implement lane. With `--force` it starts beside the holder; nothing
 * forces a HITL node.
 *
 * The announce is best-effort here: the principal chose this node, so a
 * Discord failure is reported (stdout and the `claimed` event) rather than
 * blocking the claim the way it blocks the walk.
 *
 * Everything from the pause gate to the spawn runs under the claim lock
 * (`claim-lock.ts`), the one the walk holds over a map's claim phase, so a
 * build-now and a walk tick, or two build-nows, never claim on the same gate
 * reads. A build-now does not queue behind the walk: when the lock stays
 * held past a short wait, it refuses, and the principal tries again.
 */

/** The CLI's exit code for a claim whose run-node did not start (the dashboard reads it). */
export const BUILD_NOW_NOT_STARTED = 3;

/** How long build-now waits for the claim lock before it refuses. */
export const BUILD_NOW_LOCK_WAIT_MS = 10_000;

export class BuildNowRefusal extends Error {
 override readonly name = "BuildNowRefusal";
}

export interface BuildNowContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 map: RangerMapConfig;
 /** The machine account's write token and login (the caller gates the principal). */
 token: string;
 botIdentity: string;
 /** The credential the map's graph reads run under; `buildNow` resolves it (`graphReadToken`) when unset. */
 graphToken?: ResolvedToken;
 /** The read gate a GitLab map's graph reads run under (tests inject a fake). */
 readGate?: ReadGate;
 force?: boolean;
 /** The map's frontier and its audit's brief finding: the walk's sentinel-checked read unless injected. */
 readFrontier?: () => Promise<{ frontier: FrontierEntry[]; briefs?: BriefAudit }>;
 registry?: ProbeRegistry;
 announce?: AnnounceFn;
 claim?: ClaimFn;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
 /** How long to wait for the claim lock before refusing (default BUILD_NOW_LOCK_WAIT_MS). */
 lockWaitMs?: number;
}

export interface BuildNowResult {
 nodeId: string;
 repo: string;
 root: number;
 title: string;
 lane: "implement" | "research";
 /** The implement worker this one runs beside (`--force`), if any. */
 beside: { nodeId: string; repo: string; root: number; status: WorkerRow["status"] } | null;
 messageId: string | null;
 announceError: string | null;
 /** The run-node's PID; null when none was spawned (the row stays `claimed`, no worker). */
 pid: number | null;
}

const IN_FLIGHT = new Set<WorkerRow["status"]>(["claimed", "running", "awaiting-merge", "proposed"]);

/** Why a classified node is not one the walk takes, or null when it is. */
function notWalkable(node: ClassifiedNode): string | null {
 const route = node.route;
 if (route.route === "escalate-hitl") {
  return `routes escalate-hitl: ${ESCALATE_REASONS[route.reason]} — a HITL node is never forced`;
 }
 if (route.route === "provisioning") {
  return "routes provisioning: its probes are not in the probe registry";
 }
 if (route.route === "brief-not-ready") return `routes brief-not-ready: ${briefHoldReason(route.missing)}`;
 if (route.route === "proposal") return "is proposed — it waits for the principal's 👍 on its proposal comment";
 if (route.route === "refused") return "was refused — the principal 👎'd ranger's proposal, so ranger never takes it";
 if (!route.walkable) {
  return `routes ${route.route} but is not walkable on this map (walk mode, nodes allowlist or skip list)`;
 }
 return null;
}

export async function buildNow(nodeId: string, ctx: BuildNowContext): Promise<BuildNowResult> {
 const refusal = laneCredentialRefusal(ctx.config, ctx.map.repo);
 if (refusal !== null) throw new BuildNowRefusal(refusal);
 if (ctx.readFrontier === undefined && ctx.graphToken === undefined) {
  ctx = { ...ctx, graphToken: await graphReadToken(ctx.config, ctx.map.repo, ctx.token, ctx.readGate) };
 }
 // The audit (minutes on a large map) runs before the claim lock, as in the
 // walk; the locked read serves it and holds a build node edited in between.
 if (ctx.readFrontier === undefined && !ctx.journal.isPaused()) {
  try {
   await readFrontier({ ...frontierArgs(ctx), audit: "refresh" });
  } catch {
   // The locked read meets the same deferral or failure and refuses with it.
  }
 }
 try {
  return await withClaimLock(ctx.journal, (owned) => buildUnderLock(nodeId, ctx, owned), ctx.lockWaitMs ?? BUILD_NOW_LOCK_WAIT_MS);
 } catch (error) {
  if (error instanceof ClaimLockBusy) {
   throw new BuildNowRefusal(`#${nodeId} on ${ctx.map.repo}#${ctx.map.root}: ${error.message} — another claim (a walk tick or a build-now) is running; try again`);
  }
  throw error;
 }
}

/** The map's frontier read, as the walk takes it. */
function frontierArgs(ctx: BuildNowContext) {
 return {
  journal: ctx.journal,
  repo: ctx.map.repo,
  root: ctx.map.root,
  token: ctx.graphToken ?? { token: ctx.token, source: "write-token" },
  policy: budgetPolicy(ctx.config),
  maxAgeMs: ctx.config.budget.frontierMaxAgeMin * 60_000,
  now: ctx.now?.() ?? new Date(),
  timeoutMs: GRAPH_CALL_TIMEOUT_MS,
 };
}

async function buildUnderLock(nodeId: string, ctx: BuildNowContext, owned: OwnedCheck): Promise<BuildNowResult> {
 const { config, journal, map } = ctx;
 const now = () => ctx.now?.() ?? new Date();
 const refuse = (why: string): never => {
  throw new BuildNowRefusal(`#${nodeId} on ${map.repo}#${map.root}: ${why}`);
 };

 // Dead-man gate (design §7): the walk claims nothing while paused, nor does this.
 if (journal.isPaused()) refuse("dead-man paused — claiming stopped; `ranger resume-run` first");

 const { frontier: entries, briefs } = await (ctx.readFrontier ??
  (async () => {
   const read = await readFrontier({ ...frontierArgs(ctx), audit: "never" });
   return { frontier: read.frontier.frontier, briefs: read.briefs };
  }))();
 // The walk keeps the root's author (node #246, D6); build-now reads only that.
 const classified = classifyFrontier(entries, map, ctx.registry ?? loadProbeRegistry(), ctx.botIdentity, briefs, {
  principal: principalLoginForRepo(config, map.repo),
  rootAuthor: cachedRootAuthor(journal, map.repo, map.root),
 });
 const node = classified.find((n) => n.id === nodeId);
 if (node === undefined) refuse("not on the map's frontier (closed, blocked, or not under this root)");
 const why = notWalkable(node!);
 if (why !== null) refuse(why);
 const lane = node!.route.route as "implement" | "research";

 if (journal.hasVeto(nodeId, map.repo)) refuse("vetoed — the walk never claims a vetoed node");
 const row = journal.getWorker(nodeId, map.repo);
 if (row !== null && IN_FLIGHT.has(row.status)) {
  refuse(`already in flight (${row.status}) — \`ranger resume-node\` puts a stuck worker back in motion`);
 }
 try {
  journal.assertWorkerRoot(nodeId, map.repo, map.root);
 } catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
 }
 const spawns = journal.spawnsToday(now());
 if (spawns >= config.workers.spawnCapPerDay) {
  refuse(`the daily spawn cap is spent (${spawns}/${config.workers.spawnCapPerDay})`);
 }
 // Only the implement lane is serial; research never holds it.
 const holder =
  lane === "implement" ? journal.laneHolder(implementLane(map), { nodeId, repo: map.repo }) : null;
 if (holder !== null && ctx.force !== true) {
  refuse(laneHeldMessage(implementLane(map), holder, "build", nodeId));
 }

 const outcome = await claimNode({
  journal,
  map,
  node: node!,
  lane,
  botIdentity: ctx.botIdentity,
  token: ctx.token,
  cliEntry: join(import.meta.dir, "cli.ts"),
  configPath: ctx.configPath,
  announceRequired: false,
  announce: ctx.announce,
  claim: ctx.claim,
  spawnRunNode: ctx.spawnRunNode,
  now: ctx.now,
  owned,
 });
 // A lost race is reported, never retried: someone else holds the node now.
 if (!outcome.claimed) throw new BuildNowRefusal(outcome.error);
 return {
  nodeId,
  repo: map.repo,
  root: map.root,
  title: node!.title,
  lane,
  beside:
   holder === null
    ? null
    : { nodeId: holder.nodeId, repo: holder.repo, root: holder.root, status: holder.status },
  messageId: outcome.messageId,
  announceError: outcome.announceError,
  pid: outcome.pid,
 };
}

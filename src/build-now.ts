import { join } from "node:path";
import { budgetPolicy } from "./budget.ts";
import { ClaimLeaseLost, ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { readFrontier } from "./frontier-cache.ts";
import { type FrontierEntry, GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { implementLane } from "./lanes.ts";
import { laneHeldMessage } from "./maps.ts";
import {
 classifyFrontier,
 ESCALATE_REASONS,
 loadProbeRegistry,
 type ClassifiedNode,
 type ProbeRegistry,
} from "./route.ts";
import {
 claimAdmission,
 claimNode,
 type AnnounceFn,
 type ClaimFn,
 type SpawnRunNodeArgs,
} from "./walk.ts";

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
 * off the allowlist, authored by the bot — node #9), a vetoed node, one
 * already in flight, an exhausted daily spawn cap, and, without `--force`, a
 * held implement lane. With `--force` it starts beside the holder; nothing
 * forces a HITL node.
 *
 * The announce is best-effort here: the principal chose this node, so a
 * Discord failure is reported (stdout and the `claimed` event) rather than
 * blocking the claim the way it blocks the walk.
 */

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
 force?: boolean;
 /** The map's frontier: the walk's sentinel-checked read unless injected. */
 readFrontier?: () => Promise<FrontierEntry[]>;
 registry?: ProbeRegistry;
 announce?: AnnounceFn;
 claim?: ClaimFn;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
 /** How long to wait for another claim to finish (BUILD_NOW_LOCK_WAIT_MS unless injected). */
 claimLockWaitMs?: number;
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
 pid: number | null;
}

/** Why a classified node is not one the walk takes, or null when it is. */
function notWalkable(node: ClassifiedNode): string | null {
 const route = node.route;
 if (route.route === "escalate-hitl") {
  return `routes escalate-hitl: ${ESCALATE_REASONS[route.reason]} — a HITL node is never forced`;
 }
 if (route.route === "provisioning") {
  return "routes provisioning: its probes are not in the probe registry";
 }
 if (!route.walkable) {
  return `routes ${route.route} but is not walkable on this map (walk mode, nodes allowlist or skip list)`;
 }
 return null;
}

/**
 * How long build-now waits for another claim (the walk takes the same lock).
 * Short, unlike the walk: the dashboard bounds the whole verb (serve.ts
 * BUILD_NOW_TIMEOUT_MS), and a principal can simply press again.
 */
export const BUILD_NOW_LOCK_WAIT_MS = 30_000;

export async function buildNow(nodeId: string, ctx: BuildNowContext): Promise<BuildNowResult> {
 const { config, journal, map } = ctx;
 const now = () => ctx.now?.() ?? new Date();
 const refuse = (why: string): never => {
  throw new BuildNowRefusal(`#${nodeId} on ${map.repo}#${map.root}: ${why}`);
 };

 // Cheap first look at the dead-man gate, before any network read; the
 // authoritative check is the one under the claim lock below.
 if (journal.isPaused()) refuse("dead-man paused — claiming stopped; `ranger resume-run` first");

 const entries = await (ctx.readFrontier ??
  (async () =>
   (
    await readFrontier({
     journal,
     repo: map.repo,
     root: map.root,
     token: { token: ctx.token, source: "write-token" },
     policy: budgetPolicy(config),
     maxAgeMs: config.budget.frontierMaxAgeMin * 60_000,
     now: now(),
     timeoutMs: GRAPH_CALL_TIMEOUT_MS,
    })
   ).frontier.frontier))();
 const classified = classifyFrontier(entries, map, ctx.registry ?? loadProbeRegistry(), ctx.botIdentity);
 const node = classified.find((n) => n.id === nodeId);
 if (node === undefined) refuse("not on the map's frontier (closed, blocked, or not under this root)");
 const why = notWalkable(node!);
 if (why !== null) refuse(why);
 const lane = node!.route.route as "implement" | "research";

 // Every gate below is re-read under the claim lock the walk also takes, and
 // held through the claimed row and the spawn count: two concurrent claims
 // (a second build-now, or the tick) cannot both pass the same gate.
 const claimed = withClaimLock(journal, async (owned) => {
  const { refusal, laneHolder: holder } = claimAdmission(
   journal,
   map,
   nodeId,
   lane,
   config.workers.spawnCapPerDay,
   now(),
  );
  switch (refusal?.gate) {
   // Dead-man gate (design §7): the walk claims nothing while paused, nor does this.
   case "paused":
    return refuse("dead-man paused — claiming stopped; `ranger resume-run` first");
   case "vetoed":
    return refuse("vetoed — the walk never claims a vetoed node");
   case "cap":
    return refuse(`the daily spawn cap is spent (${refusal.spawns}/${refusal.cap})`);
   case "in-flight":
    return refuse(
     `already in flight (${refusal.status}) — \`ranger resume-node\` puts a stuck worker back in motion`,
    );
   case "root":
    return refuse(refusal.message);
  }
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
  return { outcome, holder };
 }, ctx.claimLockWaitMs ?? BUILD_NOW_LOCK_WAIT_MS).catch((error: unknown) => {
  if (error instanceof ClaimLeaseLost) {
   // Stopped at the fence: another claimer holds the lock now, and may be
   // claiming this very node. Whatever this run wrote before the fence is in
   // the journal and on the page; nothing after it was.
   return refuse(`stopped mid-claim — ${error.message}; check the page before pressing again`);
  }
  if (!(error instanceof ClaimLockBusy)) throw error;
  return refuse(`another claim is in progress (the tick or a second build-now) — press again: ${error.message}`);
 });
 const { outcome, holder } = await claimed;
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

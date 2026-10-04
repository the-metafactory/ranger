import { implementLane, type ImplementLane } from "./lanes.ts";
import { lastImplementMaps, recordImplementStart, mapKey, implementMapOrder } from "./maps.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig, WalkMode } from "./config.ts";
import { DiscordAnnouncer, type AnnounceContext, type AnnounceResult } from "./announce.ts";
import { BudgetDeferral, budgetPolicy } from "./budget.ts";
import { readFrontier } from "./frontier-cache.ts";
import { GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import { graphClaim, type ClaimResult } from "./graph-write.ts";
import {
 assertNotPrincipal,
 resolveBotIdentity,
 resolveWriteToken,
 WriteGateError,
} from "./identity.ts";
import { ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { classifyFrontier, loadProbeRegistry } from "./route.ts";
import { sweepMap, type SweepMapResult } from "./sweep.ts";
import {
 implementCandidates,
 planTick,
 researchCandidates,
 selectCandidates,
} from "./candidates.ts";

// Re-exported where they were: the candidate selection moved to a module with
// no graph-write import, so `ranger serve` (#37) can share it (one copy).
export { implementCandidates, planTick, researchCandidates, selectCandidates };

/**
 * The headless tick (design §1, build-path step 3) — one bounded pass:
 *
 * per map → gate (write token + not-principal + walk mode + pause state) →
 * derive + classify frontier → research-lane candidates → announce (fail-closed)
 * → claim (race-safe) → spawn a detached `ranger run-node` → then sweep.
 *
 * Stateless over the graph: everything topological is re-derived per pass.
 */

export interface WalkMapResult {
 repo: string;
 walkMode: WalkMode;
 /** False when the map could not be walked (gate, token, pause). */
 gated: boolean;
 gateReason?: string;
 announced: string[];
 claimed: string[];
 spawnCapExhausted: boolean;
 paused: boolean;
 errors: string[];
 sweep?: SweepMapResult;
}

export interface WalkResult {
 maps: WalkMapResult[];
 spawnCapPerDay: number;
}

export interface SpawnRunNodeArgs {
 nodeId: string;
 repo: string;
 root: number;
 cliEntry: string;
 configPath: string;
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
  [
   args.cliEntry,
   "run-node",
   args.nodeId,
   "--map",
   mapKey(args),
   "--config",
   args.configPath,
  ],
  {
   detached: true,
   stdio: "ignore",
   env: process.env,
  },
 );
 child.unref();
 return child.pid ?? null;
}

export interface WalkContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 /** Detached run-node spawner — tests inject a recorder. Returns the child PID or null. */
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
}

/** A row in one of these states is a node already being worked: never claimed again. */
export const IN_FLIGHT_STATUSES: ReadonlySet<WorkerRow["status"]> = new Set([
 "claimed",
 "running",
 "awaiting-merge",
]);

/** Is this resource lane held? (awaiting-merge does not hold it.) */
export function implementLaneBusy(journal: Journal, lane: ImplementLane): boolean {
 return journal.laneHolder(lane) !== null;
}

/** Post a claim announce on the map's Discord channel (the walk's one path). */
export type AnnounceFn = (map: RangerMapConfig, ctx: AnnounceContext) => Promise<AnnounceResult>;
export const discordAnnounce: AnnounceFn = (map, ctx) => DiscordAnnouncer.fromMap(map).announce(ctx);

/** Claim one node under the bot identity (`graphClaim`'s shape, injectable). */
export type ClaimFn = (
 repo: string,
 id: string,
 identity: string,
 token: string,
 opts: { timeoutMs: number },
) => Promise<ClaimResult>;

export interface ClaimNodeArgs {
 journal: Journal;
 map: RangerMapConfig;
 node: { id: string; title: string };
 lane: "implement" | "research";
 botIdentity: string;
 token: string;
 cliEntry: string;
 configPath: string;
 /**
  * The walk refuses a claim it could not announce (node #7: announce gates
  * the claim). `ranger build-now` (node #58) is the principal's own hand
  * and claims anyway, with the announce error in the `claimed` event.
  */
 announceRequired?: boolean;
 announce?: AnnounceFn;
 claim?: ClaimFn;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
}

export type ClaimNodeOutcome =
 | { claimed: true; messageId: string | null; announceError: string | null; pid: number | null }
 | {
    claimed: false;
    messageId: string | null;
    error: string;
    /** The race winner when the claim was lost; absent when the announce refused it. */
    holder?: string | null;
   };

/**
 * One node from announce to a running worker: announce → `announced` event →
 * claim (race-safe) → spawn count → a fresh `claimed` row → detached
 * run-node → `claimed` event. The walk and `ranger build-now` (node #58)
 * both call this; each checks its own gates (pause, cap, veto, lane) first.
 */
export async function claimNode(args: ClaimNodeArgs): Promise<ClaimNodeOutcome> {
 const { journal, map, node, botIdentity, token } = args;
 const now = () => args.now?.() ?? new Date();
 // Announce, fail-closed in the walk (node #7: no veto window, but announce gates the claim).
 let messageId: string | null = null;
 let announceError: string | null = null;
 try {
  const announced = await (args.announce ?? discordAnnounce)(map, {
   repo: map.repo,
   root: map.root,
   nodeId: node.id,
   nodeTitle: node.title,
  });
  messageId = announced.messageId;
 } catch (error) {
  announceError = error instanceof Error ? error.message : String(error);
  if (args.announceRequired !== false) {
   return {
    claimed: false,
    messageId: null,
    error: `#${node.id} announce failed (${announceError}) — claim refused`,
   };
  }
 }
 if (messageId !== null) {
  journal.recordEvent("announced", {
   nodeId: node.id,
   repo: map.repo,
   detail: messageId,
  });
 }

 const claim = await (args.claim ?? graphClaim)(map.repo, node.id, botIdentity, token, {
  // Every graph CLI call is timeout-bound — a hung claim must not hold
  // the scheduled tick (round-35: walk's write-side calls were the last
  // unbounded surface).
  timeoutMs: GRAPH_CALL_TIMEOUT_MS,
 });
 if (!claim.held) {
  return {
   claimed: false,
   messageId,
   holder: claim.holder ?? null,
   error: `#${node.id} claim race lost to ${claim.holder ?? "another session"} — skipped`,
  };
 }
 if (args.lane === "implement") recordImplementStart(journal, map);
 journal.recordSpawn(now());
 // A fresh claim starts a clean row BEFORE the supervisor spawns: a node
 // re-claimed after an earlier park must not inherit that attempt's
 // phase, PR or review record (the implement lane re-derives them from
 // GitHub anyway, F2), and the spawned run-node must find its row to take
 // a generation. The PID is patched in after the spawn; a row with no
 // observed PID is left alone by the sweep, never flagged crashed.
 journal.upsertWorker({
  nodeId: node.id,
  repo: map.repo,
  root: map.root,
  status: "claimed",
  attempts: 0,
  pid: null,
  messageId,
  lane: args.lane,
  workerPgid: null,
  phase: null,
  prNumber: null,
  reviewRound: 0,
  verdictSha: null,
  verdictBlockers: null,
  mergeMessageId: null,
  outcome: null,
  finishedAt: null,
  substrate: null,
 });
 const pid = await (args.spawnRunNode ?? spawnRunNodeDetached)({
  nodeId: node.id,
  repo: map.repo,
  root: map.root,
  cliEntry: args.cliEntry,
  configPath: args.configPath,
 });
 if (pid !== null) journal.updateWorker(node.id, map.repo, { pid });
 journal.recordEvent("claimed", {
  nodeId: node.id,
  repo: map.repo,
  detail: `by ${botIdentity}${announceError === null ? "" : ` (announce failed: ${announceError})`}`,
 });
 return { claimed: true, messageId, announceError, pid };
}

export async function walk(ctx: WalkContext): Promise<WalkResult> {
 const { config, journal } = ctx;
 const registry = loadProbeRegistry();
 const result: WalkResult = {
  maps: [],
  spawnCapPerDay: config.workers.spawnCapPerDay,
 };
 const cliEntry = join(import.meta.dir, "cli.ts");
 // Even a worker finishing during this tick must not allow a second claim
 // across maps: at most one new implement claim per resource lane per tick.
 const implementClaimed = new Set<ImplementLane>();

 for (const map of implementMapOrder(config.maps, lastImplementMaps(journal), implementLane)) {
  const mapResult: WalkMapResult = {
   repo: map.repo,
   walkMode: map.walk,
   gated: false,
   announced: [],
   claimed: [],
   spawnCapExhausted: false,
   paused: journal.isPaused(),
   errors: [],
  };

  // Walk-mode gate (node #9): `none` registers the map, nothing more.
  if (map.walk === "none") {
   mapResult.gated = true;
   mapResult.gateReason = "walk: none — this map is registered, not walked";
   result.maps.push(mapResult);
   continue;
  }

  // Credential gate (node #11 + design §2).
  let token: string;
  let botIdentity: string;
  try {
   const credential = resolveWriteToken(config, map.repo);
   token = credential.token;
   botIdentity = await resolveBotIdentity(config, token);
   assertNotPrincipal(config, botIdentity);
  } catch (error) {
   mapResult.gated = true;
   mapResult.gateReason =
    error instanceof WriteGateError ? error.message : String(error);
   result.maps.push(mapResult);
   continue;
  }

  // Dead-man gate (design §7): paused ⇒ read-only pass (sweep still runs).
  if (journal.isPaused()) {
   mapResult.gated = true;
   mapResult.gateReason =
    "dead-man paused — claiming stopped; human resume-run required";
  }

  const errors: string[] = [];
  if (!mapResult.gated) {
   try {
    // walk MUST classify from a frontier no older than the repo is NOW:
    // reusing the escalation pass's read (up to ~120s old) unchecked could
    // misroute claims — a node edited to HITL in that window would still be
    // announced+claimed as auto+research (round-29 review). readFrontier
    // re-reads the repo's sentinel here and serves the cached read only when
    // nothing changed since it was taken, so round-29 holds without paying
    // GraphQL for an unchanged map (src/frontier-cache.ts).
    const { frontier: fetched } = await readFrontier({
     journal,
     repo: map.repo,
     root: map.root,
     token: { token, source: "write-token" },
     policy: budgetPolicy(config),
     maxAgeMs: config.budget.frontierMaxAgeMin * 60_000,
     now: ctx.now?.() ?? new Date(),
     timeoutMs: GRAPH_CALL_TIMEOUT_MS,
    });
    const frontierEntries = fetched.frontier;
    const classified = classifyFrontier(frontierEntries, map, registry, botIdentity);
    // The plan `ranger serve` (#37) also reads, so its "next" is this order.
    const plan = planTick(classified, {
     laneBusy: implementClaimed.has(implementLane(map)) || implementLaneBusy(journal, implementLane(map)),
     vetoed: (id) => journal.hasVeto(id),
    });
    const candidates = plan.selected;
    const laneOf = (id: string) =>
     plan.implement.some((n) => n.id === id) ? "implement" : "research";

    for (const node of candidates) {
     // Veto cache: a vetoed node is never claimed (design §5, journal durability).
     if (plan.vetoed.includes(node)) {
      errors.push(`#${node.id} vetoed — not claimed`);
      continue;
     }
     // The gates are re-read under the claim lock `ranger build-now` also
     // takes (node #58), held through the claimed row and the spawn count:
     // a build-now running beside this tick cannot pass the same gate.
     let step: "claimed" | "skipped" | "cap";
     try {
      step = await withClaimLock(journal, async () => {
       if (
        journal.spawnsToday(ctx.now?.() ?? new Date()) >=
        config.workers.spawnCapPerDay
       ) {
        return "cap";
       }
       const row = journal.getWorker(node.id, map.repo);
       if (row !== null && IN_FLIGHT_STATUSES.has(row.status)) {
        errors.push(`#${node.id} already in flight (${row.status}) — not claimed`);
        return "skipped";
       }
       if (laneOf(node.id) === "implement" && implementLaneBusy(journal, implementLane(map))) {
        errors.push(`#${node.id} implement lane taken since the plan — not claimed`);
        return "skipped";
       }
       try {
        journal.assertWorkerRoot(node.id, map.repo, map.root);
       } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return "skipped";
       }

       const outcome = await claimNode({
        journal,
        map,
        node,
        lane: laneOf(node.id),
        botIdentity,
        token,
        cliEntry,
        configPath: ctx.configPath,
        spawnRunNode: ctx.spawnRunNode,
        now: ctx.now,
       });
       if (outcome.messageId !== null) mapResult.announced.push(node.id);
       if (!outcome.claimed) {
        errors.push(outcome.error);
        return "skipped";
       }
       return "claimed";
      });
     } catch (error) {
      if (!(error instanceof ClaimLockBusy)) throw error;
      errors.push(`#${node.id} not claimed: ${error.message}`);
      break;
     }
     if (step === "cap") {
      mapResult.spawnCapExhausted = true;
      break;
     }
     if (step === "skipped") continue;
     mapResult.claimed.push(node.id);
     if (laneOf(node.id) === "implement") implementClaimed.add(implementLane(map));
    }
   } catch (error) {
    if (error instanceof BudgetDeferral) {
     // Not an error: nothing was read, so nothing was claimed. The next
     // tick with budget walks the map (src/budget.ts).
     mapResult.gated = true;
     mapResult.gateReason = error.message;
    } else {
     errors.push(error instanceof Error ? error.message : String(error));
    }
   }
  }

  mapResult.errors = errors;
  // Sweep always runs for a walked map (even paused — liveness/audit surface).
  try {
   mapResult.sweep = await sweepMap({
    config,
    journal,
    map,
    token,
    botIdentity,
    respawn: (nodeId, repo, root) =>
     (ctx.spawnRunNode ?? spawnRunNodeDetached)({
      nodeId,
      repo,
      root,
      cliEntry,
      configPath: ctx.configPath,
     }),
   });
  } catch (error) {
   errors.push(
    `sweep failed: ${error instanceof Error ? error.message : String(error)}`,
   );
  }

  result.maps.push(mapResult);
 }

 return result;
}

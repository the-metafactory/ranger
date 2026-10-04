import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig, WalkMode } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import { BudgetDeferral, budgetPolicy } from "./budget.ts";
import { readFrontier } from "./frontier-cache.ts";
import { GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import { graphClaim } from "./graph-write.ts";
import {
 assertNotPrincipal,
 resolveBotIdentity,
 resolveWriteToken,
 WriteGateError,
} from "./identity.ts";
import type { Journal } from "./journal.ts";
import { implementLane, type ImplementLane } from "./lanes.ts";
import { classify, loadProbeRegistry, type ClassifiedNode } from "./route.ts";
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
   args.repo,
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

/** Is this resource lane held? (awaiting-merge does not hold it.) */
export function implementLaneBusy(journal: Journal, lane: ImplementLane): boolean {
 return journal.laneHolder(lane) !== null;
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
 // in the same lane: at most one new implement claim per lane per tick.
 const claimedLanes = new Set<ImplementLane>();

 for (const map of config.maps) {
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
    const classified = frontierEntries.map((entry) =>
     classify(entry, map.repo, map.walk, registry, {
      botIdentity,
      allowlist: map.nodes,
      skip: map.skip,
     }),
    );
    // The plan `ranger serve` (#37) also reads, so its "next" is this order.
    const plan = planTick(classified, {
     laneBusy: claimedLanes.has(implementLane(map)) || implementLaneBusy(journal, implementLane(map)),
     vetoed: (id) => journal.hasVeto(id),
    });
    const candidates = plan.selected;
    const laneOf = (id: string) =>
     plan.implement.some((n) => n.id === id) ? "implement" : "research";

    for (const node of candidates) {
     if (
      journal.spawnsToday(ctx.now?.() ?? new Date()) >=
      config.workers.spawnCapPerDay
     ) {
      mapResult.spawnCapExhausted = true;
      break;
     }
     // Veto cache: a vetoed node is never claimed (design §5, journal durability).
     if (plan.vetoed.includes(node)) {
      errors.push(`#${node.id} vetoed — not claimed`);
      continue;
     }

     // Announce, fail-closed (node #7: no veto window, but announce gates the claim).
     let messageId: string;
     try {
      const announcer = DiscordAnnouncer.fromMap(map);
      const announced = await announcer.announce({
       repo: map.repo,
       nodeId: node.id,
       nodeTitle: node.title,
      });
      messageId = announced.messageId;
     } catch (error) {
      errors.push(
       `#${node.id} announce failed (${error instanceof Error ? error.message : String(error)}) — claim refused`,
      );
      continue;
     }
     mapResult.announced.push(node.id);
     journal.recordEvent("announced", {
      nodeId: node.id,
      repo: map.repo,
      detail: messageId,
     });

     const claim = await graphClaim(map.repo, node.id, botIdentity, token, {
      // Every graph CLI call is timeout-bound — a hung claim must not hold
      // the scheduled tick (round-35: walk's write-side calls were the last
      // unbounded surface).
      timeoutMs: GRAPH_CALL_TIMEOUT_MS,
     });
     if (!claim.held) {
      errors.push(
       `#${node.id} claim race lost to ${claim.holder ?? "another session"} — skipped`,
      );
      continue;
     }
     mapResult.claimed.push(node.id);
     if (laneOf(node.id) === "implement") claimedLanes.add(implementLane(map));
     journal.recordSpawn(ctx.now?.() ?? new Date());
     // A fresh claim starts a clean row BEFORE the supervisor spawns: a node
     // re-claimed after an earlier park must not inherit that attempt's
     // phase, PR or review record (the implement lane re-derives them from
     // GitHub anyway, F2), and the spawned run-node must find its row to take
     // a generation. The PID is patched in after the spawn; a row with no
     // observed PID is left alone by the sweep, never flagged crashed.
     journal.upsertWorker({
      nodeId: node.id,
      repo: map.repo,
      status: "claimed",
      attempts: 0,
      pid: null,
      messageId,
      lane: laneOf(node.id),
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
     const pid = await (ctx.spawnRunNode ?? spawnRunNodeDetached)({
      nodeId: node.id,
      repo: map.repo,
      cliEntry,
      configPath: ctx.configPath,
     });
     if (pid !== null) journal.updateWorker(node.id, { pid });
     journal.recordEvent("claimed", {
      nodeId: node.id,
      repo: map.repo,
      detail: `by ${botIdentity}`,
     });
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
    respawn: (nodeId, repo) =>
     (ctx.spawnRunNode ?? spawnRunNodeDetached)({
      nodeId,
      repo,
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

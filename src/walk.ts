import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig, WalkMode } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import { GRAPH_CALL_TIMEOUT_MS, graphFrontier } from "./graph.ts";
import { graphClaim } from "./graph-write.ts";
import {
 assertNotPrincipal,
 resolveBotIdentity,
 resolveWriteToken,
 WriteGateError,
} from "./identity.ts";
import type { Journal } from "./journal.ts";
import { classify, loadProbeRegistry, type ClassifiedNode } from "./route.ts";
import { sweepMap, type SweepMapResult } from "./sweep.ts";

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

/** Research-lane candidates: routed research AND walkable on this map's walk mode. */
export function researchCandidates(
 frontier: ClassifiedNode[],
): ClassifiedNode[] {
 return frontier.filter(
  (n) => n.route.route === "research" && n.route.walkable,
 );
}

export async function walk(ctx: WalkContext): Promise<WalkResult> {
 const { config, journal } = ctx;
 const registry = loadProbeRegistry();
 const result: WalkResult = {
  maps: [],
  spawnCapPerDay: config.workers.spawnCapPerDay,
 };
 const cliEntry = join(import.meta.dir, "cli.ts");

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
    // walk MUST classify from a FRESH frontier: reusing the escalation pass's
    // read (up to ~120s old) could misroute claims — a node edited to HITL in
    // that window would still be announced+claimed as auto+research
    // (round-29 review supersedes round-28's one-fetch-per-tick suggestion:
    // the second read is a bounded correctness cost, not waste).
    const fetched = await graphFrontier(
     map.repo,
     map.root,
     { token, source: "write-token" },
     { timeoutMs: GRAPH_CALL_TIMEOUT_MS },
    );
    const frontierEntries = fetched.frontier;
    const classified = frontierEntries.map((entry) =>
     classify(entry, map.repo, map.walk, registry),
    );
    const candidates = researchCandidates(classified);

    for (const node of candidates) {
     if (
      journal.spawnsToday(ctx.now?.() ?? new Date()) >=
      config.workers.spawnCapPerDay
     ) {
      mapResult.spawnCapExhausted = true;
      break;
     }
     // Veto cache: a vetoed node is never claimed (design §5, journal durability).
     if (journal.hasVeto(node.id)) {
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

     const claim = await graphClaim(map.repo, node.id, botIdentity, token);
     if (!claim.held) {
      errors.push(
       `#${node.id} claim race lost to ${claim.holder ?? "another session"} — skipped`,
      );
      continue;
     }
     mapResult.claimed.push(node.id);
     journal.recordSpawn(ctx.now?.() ?? new Date());
     // Spawn first so the claim row can carry the supervisor's PID — a row
     // with no observed PID is left alone by the sweep, never flagged crashed.
     const pid = await (ctx.spawnRunNode ?? spawnRunNodeDetached)({
      nodeId: node.id,
      repo: map.repo,
      cliEntry,
      configPath: ctx.configPath,
     });
     journal.upsertWorker({
      nodeId: node.id,
      repo: map.repo,
      status: "claimed",
      attempts: 0,
      pid,
      messageId,
     });
     journal.recordEvent("claimed", {
      nodeId: node.id,
      repo: map.repo,
      detail: `by ${botIdentity}`,
     });
    }
   } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
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
     }).then((pid) => pid !== null),
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

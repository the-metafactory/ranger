import { implementLane, type ImplementLane } from "./lanes.ts";
import { processResumeQueue } from "./resume.ts";
import { graphReadToken, laneCredentialRefusal, lanePort, type ReadGate } from "./forge-lanes.ts";
import { GateError, tokenBatch, type ResolvedToken } from "./token-gate.ts";
import { lastImplementMaps, recordImplementStart, mapKey, implementMapOrder, readDrains } from "./maps.ts";
import { join } from "node:path";
import { spawnRunNodeDetached, type SpawnRunNodeArgs } from "./spawn.ts";
import { principalLoginForRepo, type RangerConfig, type RangerMapConfig, type WalkMode } from "./config.ts";
import { cachedRootAuthor, needsRootAuthor, readRootAuthor } from "./root-author.ts";
import { DiscordAnnouncer, type AnnounceContext, type AnnounceResult } from "./announce.ts";
import { BudgetDeferral, budgetPolicy } from "./budget.ts";
import { readFrontier } from "./frontier-cache.ts";
import { GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import { GraphWriteError, graphClaim, type ClaimResult } from "./graph-write.ts";
import {
 assertWriteIdentity,
 WriteGateError,
} from "./identity.ts";
import type { Journal } from "./journal.ts";
import { ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import type { OwnedCheck } from "./lock.ts";
import { classifyFrontier, loadProbeRegistry } from "./route.ts";
import type { ForgePort } from "./forge.ts";
import { probeRequeueCandidates, requeueProbes, type ProbeRequeueResult } from "./probe-requeue.ts";
import { sweepMap, type SweepMapResult } from "./sweep.ts";
import { intakePass, type IntakeContext, type IntakeResult } from "./intake.ts";
import { gateProposeReads, ratifyPass, rebuildVetoes, type RatifyResult } from "./ratify.ts";
import { refuseProposalCard } from "./card-sync.ts";
import {
 drainGate,
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
 * sweep liveness → priority probe requeues → merge desk and its send-backs
 * → ratify open proposals (node #250; a principal 👎 vetoes, node #240) → queued resumes;
 * then, per map again →
 * pause and drain re-read under the claim lock → derive + classify frontier
 * → vetoes rebuilt from GitHub for propose research nodes (node #240)
 * → research-lane candidates → announce (fail-closed)
 * → claim (race-safe) → spawn a detached `ranger run-node`. Sweeps go first so
 * a send-back takes its implement lane before queued resumes or fresh claims.
 * Last, the intake pass (node #247) drafts a card for each principal
 * @-mention in a map thread, and its gate (node #251) files a draft on the
 * principal's 👍 and discards one on the principal's ❌.
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
 /**
  * Why a drain (node #165) held this map's claims: the visual-lane drain
  * (implement only; research still claims) or this headless map's own.
  */
 drained?: string;
 /** Wall-clock of the soma audit this map's read ran, before the claim lock; absent when none ran. */
 auditMs?: number;
 errors: string[];
 sweep?: SweepMapResult;
}

export interface WalkResult {
 maps: WalkMapResult[];
 spawnCapPerDay: number;
 probeRequeues: ProbeRequeueResult;
 /** The human-observation intake pass (node #247). */
 intake: IntakeResult;
 /** The ratify phase (node #250): proposals read, ratified closes started. */
 ratify: RatifyResult;
}

export interface WalkContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 /** Detached run-node spawner — tests inject a recorder. Returns the child PID or null. */
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
 /** The forge port for every map (tests inject a fake; default: each map's own, `lanePort`). */
 github?: ForgePort;
 /** The read gate a GitLab map's graph reads run under (tests inject a fake; default: `assertReadOnlyToken`). */
 readGate?: ReadGate;
 /** The intake pass's thread client (tests inject one; default: each map's Discord surface). */
 intakeClient?: IntakeContext["clientFor"];
 /** The intake drafter's one-shot `claude -p` runner (tests inject a fake). */
 intakeClaude?: IntakeContext["claude"];
}

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
 /**
  * The claim lock's fence (`withClaimLock`): called before each mutation, it
  * throws `ClaimLeaseLost` once the lease is no longer ours, so a resumed
  * holder stops instead of claiming, writing or spawning beside the new one.
  */
 owned?: OwnedCheck;
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
 * both call this under the claim lock; each checks its own gates (pause, cap,
 * veto, lane) first. A null `pid` means no run-node was spawned: the row stays
 * `claimed` with no worker, and the caller reports that, not a start.
 */
export async function claimNode(args: ClaimNodeArgs): Promise<ClaimNodeOutcome> {
 const { journal, map, node, botIdentity, token } = args;
 const now = () => args.now?.() ?? new Date();
 const owned = args.owned ?? (() => {});
 owned();
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

 owned();
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
 // No await from here to the spawn: the fence covers every write below.
 owned();
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
  proposalCommentId: null,
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
  probeRequeues: { resumed: [], pending: [], errors: [], lanes: [] },
  intake: { threads: [] },
  ratify: { read: [], closing: [], vetoed: [], recovered: [], deferred: [], errors: [] },
 };
 const cliEntry = join(import.meta.dir, "cli.ts");
 // Even a worker finishing during this tick must not allow a second claim
 // across maps: at most one new implement claim per resource lane per tick.
 const implementClaimed = new Set<ImplementLane>();
 // Maps whose credential gate failed on a forge read this tick, not a refusal:
 // a queued resume on such a map defers without counting a failed start.
 const transientGates = new Set<RangerMapConfig>();
 // Each map's forge port (ranger issue #97 ruling Q8), one per repo for this
 // bounded tick. Desks and queue validation share the PR read.
 const targets = new Map<string, ForgePort>();
 const targetFor = (repo: string): ForgePort => {
  let target = targets.get(repo);
  if (target === undefined) targets.set(repo, target = ctx.github ?? lanePort(config, repo));
  return target;
 };
 const ports = new Map<string, ForgePort>();
 const prReads = new Map<string, ReturnType<ForgePort["getPr"]>>();
 const getPr: ForgePort["getPr"] = (repo, number, token) => {
  const key = `${repo}#${number}`;
  if (!prReads.has(key)) prReads.set(key, targetFor(repo).getPr(repo, number, token));
  return prReads.get(key)!;
 };
 const portFor = (repo: string): ForgePort => {
  let port = ports.get(repo);
  if (port === undefined) {
   port = new Proxy(targetFor(repo), {
    get(target, key) {
     if (key === "getPr") return getPr;
     const value = Reflect.get(target, key);
     return typeof value === "function" ? value.bind(target) : value;
    },
   });
   ports.set(repo, port);
  }
  return port;
 };
 // A GitLab map's graph reads run under its read gate, checked once per map this tick.
 const reads = tokenBatch(config, ctx.readGate);
 const readGate: ReadGate = async (_config, repo) => ({ token: await reads(repo) });
 const priorityLanes = new Set<ImplementLane>();

 const order = implementMapOrder(config.maps, lastImplementMaps(journal), implementLane);
 // One sweep wiring for both phases; only the phase differs.
 const sweepPhase = (
  w: { map: RangerMapConfig; token: string; botIdentity: string; graphToken: ResolvedToken },
  phase: "liveness" | "desk",
 ): Promise<SweepMapResult> =>
  sweepMap({
   config,
   journal,
   map: w.map,
   token: w.token,
   botIdentity: w.botIdentity,
   graphToken: w.graphToken,
   github: portFor(w.map.repo),
   phase,
   reservedLanes: priorityLanes,
   respawn: (nodeId, repo, root) =>
    (ctx.spawnRunNode ?? spawnRunNodeDetached)({ nodeId, repo, root, cliEntry, configPath: ctx.configPath }),
  });
 const maps: WalkMapResult[] = [];
 const mapResults = new Map<RangerMapConfig, WalkMapResult>();
 const walked: { map: (typeof order)[number]; mapResult: WalkMapResult; token: string; botIdentity: string; graphToken: ResolvedToken; errors: string[] }[] = [];

 // Pass 1 — authorize every walked map, sweep liveness, resume priority
 // probe parks, then (1b) every map's merge desk, before any claim.
 // The desk sends ready PRs back to run-node (rework,
 // missing probes, a conflict with the base), and a send-back needs its
 // implement lane. Run after the claims, it lost the lane to a fresh claim
 // whenever the lane freed between ticks (2026-10-05: seelite #691 took the
 // visual lane one second before the desk tried to send #491 back, and
 // nothing stopped that repeating). Liveness goes first on every map: a
 // crashed holder on a later map, released after an earlier map's desk ran,
 // would otherwise hand its lane to a claim instead.
 for (const map of order) {
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
  mapResults.set(map, mapResult);

  // Walk-mode gate (node #9): `none` registers the map, nothing more.
  if (map.walk === "none") {
   mapResult.gated = true;
   mapResult.gateReason = "walk: none — this map is registered, not walked";
   maps.push(mapResult);
   continue;
  }

  // A GitLab map without its credentials refuses before any forge or graph call.
  const refusal = laneCredentialRefusal(config, map.repo);
  if (refusal !== null) {
   mapResult.gated = true;
   mapResult.gateReason = refusal;
   maps.push(mapResult);
   continue;
  }

  // Credential gate (node #11 + design §2), and the read gate a GitLab map's
  // graph reads run under (node #122).
  let token: string;
  let botIdentity: string;
  let graphToken: ResolvedToken;
  try {
   ({ token, botIdentity } = await assertWriteIdentity(config, map.repo));
   graphToken = await graphReadToken(config, map.repo, token, readGate);
  } catch (error) {
   mapResult.gated = true;
   mapResult.gateReason = error instanceof Error ? error.message : String(error);
   // A forge that did not answer either gate (a timeout, a 5xx) is transient.
   if ((error instanceof WriteGateError || error instanceof GateError) && error.transient) transientGates.add(map);
   maps.push(mapResult);
   continue;
  }

  // Dead-man gate (design §7): paused ⇒ read-only pass (sweep still runs).
  if (journal.isPaused()) {
   mapResult.gated = true;
   mapResult.gateReason =
    "dead-man paused — claiming stopped; human resume-run required";
  }

  const errors: string[] = [];
  maps.push(mapResult);
  walked.push({ map, mapResult, token, botIdentity, graphToken, errors });
 }

 // Retry parks outrank every other queued implement session, including
 // crash respawns on a map visited earlier. Reserve across all authorized maps
 // before any liveness sweep, then clean up dead holders and orphan groups.
 const retryMaps = walked.filter((w) => !w.mapResult.gated).map((w) => w.map);
 for (const row of probeRequeueCandidates(journal, retryMaps, config.workers.probeRequeues)) {
  const map = retryMaps.find((m) => m.repo === row.repo && m.root === row.root) as RangerMapConfig;
  priorityLanes.add(implementLane(map));
 }
 for (const { map, mapResult, token, botIdentity, graphToken, errors } of walked) {
  // Sweep always runs for a walked map (even paused — liveness/audit surface).
  try {
   mapResult.sweep = await sweepPhase({ map, token, botIdentity, graphToken }, "liveness");
  } catch (error) {
   errors.push(
    `sweep failed: ${error instanceof Error ? error.message : String(error)}`,
   );
  }
 }

 // Re-check parks under the same lease used by new claims. A failed spawn
 // keeps its priority for this tick instead of handing capacity to new work.
 try {
  result.probeRequeues = await withClaimLock(journal, (owned) => requeueProbes({
   journal, maps: retryMaps, limit: config.workers.probeRequeues, owned,
   spawn: (nodeId, repo, root) => (ctx.spawnRunNode ?? spawnRunNodeDetached)({
    nodeId, repo, root, cliEntry, configPath: ctx.configPath,
   }),
  }));
  priorityLanes.clear();
  for (const lane of result.probeRequeues.lanes) priorityLanes.add(lane);
 } catch (error) {
  result.probeRequeues.errors.push(String(error));
  // Keep the pre-sweep reservations if the retry lease was unavailable.
 }
 for (const lane of priorityLanes) implementClaimed.add(lane);

 // Pass 1b — the merge desks, against lanes every liveness sweep has settled.
 for (const { map, mapResult, token, botIdentity, graphToken, errors } of walked) {
  // No child spawned (or it finished immediately): the retry still won this
  // lane for this tick; queued send-backs wait until the next tick.
  if (priorityLanes.has(implementLane(map)) && journal.laneHolder(implementLane(map)) === null) continue;
  try {
   const desk = await sweepPhase({ map, token, botIdentity, graphToken }, "desk");
   // A failed liveness sweep left no result: the desk's own stands in, so
   // what the desk did (and its row errors) still reaches the report.
   if (mapResult.sweep === undefined) mapResult.sweep = desk;
   else if (desk.mergeDesk !== undefined) mapResult.sweep.mergeDesk = desk.mergeDesk;
  } catch (error) {
   errors.push(`merge desk failed: ${error instanceof Error ? error.message : String(error)}`);
  }
 }

 // Pass 1c — the ratify phase (node #250): one paged reactions read per open
 // proposal, capped per tick; the principal's 👍 resumes it at the close.
 // It holds no lane, so it runs beside the desks, before any claim.
 try {
  result.ratify = await ratifyPass({
   config,
   journal,
   maps: walked.map(({ map, token, botIdentity }) => ({ map, token, botIdentity })),
   portFor: targetFor,
   spawn: (nodeId, repo, root) =>
    (ctx.spawnRunNode ?? spawnRunNodeDetached)({ nodeId, repo, root, cliEntry, configPath: ctx.configPath }),
   refuseCard: (map, veto) => refuseProposalCard({ config, journal, map, veto }),
   ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });
 } catch (error) {
  result.ratify.errors.push(`ratify phase failed: ${error instanceof Error ? error.message : String(error)}`);
 }

 // Pass 1d — queued resumes, FIFO within each implement lane, ahead of claims.
 if (journal.listResumeQueue().length > 0) {
  try {
   await withClaimLock(journal, owned => processResumeQueue({ ...ctx, github: { getPr } },
    order.map(map => {
     const w = walked.find(w => w.map === map);
     const m = mapResults.get(map)!;
     return { map, token: w?.token, graphToken: w?.graphToken, gateReason: m.gateReason, gateTransient: transientGates.has(map), errors: w?.errors ?? m.errors };
    }), implementClaimed, owned));
  } catch (error) {
   for (const w of walked) w.errors.push(`resume queue failed: ${error instanceof Error ? error.message : String(error)}`);
  }
 }

 // Pass 2 — claims, against lanes the sweeps, desks and queued resumes have settled.
 for (const { map, mapResult, token, botIdentity, graphToken, errors } of walked) {
  if (!mapResult.gated) {
   const readArgs = {
    journal,
    repo: map.repo,
    root: map.root,
    token: graphToken,
    policy: budgetPolicy(config),
    maxAgeMs: config.budget.frontierMaxAgeMin * 60_000,
    timeoutMs: GRAPH_CALL_TIMEOUT_MS,
   };
   // The audit runs here, before the claim lock: on a large map it takes
   // minutes, and under the lock it held the lock that long and widened the
   // gap between the drain read and the claims (2026-10-09: seelite #820 was
   // claimed 21s after the visual lane was drained). The locked read below
   // serves this audit and holds any build node edited in between.
   // Not a gate (the gates are read under the lock): a paused walk or a
   // drained headless map claims nothing, so it skips the audit.
   const idle = journal.isPaused() || (implementLane(map) === "headless" && journal.isMapDrained(mapKey(map)));
   // The root's author gates the propose research lane (node #246, D6): read
   // once per map, only when this read shows a node it gates, then kept, so
   // the locked plan below reads no GitHub for it.
   let rootAuthor = cachedRootAuthor(journal, map.repo, map.root);
   if (!idle) {
    try {
     const warm = await readFrontier({ ...readArgs, now: ctx.now?.() ?? new Date(), audit: "refresh" });
     if (warm.auditMs !== undefined) mapResult.auditMs = warm.auditMs;
     if (warm.auditNote !== undefined) errors.push(`build briefs: ${warm.auditNote}`);
     if (rootAuthor === undefined && needsRootAuthor(warm.frontier.frontier)) {
      rootAuthor = await readRootAuthor({ ...readArgs, now: ctx.now?.() ?? new Date() });
     }
    } catch {
     // The locked read meets the same deferral or failure and reports it.
    }
   }
   try {
    // The claim lock (node #58) spans the map's whole claim phase: a
    // `ranger build-now` claims before or after it, never between this
    // plan's gate reads and its `claimed` rows.
    await withClaimLock(journal, async (owned) => {
     // A pause recorded while this tick waited for the lock stops it here.
     if (journal.isPaused()) {
      mapResult.paused = true;
      mapResult.gated = true;
      mapResult.gateReason = "dead-man paused — claiming stopped; human resume-run required";
      return;
     }
     // So is a drain (node #165), read here the same way: sweeps, desks and
     // queued resumes above ran regardless; only fresh claims stop.
     const drain = drainGate(
      { key: mapKey(map), lane: implementLane(map) },
      readDrains(journal, [map]),
     );
     if (drain !== null) mapResult.drained = drain.reason;
     if (drain?.scope === "map") {
      mapResult.gated = true;
      mapResult.gateReason = drain.reason;
      return;
     }
     // walk MUST classify from a frontier no older than the repo is NOW:
     // reusing the escalation pass's read (up to ~120s old) unchecked could
     // misroute claims — a node edited to HITL in that window would still be
     // announced+claimed as auto+research (round-29 review). readFrontier
     // re-reads the repo's sentinel here and serves the cached read only when
     // nothing changed since it was taken, so round-29 holds without paying
     // GraphQL for an unchanged map (src/frontier-cache.ts). It never runs
     // the audit: the read before the lock did.
     const { frontier: fetched, briefs } = await readFrontier({ ...readArgs, now: ctx.now?.() ?? new Date(), audit: "never" });
     const frontierEntries = fetched.frontier;
     // A build node whose brief soma's audit reports not ready routes
     // brief-not-ready, so the plan never takes it (node #154).
     const classified = classifyFrontier(frontierEntries, map, registry, botIdentity, briefs, {
      principal: principalLoginForRepo(config, map.repo),
      rootAuthor,
     });
     if (!briefs.ok) errors.push(`build briefs unverified — build nodes held this tick: ${briefs.error}`);
     // The plan `ranger serve` (#37) also reads, so its "next" is this order.
     const planOf = (nodes: typeof classified) => planTick(nodes, {
      laneBusy: implementClaimed.has(implementLane(map)) || implementLaneBusy(journal, implementLane(map)),
      vetoed: (id) => journal.hasVeto(id, map.repo),
      implementDrained: drain?.scope === "lane",
     });
     // A veto is rebuilt from GitHub before a propose research node is
     // claimed (node #240, rulings D1, D7): the journal is a cache, and a
     // lost one must not re-propose a node the principal refused.
     const gate = await gateProposeReads({
      plan: planOf(classified),
      replan: () => planOf(classified),
      room: config.workers.spawnCapPerDay - journal.spawnsToday(ctx.now?.() ?? new Date()),
      readsPerTick: config.ratify.readsPerTick,
      rebuild: (nodeIds) => rebuildVetoes({ journal, map, botIdentity, token, port: portFor(map.repo), nodeIds }),
     });
     errors.push(...gate.errors);
     owned();
     const plan = gate.plan;
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
      // A propose research node whose veto was not read this tick (node #240).
      if (!gate.claimable(node)) continue;
      try {
       journal.assertWorkerRoot(node.id, map.repo, map.root);
      } catch (error) {
       errors.push(error instanceof Error ? error.message : String(error));
       continue;
      }
      // A drain set since the gate read above (the operator verb takes no
      // claim lock) still stops this claim: re-read it at the last moment.
      const late = drainGate({ key: mapKey(map), lane: implementLane(map) }, readDrains(journal, [map]));
      if (late !== null && (late.scope === "map" || laneOf(node.id) === "implement")) {
       mapResult.drained = late.reason;
       if (late.scope === "map") break;
       continue;
      }

      let outcome: ClaimNodeOutcome;
      try {
       outcome = await claimNode({
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
        owned,
       });
      } catch (error) {
       // A failed claim is this node's error, not the map's (node #163): soma
       // refuses a blocked node with plain text, indistinguishable from any
       // other claim failure, so the next candidate is still claimed. Lock,
       // lease and budget failures are not GraphWriteErrors and still end
       // the map's claim phase.
       if (!(error instanceof GraphWriteError)) throw error;
       errors.push(`#${node.id} claim failed (${error.message}) — skipped`);
       continue;
      }
      if (outcome.messageId !== null) mapResult.announced.push(node.id);
      if (!outcome.claimed) {
       errors.push(outcome.error);
       continue;
      }
      mapResult.claimed.push(node.id);
      if (laneOf(node.id) === "implement") implementClaimed.add(implementLane(map));
     }
    });
   } catch (error) {
    if (error instanceof ClaimLockBusy) {
     errors.push(`${error.message} — no claims on this map this tick`);
    } else if (error instanceof BudgetDeferral) {
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
 }

 // Intake runs on every map with a thread but `walk: none` (D17), whatever
 // the gates above decided: it reads Discord and posts draft cards, and an
 // intake add is never on ranger's initiative: it runs on the principal's 👍,
 // through its own write gate (node #251). Last, so it never delays a claim.
 result.intake = await intakePass({
  config,
  journal,
  portFor: targetFor,
  ...(ctx.now === undefined ? {} : { now: ctx.now }),
  ...(ctx.intakeClient === undefined ? {} : { clientFor: ctx.intakeClient }),
  ...(ctx.intakeClaude === undefined ? {} : { claude: ctx.intakeClaude }),
 });

 result.maps = maps;
 return result;
}

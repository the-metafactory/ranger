import { implementLane, type ImplementLane } from "./lanes.ts";
import { processResumeQueue } from "./resume.ts";
import { busyLoadFor, hostBusy, type HostLoad } from "./host-load.ts";
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
import { emptyJobPass, jobPass, jobsPending, type JobPassResult, type SpawnJobArgs } from "./jobs.ts";
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

export { implementCandidates, planTick, researchCandidates, selectCandidates };

export interface WalkMapResult {
 repo: string;
 walkMode: WalkMode;
 gated: boolean;
 gateReason?: string;
 announced: string[];
 claimed: string[];
 spawnCapExhausted: boolean;
 hostBusy?: string;
 paused: boolean;
 drained?: string;
 auditMs?: number;
 errors: string[];
 sweep?: SweepMapResult;
}

export interface WalkResult {
 maps: WalkMapResult[];
 spawnCapPerDay: number;
 probeRequeues: ProbeRequeueResult;
 intake: IntakeResult;
 ratify: RatifyResult;
 jobs?: JobPassResult;
}

export interface WalkContext {
 config: RangerConfig;
 configPath: string;
 journal: Journal;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
 github?: ForgePort;
 readGate?: ReadGate;
 intakeClient?: IntakeContext["clientFor"];
 intakeClaude?: IntakeContext["claude"];
 hostLoad?: HostLoad;
 spawnJob?: (args: SpawnJobArgs) => Promise<number | null>;
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
 announceRequired?: boolean;
 announce?: AnnounceFn;
 claim?: ClaimFn;
 spawnRunNode?: (args: SpawnRunNodeArgs) => Promise<number | null>;
 now?: () => Date;
 owned?: OwnedCheck;
}

export type ClaimNodeOutcome =
 | { claimed: true; messageId: string | null; announceError: string | null; pid: number | null }
 | {
    claimed: false;
    messageId: string | null;
    error: string;
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
 owned();
 recordFreshClaim(args, messageId, now());
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

function recordFreshClaim(args: ClaimNodeArgs, messageId: string | null, at: Date): void {
 const { journal, map, node } = args;
 if (args.lane === "implement") recordImplementStart(journal, map);
 journal.recordSpawn(at);
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
}

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
 const lanesTakenThisTick = new Set<ImplementLane>();
 const transientGates = new Set<RangerMapConfig>();
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
 const reads = tokenBatch(config, ctx.readGate);
 const readGate: ReadGate = async (_config, repo) => ({ token: await reads(repo) });
 const priorityLanes = new Set<ImplementLane>();

 const order = implementMapOrder(config.maps, lastImplementMaps(journal), implementLane);
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

  if (map.walk === "none") {
   mapResult.gated = true;
   mapResult.gateReason = "walk: none — this map is registered, not walked";
   maps.push(mapResult);
   continue;
  }

  const refusal = laneCredentialRefusal(config, map.repo);
  if (refusal !== null) {
   mapResult.gated = true;
   mapResult.gateReason = refusal;
   maps.push(mapResult);
   continue;
  }

  let token: string;
  let botIdentity: string;
  let graphToken: ResolvedToken;
  try {
   ({ token, botIdentity } = await assertWriteIdentity(config, map.repo));
   graphToken = await graphReadToken(config, map.repo, token, readGate);
  } catch (error) {
   mapResult.gated = true;
   mapResult.gateReason = error instanceof Error ? error.message : String(error);
   if ((error instanceof WriteGateError || error instanceof GateError) && error.transient) transientGates.add(map);
   maps.push(mapResult);
   continue;
  }

  if (journal.isPaused()) {
   mapResult.gated = true;
   mapResult.gateReason =
    "dead-man paused — claiming stopped; human resume-run required";
  }

  const errors: string[] = [];
  maps.push(mapResult);
  walked.push({ map, mapResult, token, botIdentity, graphToken, errors });
 }

 const retryMaps = walked.filter((w) => !w.mapResult.gated).map((w) => w.map);
 for (const row of probeRequeueCandidates(journal, retryMaps, config.workers.probeRequeues)) {
  const map = retryMaps.find((m) => m.repo === row.repo && m.root === row.root) as RangerMapConfig;
  priorityLanes.add(implementLane(map));
 }
 for (const { map, mapResult, token, botIdentity, graphToken, errors } of walked) {
  try {
   mapResult.sweep = await sweepPhase({ map, token, botIdentity, graphToken }, "liveness");
  } catch (error) {
   errors.push(
    `sweep failed: ${error instanceof Error ? error.message : String(error)}`,
   );
  }
 }

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
 }
 for (const lane of priorityLanes) lanesTakenThisTick.add(lane);

 for (const { map, mapResult, token, botIdentity, graphToken, errors } of walked) {
  const retryReservedIdleLane = priorityLanes.has(implementLane(map)) && journal.laneHolder(implementLane(map)) === null;
  if (retryReservedIdleLane) continue;
  try {
   const desk = await sweepPhase({ map, token, botIdentity, graphToken }, "desk");
   if (mapResult.sweep === undefined) mapResult.sweep = desk;
   else if (desk.mergeDesk !== undefined) mapResult.sweep.mergeDesk = desk.mergeDesk;
  } catch (error) {
   errors.push(`merge desk failed: ${error instanceof Error ? error.message : String(error)}`);
  }
 }

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

 if (journal.listResumeQueue().length > 0) {
  try {
   await withClaimLock(journal, owned => processResumeQueue({ ...ctx, github: { getPr } },
    order.map(map => {
     const w = walked.find(w => w.map === map);
     const m = mapResults.get(map)!;
     return { map, token: w?.token, graphToken: w?.graphToken, gateReason: m.gateReason, gateTransient: transientGates.has(map), errors: w?.errors ?? m.errors };
    }), lanesTakenThisTick, owned));
  } catch (error) {
   for (const w of walked) w.errors.push(`resume queue failed: ${error instanceof Error ? error.message : String(error)}`);
  }
 }

 if (jobsPending(journal)) {
  try {
   result.jobs = await withClaimLock(journal, () => jobPass({
    config, configPath: ctx.configPath, journal, cliEntry, takenLanes: lanesTakenThisTick,
    ...(ctx.spawnJob === undefined ? {} : { spawnJob: ctx.spawnJob }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
   }));
  } catch (error) {
   result.jobs = { ...emptyJobPass(), errors: [`job pass failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
 }

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
   const claimsNothing = journal.isPaused() || (implementLane(map) === "headless" && journal.isMapDrained(mapKey(map)));
   let rootAuthor = cachedRootAuthor(journal, map.repo, map.root);
   const auditBeforeLock = async () => {
    const warm = await readFrontier({ ...readArgs, now: ctx.now?.() ?? new Date(), audit: "refresh" });
    if (warm.auditMs !== undefined) mapResult.auditMs = warm.auditMs;
    if (warm.auditNote !== undefined) errors.push(`build briefs: ${warm.auditNote}`);
    if (rootAuthor === undefined && needsRootAuthor(warm.frontier.frontier)) {
     rootAuthor = await readRootAuthor({ ...readArgs, now: ctx.now?.() ?? new Date() });
    }
   };
   const lockedReadReportsFailures = () => undefined;
   if (!claimsNothing) await auditBeforeLock().catch(lockedReadReportsFailures);
   try {
    await withClaimLock(journal, async (owned) => {
     if (journal.isPaused()) {
      mapResult.paused = true;
      mapResult.gated = true;
      mapResult.gateReason = "dead-man paused — claiming stopped; human resume-run required";
      return;
     }
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
     const { frontier: fetched, briefs } = await readFrontier({ ...readArgs, now: ctx.now?.() ?? new Date(), audit: "never" });
     const frontierEntries = fetched.frontier;
     const classified = classifyFrontier(frontierEntries, map, registry, botIdentity, briefs, {
      principal: principalLoginForRepo(config, map.repo),
      rootAuthor,
     });
     if (!briefs.ok) errors.push(`build briefs unverified — build nodes held this tick: ${briefs.error}`);
     const planOf = (nodes: typeof classified) => planTick(nodes, {
      laneBusy: lanesTakenThisTick.has(implementLane(map)) || implementLaneBusy(journal, implementLane(map)),
      vetoed: (id) => journal.hasVeto(id, map.repo),
      implementDrained: drain?.scope === "lane",
     });
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
      const busy = hostBusy(ctx.hostLoad, busyLoadFor(config.workers, implementLane(map)));
      if (busy !== null) {
       mapResult.hostBusy = busy;
       break;
      }
      if (plan.vetoed.includes(node)) {
       errors.push(`#${node.id} vetoed — not claimed`);
       continue;
      }
      if (!gate.claimable(node)) continue;
      try {
       journal.assertWorkerRoot(node.id, map.repo, map.root);
      } catch (error) {
       errors.push(error instanceof Error ? error.message : String(error));
       continue;
      }
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
      if (laneOf(node.id) === "implement") lanesTakenThisTick.add(implementLane(map));
     }
    });
   } catch (error) {
    if (error instanceof ClaimLockBusy) {
     errors.push(`${error.message} — no claims on this map this tick`);
    } else if (error instanceof BudgetDeferral) {
     mapResult.gated = true;
     mapResult.gateReason = error.message;
    } else {
     errors.push(error instanceof Error ? error.message : String(error));
    }
   }
  }

  mapResult.errors = errors;
 }

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

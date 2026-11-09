import { existsSync } from "node:fs";
import type { NodeResult } from "./graph.ts";
import type { SweepContext, SweepMapResult } from "./sweep.ts";
import type { RangerMapConfig } from "./config.ts";
import { mapKey } from "./maps.ts";
import { closedCardBudget, reconcileGraphClosedCards } from "./card-sync.ts";
import { mapPool } from "./pool.ts";
import { findNodePr, finishClosedElsewhere } from "./closed-elsewhere.ts";
import { lanePort } from "./forge-lanes.ts";
import { safeGit } from "./git-ops.ts";
import { FencedError, type Journal, type WorkerRow } from "./journal.ts";
import { renderCard } from "./card-render.ts";
import { DiscordAnnouncer } from "./announce.ts";

/** Fixed work per tick; the keyset cursor prevents an open prefix starving the tail. */
export const MAX_WORKER_CLOSURE_READS = 5;

/**
 * One node's closure reconciliation that defers with the same worktree head and
 * the same failure this many times is parked instead of retried (node #504:
 * cortex#3217 deferred once per tick for 36 hours, 267 events, no park).
 * A failure counts as the same one when it only differs in a URL, a SHA or a
 * number: an incident's error text carries timings and ids that move per tick.
 */
export const MAX_IDENTICAL_CLOSURE_DEFERRALS = 3;

const VOLATILE_FAILURE_DETAIL = /https?:\/\/\S+|\b[0-9a-f]{7,40}\b|\d+(?:\.\d+)?/g;

function failureShape(failure: string): string {
 return failure.replace(VOLATILE_FAILURE_DETAIL, "·").replace(/\s+/g, " ").trim();
}

const CLOSURE_PARK_OUTCOME = "closure sweep parked: ";

type Post = NonNullable<SweepContext["post"]>;

interface ClosureDeferral {
 generation: number;
 head: string;
 failure: string;
 count: number;
 parked: boolean;
 notified: boolean;
}

const deferralKey = (map: Pick<RangerMapConfig, "repo" | "root">, nodeId: string): string =>
 `sweep.closureDeferral.${mapKey(map)}.${nodeId}`;

function parseDeferral(raw: string | null): ClosureDeferral | null {
 if (raw === null || raw === "") return null;
 try {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<ClosureDeferral>;
  if (typeof record.generation !== "number" || typeof record.head !== "string" ||
   typeof record.failure !== "string" || typeof record.count !== "number") return null;
  return { generation: record.generation, head: record.head, failure: record.failure,
   count: record.count, parked: record.parked === true, notified: record.notified === true };
 } catch (error) {
  if (error instanceof Error) return null;
  throw error;
 }
}

function closureHolds(journal: Journal, map: RangerMapConfig, worker: WorkerRow): boolean {
 const record = parseDeferral(journal.getHealth(deferralKey(map, worker.nodeId)));
 return record !== null && record.parked && record.generation === worker.generation;
}

function closureParkReason(record: ClosureDeferral, worker: WorkerRow): string {
 const at = record.head === "" ? "with an unreadable worktree head" : `at worktree ${record.head.slice(0, 8)}`;
 const where = worker.worktree === null ? "" : ` (${worker.worktree})`;
 return `${CLOSURE_PARK_OUTCOME}the same deferral repeated ${record.count} times ${at}${where} with no change — ${record.failure}. ` +
  `Later ticks do not retry it; reconcile the worktree and run \`ranger resume-node ${worker.nodeId}\``;
}

async function worktreeHead(worktree: string | null): Promise<string> {
 if (worktree === null || !existsSync(worktree)) return "";
 try {
  const head = await safeGit(["rev-parse", "--verify", "HEAD"], { cwd: worktree, timeoutMs: 10_000 });
  const sha = head.stdout.trim();
  return head.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
 } catch (error) {
  if (error instanceof Error) return "";
  throw error;
 }
}

function closureAnnouncer(ctx: SweepContext): Post | null {
 if (ctx.post !== undefined) return ctx.post;
 if (ctx.map.discord === undefined) return null;
 const map = ctx.map;
 let announcer: DiscordAnnouncer | undefined;
 return async (content, label, files, embeds) =>
  (announcer ??= DiscordAnnouncer.fromMap(map)).post(content, label, files, embeds);
}

function clearClosureDeferral(journal: Journal, map: Pick<RangerMapConfig, "repo" | "root">, nodeId: string): void {
 const key = deferralKey(map, nodeId);
 if (journal.getHealth(key) === null) return;
 journal.setHealth(key, "");
}

async function notifyClosurePark(args: {
 journal: Journal;
 map: RangerMapConfig;
 worker: WorkerRow;
 post: Post | null;
}): Promise<void> {
 const { journal, map, worker, post } = args;
 const key = deferralKey(map, worker.nodeId);
 const record = parseDeferral(journal.getHealth(key));
 if (record === null || !record.parked || record.notified) return;
 if (post !== null) {
  try {
   await post(renderCard({
    emoji: "⏸️",
    status: "closure sweep parked",
    nodeId: worker.nodeId,
    meta: [`map: ${mapKey(map)}`],
    body: closureParkReason(record, worker),
    bodyMax: 1_500,
   }), `closure park card for #${worker.nodeId}`);
  } catch (error) {
   journal.recordEvent("sweep", { nodeId: worker.nodeId, repo: map.repo,
    detail: `closure park card for #${worker.nodeId} not posted: ${String(error).slice(0, 400)}` });
   return;
  }
 }
 journal.setHealth(key, JSON.stringify({ ...record, notified: true }));
}

async function parkClosure(args: {
 journal: Journal;
 map: RangerMapConfig;
 worker: WorkerRow;
 result: SweepMapResult;
 record: ClosureDeferral;
 post: Post | null;
 phase?: "close";
}): Promise<void> {
 const { journal, map, worker, result, record, post } = args;
 const reason = closureParkReason(record, worker);
 const reparkable = worker.status === "awaiting-merge" || worker.status === "proposed";
 if (reparkable) {
  try {
   journal.forWorker(worker.nodeId, map.repo, worker.generation).updateWorker(worker.nodeId, map.repo, {
    status: "parked", pid: null, workerPgid: null, finishedAt: new Date().toISOString(), outcome: reason,
    ...(args.phase === undefined ? {} : { phase: args.phase }),
   });
  } catch (error) {
   if (error instanceof FencedError) {
    journal.recordEvent("fenced", { nodeId: worker.nodeId, repo: map.repo,
     detail: `closure sweep parked no node: generation ${worker.generation} was superseded` });
    return;
   }
   throw error;
  }
  journal.recordEvent("parked", { nodeId: worker.nodeId, repo: map.repo, detail: reason });
  result.parked.push(worker.nodeId);
 } else {
  journal.recordEvent("sweep", { nodeId: worker.nodeId, repo: map.repo,
   detail: `${reason}; the row stays ${worker.status} with its own outcome` });
 }
 await notifyClosurePark({ journal, map, worker, post });
}

async function recordClosureDeferral(args: {
 journal: Journal;
 map: RangerMapConfig;
 worker: WorkerRow;
 result: SweepMapResult;
 post: Post | null;
 detail: string;
 phase?: "close";
}): Promise<void> {
 const { journal, map, worker, result, post } = args;
 const failure = args.detail.slice(0, 400);
 journal.recordEvent("sweep", { nodeId: worker.nodeId, repo: map.repo, detail: failure });
 const key = deferralKey(map, worker.nodeId);
 const previous = parseDeferral(journal.getHealth(key));
 const head = await worktreeHead(worker.worktree);
 const repeated = previous !== null && previous.generation === worker.generation &&
  previous.head === head && failureShape(previous.failure) === failureShape(failure);
 const count = repeated ? previous.count + 1 : 1;
 const parked = count >= MAX_IDENTICAL_CLOSURE_DEFERRALS;
 const record: ClosureDeferral = { generation: worker.generation, head, failure, count, parked, notified: false };
 journal.setHealth(key, JSON.stringify(record));
 if (!parked) return;
 await parkClosure({ journal, map, worker, result, record, post, phase: args.phase });
}

export async function reconcileGraphClosures(
 ctx: SweepContext,
 readNode: (id: string) => Promise<NodeResult>,
 result: SweepMapResult,
): Promise<void> {
 const { journal, map } = ctx;
 const cursorKey = `sweep.closureCursor.${mapKey(map)}`;
 const after = journal.getHealth(cursorKey) || undefined;
 const rows = journal.listClosureCandidates(map.repo, map.root, MAX_WORKER_CLOSURE_READS, after);
 const post = closureAnnouncer(ctx);
 const observations = await mapPool(rows, 3, async worker => {
  if (closureHolds(journal, map, worker)) {
   await notifyClosurePark({ journal, map, worker, post });
   return { worker, node: null };
  }
  try {
   const node = await readNode(worker.nodeId);
   if (node.status !== "closed") clearClosureDeferral(journal, map, worker.nodeId);
   return { worker, node };
  } catch (error) {
   await recordClosureDeferral({ journal, map, worker, result, post,
    detail: `graph closure reconciliation deferred: ${String(error)}` });
   return { worker, node: null };
  }
 });
 const cardBudget = closedCardBudget();
 const forge = ctx.github ?? lanePort(ctx.config, map.repo);
 for (const { worker, node } of observations) {
  if (node?.status !== "closed") continue;
  try {
   const pr = await findNodePr(forge, map.repo, node, worker.prNumber, ctx.token);
   const outcome = await finishClosedElsewhere({ ...ctx, node, pr, generation: worker.generation, worktree: worker.worktree, cardBudget });
   if (outcome.status === "released") result.released.push(worker.nodeId);
   clearClosureDeferral(journal, map, worker.nodeId);
  } catch (error) {
   await recordClosureDeferral({ journal, map, worker, result, post, phase: "close",
    detail: `graph closure reconciliation deferred: ${String(error)}` });
  }
 }
 journal.setHealth(cursorKey, rows.length < MAX_WORKER_CLOSURE_READS ? "" : rows.at(-1)!.nodeId);
 try { await reconcileGraphClosedCards({ journal, map, readNode, budget: cardBudget }); }
 catch (error) { journal.recordEvent("sweep", { repo: map.repo, detail: `graph-closed cards deferred: ${String(error)}` }); }
}

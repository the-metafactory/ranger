import { principalLoginForRepo, type RangerConfig, type RangerMapConfig } from "./config.ts";
import type { TickPlan } from "./candidates.ts";
import type { CommentReaction, ForgePort, IssueComment } from "./forge.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { nodeCommentUrl, nodeUrl } from "./forge-text.ts";
import { cachedOpenClaims } from "./frontier-cache.ts";
import { GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import { graphRelease, type ReleaseResult } from "./graph-write.ts";
import { assertNotPrincipal } from "./identity.ts";
import type { Journal, VetoRow, WorkerRow } from "./journal.ts";
import { mapKey } from "./maps.ts";
import type { ClassifiedNode } from "./route.ts";

/**
 * The ratify phase of the walk tick (node #250, #21 rulings D4, D6, D8, D9).
 *
 * Each open proposal (a `proposed` worker row, node #246) gets one paged
 * reactions read, at most `ratify.readsPerTick` per tick. Soma counts any
 * non-proposer 👍 as a ratification and closes even with none, so the pin
 * is ranger's alone: a `+1` from the principal login for the map's forge
 * host, and no `-1` from that login. Every other reaction is ignored. A
 * ratified proposal resumes at the close: a detached run-node runs
 * `soma graph close --proposal-comment` under the machine account, with
 * no LLM session (the merge desk's resume-for-close).
 *
 * A principal `-1` vetoes the node for good (node #240, ruling D7), with or
 * without a `+1`: ranger posts a veto comment carrying
 * `<!-- ranger:veto node=N proposal=<id> -->`, records the veto, releases the
 * claim and edits the card to "refused, yours to take"; the node is never
 * closed and never proposed again. The journal is a cache (ruling D1): a
 * proposal whose row a lost journal took with it is recovered from the
 * node's comments, and the walk rebuilds a veto from them before it claims
 * a propose research node (`rebuildVetoes`).
 */

/** The proposal comment's binding marker (ruling D8); the worker writes it. */
export function proposalMarker(nodeId: string): string {
 return `<!-- ranger:proposal node=${nodeId} -->`;
}

/**
 * The `outcome` prefix of a proposed row whose comment ranger could not
 * find (ruling D8): its card says so, and the phase reads it no more.
 */
export const PROPOSAL_MISSING = "proposal comment missing";

/** The start of a node's veto marker, up to the proposal id. */
export function vetoMarkerPrefix(nodeId: string): string {
 return `<!-- ranger:veto node=${nodeId} proposal=`;
}

/** The veto comment's marker (node #240): the record a lost journal rebuilds a veto from. */
export function vetoMarker(nodeId: string, proposalCommentId: string): string {
 return `${vetoMarkerPrefix(nodeId)}${proposalCommentId} -->`;
}

/** The `outcome` prefix of a vetoed row (node #240). */
export const VETOED = "vetoed";

/** When the phase last read this proposal; the rotation key (journal `health`). */
export const ratifyReadKey = (repo: string, nodeId: string) => `ratify-read.${repo}#${nodeId}`;

export interface RatifyResult {
 /** `repo#node` of every proposal whose reactions were read. */
 read: string[];
 /** Ratified and resumed at the close. */
 closing: string[];
 /** Vetoed by the principal: veto comment posted, claim released (node #240). */
 vetoed: string[];
 /** Proposals a lost journal dropped, recovered from the node's comments (node #240). */
 recovered: string[];
 /** Over the per-tick cap: read on a later tick. */
 deferred: string[];
 errors: string[];
}

export interface RatifyMap {
 map: RangerMapConfig;
 token: string;
 botIdentity: string;
}

export interface RatifyContext {
 config: RangerConfig;
 journal: Journal;
 maps: RatifyMap[];
 portFor: (repo: string) => Pick<ForgePort, "issueComments" | "commentReactions" | "postComment">;
 /** Spawn the resume-for-close run-node; null when nothing started. */
 spawn: (nodeId: string, repo: string, root: number) => Promise<number | null>;
 /** Release the machine account's claim (default `soma graph release`). */
 release?: (repo: string, nodeId: string, identity: string, token: string) => Promise<ReleaseResult>;
 /** Edit the node's card to "refused, yours to take" (node #240); none when absent. */
 refuseCard?: (map: RangerMapConfig, veto: VetoRow) => Promise<void>;
 now?: () => Date;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Ruling D6's pin: the principal's `+1`, and no `-1` from the principal. */
export function principalRatified(reactions: readonly CommentReaction[], principal: string): boolean {
 const mine = reactions.filter((r) => sameLogin(r.author, principal));
 return mine.some((r) => r.content === "+1") && !mine.some((r) => r.content === "-1");
}

/** Ruling D7: any `-1` from the principal vetoes, a `+1` beside it or not. */
export function principalVetoed(reactions: readonly CommentReaction[], principal: string): boolean {
 return reactions.some((r) => sameLogin(r.author, principal) && r.content === "-1");
}

const validId = (c: IssueComment) => Number.isSafeInteger(c.id) && c.id > 0;

/**
 * The veto from the node's comments (node #240): the newest comment the
 * machine account wrote that ends with this node's veto marker, and the
 * proposal it vetoed; else null. Only the final line counts: a bot comment
 * that quotes outside text carrying the marker mid-body records no veto.
 */
export function boundVeto(
 comments: readonly IssueComment[],
 botIdentity: string,
 nodeId: string,
): { commentId: string; proposalCommentId: string } | null {
 const prefix = vetoMarkerPrefix(nodeId);
 for (const c of [...comments].sort((a, b) => b.id - a.id)) {
  if (!sameLogin(c.author, botIdentity) || !validId(c)) continue;
  const last = c.body.trimEnd().split("\n").at(-1)!.trim();
  if (!last.startsWith(prefix)) continue;
  const match = /^(\d+) -->$/.exec(last.slice(prefix.length));
  if (match !== null) return { commentId: String(c.id), proposalCommentId: match[1]! };
 }
 return null;
}

/** The veto comment ranger posts on the node (node #240, ruling D7). */
export function vetoCommentBody(repo: string, nodeId: string, proposalCommentId: string, principal: string): string {
 const proposal = nodeCommentUrl(repo, nodeUrl(repo, nodeId), proposalCommentId);
 return [
  `**Vetoed.** ${principal} reacted 👎 on ranger's proposal (${proposal}).`,
  "Ranger released its claim on this node and will never propose it again. The node stays open: it is yours to take.",
  "",
  vetoMarker(nodeId, proposalCommentId),
 ].join("\n");
}

/**
 * The proposal comment id from the node's comments (ruling D8): the newest
 * comment the machine account wrote that carries this node's marker, else
 * null. Ranger never guesses past that.
 */
export function boundProposalComment(comments: readonly IssueComment[], botIdentity: string, nodeId: string): string | null {
 const marker = proposalMarker(nodeId);
 const bound = comments
  .filter((c) => sameLogin(c.author, botIdentity) && c.body.includes(marker) && validId(c))
  .sort((a, b) => b.id - a.id)[0];
 return bound === undefined ? null : String(bound.id);
}

const missing = (row: WorkerRow) => row.proposalCommentId === null && (row.outcome ?? "").startsWith(PROPOSAL_MISSING);

/**
 * The open proposals this tick reads: the least recently read first, then
 * the oldest proposal. A proposal never read (or whose last read failed)
 * goes first, and the oldest ones the principal leaves alone cannot hold
 * the cap for good. A row whose comment is known missing is not read again.
 */
export function ratifyOrder(journal: Journal, rows: readonly WorkerRow[]): WorkerRow[] {
 const lastRead = (row: WorkerRow) => journal.getHealth(ratifyReadKey(row.repo, row.nodeId)) ?? "";
 return rows
  .filter((row) => row.status === "proposed" && !missing(row))
  .map((row) => ({ row, read: lastRead(row), at: row.finishedAt ?? row.startedAt ?? "" }))
  .sort((a, b) => a.read.localeCompare(b.read) || a.at.localeCompare(b.at) || Number(a.row.nodeId) - Number(b.row.nodeId))
  .map(({ row }) => row);
}

/** When the phase looked for a lost proposal on a bot-claimed node and found none (node #240). */
export const recoverReadKey = (repo: string, nodeId: string) => `ratify-recover.${repo}#${nodeId}`;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One ratify pass's state, shared by the helpers it calls. */
interface RatifyTick {
 ctx: RatifyContext;
 result: RatifyResult;
 now: () => Date;
}

const defaultRelease = (repo: string, nodeId: string, identity: string, token: string) =>
 graphRelease(repo, nodeId, identity, token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS });

export async function ratifyPass(ctx: RatifyContext): Promise<RatifyResult> {
 const { config, journal } = ctx;
 const now = () => ctx.now?.() ?? new Date();
 const result: RatifyResult = { read: [], closing: [], vetoed: [], recovered: [], deferred: [], errors: [] };
 const tick: RatifyTick = { ctx, result, now };
 // Proposals exist only on GitHub maps (node #246).
 const walked = ctx.maps.filter((m) => parseForgeRef(m.map.repo).forge === "github");
 // A lost journal (ruling D1): the bot's open claims with no row, from the
 // last audit, are read for a proposal first, so a recovered one is read this tick.
 const recoverBudget = { left: config.ratify.readsPerTick };
 for (const m of walked) await recoverLost(tick, m, recoverBudget);
 const rowsOf = new Map<WorkerRow, RatifyMap>();
 for (const m of walked) {
  for (const row of journal.listWorkers(m.map.repo, m.map.root)) rowsOf.set(row, m);
 }
 const order = ratifyOrder(journal, [...rowsOf.keys()]);
 const cap = config.ratify.readsPerTick;
 for (const row of order.slice(cap)) result.deferred.push(`${row.repo}#${row.nodeId}`);

 for (const row of order.slice(0, cap)) {
  const m = rowsOf.get(row)!;
  const { map, token, botIdentity } = m;
  const id = `${row.repo}#${row.nodeId}`;
  const port = ctx.portFor(map.repo);
  try {
   // The write identity is the principal's: nothing closes, no veto is posted (D4).
   assertNotPrincipal(config, botIdentity, map.repo);
   const principal = principalLoginForRepo(config, map.repo);
   if (principal === undefined) throw new Error(`no principal login for ${mapKey(map)} — nothing can be ratified`);
   if (port.commentReactions === undefined || port.issueComments === undefined) {
    throw new Error(`the forge port for ${map.repo} reads no reactions`);
   }

   // A veto already stands (a release that failed, a recovered veto): finish it, read nothing.
   const standing = journal.getVeto(row.nodeId, row.repo);
   if (standing !== null) {
    await finishVeto(tick, m, standing);
    continue;
   }
   result.read.push(id);

   let commentId = row.proposalCommentId;
   if (commentId === null) {
    commentId = boundProposalComment(await readComments(port, map.repo, row.nodeId, token), botIdentity, row.nodeId);
    const current = journal.getWorker(row.nodeId, row.repo);
    if (current?.status !== "proposed" || current.proposalCommentId !== null) continue;
    if (commentId === null) {
     const detail = `${PROPOSAL_MISSING}: no comment on #${row.nodeId} by ${botIdentity} carries ${proposalMarker(row.nodeId)} — nothing is closed`;
     journal.updateWorker(row.nodeId, row.repo, { outcome: detail });
     journal.recordEvent("proposal-missing", { nodeId: row.nodeId, repo: row.repo, detail });
     continue;
    }
    journal.updateWorker(row.nodeId, row.repo, { proposalCommentId: commentId });
    journal.recordEvent("proposal-bound", {
     nodeId: row.nodeId,
     repo: row.repo,
     detail: `proposal comment ${commentId}: the newest comment by ${botIdentity} with the proposal marker`,
    });
   }

   const reactions = await port.commentReactions(map.repo, commentId, token);
   // Only a complete read rotates the proposal back; a failed one goes first next tick.
   journal.setHealth(ratifyReadKey(row.repo, row.nodeId), now().toISOString());
   const vetoed = principalVetoed(reactions, principal);
   if (!vetoed && !principalRatified(reactions, principal)) continue;

   // Another pass may have moved the row while the reactions were read.
   const current = journal.getWorker(row.nodeId, row.repo);
   if (current?.status !== "proposed" || current.proposalCommentId !== commentId) continue;
   if (vetoed) {
    await vetoProposal(tick, m, row, commentId, principal);
    continue;
   }
   // The close phase is set before the spawn, so the child never reads a
   // plain `proposed` row and refuses; a tick that dies here leaves the row
   // `proposed`, and the next one reads and spawns it again.
   journal.updateWorker(row.nodeId, row.repo, { phase: "close" });
   const pid = await ctx.spawn(row.nodeId, row.repo, row.root);
   if (pid === null) {
    journal.updateWorker(row.nodeId, row.repo, { phase: null });
    result.errors.push(`#${row.nodeId}: ratified, but the close run-node did not spawn — retrying next tick`);
    continue;
   }
   // The resume-for-close: no LLM session, so it neither counts an attempt
   // nor touches the dead-man counter nor the spawn cap.
   journal.updateWorker(row.nodeId, row.repo, { status: "running", phase: "close", pid, finishedAt: null });
   journal.recordEvent("ratified", {
    nodeId: row.nodeId,
    repo: row.repo,
    detail: `${principal} 👍 on proposal comment ${commentId} — resuming at the close (pid ${pid})`,
   });
   result.closing.push(id);
  } catch (error) {
   // A failed read or write moves nothing: the proposal is read again next tick.
   result.errors.push(`#${row.nodeId}: ratify read failed (${message(error)}) — read again next tick`);
  }
 }
 return result;
}

/**
 * The principal's 👎 (ruling D7): post the veto comment, unless a POST that
 * timed out already landed it, record the veto, then release. The veto is
 * recorded before the release, so a failed release is finished next tick and
 * a node vetoed once is never claimed again.
 */
async function vetoProposal(
 tick: RatifyTick,
 m: RatifyMap,
 row: WorkerRow,
 proposalCommentId: string,
 principal: string,
): Promise<void> {
 const { ctx } = tick;
 const { journal } = ctx;
 const { map, token, botIdentity } = m;
 const port = ctx.portFor(map.repo);
 const landed = boundVeto(await readComments(port, map.repo, row.nodeId, token), botIdentity, row.nodeId);
 let vetoCommentId: string;
 if (landed !== null && landed.proposalCommentId === proposalCommentId) {
  vetoCommentId = landed.commentId;
 } else {
  const posted = await port.postComment(map.repo, Number(row.nodeId), vetoCommentBody(map.repo, row.nodeId, proposalCommentId, principal), token);
  // A comment with no id cannot be rebuilt from: read the comments again next tick.
  if (!Number.isSafeInteger(posted) || posted <= 0) throw new Error(`the veto comment on #${row.nodeId} came back without a comment id`);
  vetoCommentId = String(posted);
 }
 const detail = `${principal} 👎 on proposal comment ${proposalCommentId}`;
 journal.recordVeto({ repo: row.repo, nodeId: row.nodeId, root: row.root, commentId: vetoCommentId, proposalCommentId, detail });
 journal.recordEvent("vetoed", {
  nodeId: row.nodeId,
  repo: row.repo,
  detail: `${detail} — veto comment ${vetoCommentId}; never proposed again`,
 });
 await finishVeto(tick, m, journal.getVeto(row.nodeId, row.repo)!);
}

/** Release the vetoed node's claim, settle its row and edit its card (ruling D7). */
async function finishVeto(tick: RatifyTick, m: RatifyMap, veto: VetoRow): Promise<void> {
 const { ctx, result, now } = tick;
 const { journal } = ctx;
 const { map, token, botIdentity } = m;
 const released = await (ctx.release ?? defaultRelease)(map.repo, veto.nodeId, botIdentity, token);
 const current = journal.getWorker(veto.nodeId, map.repo);
 if (current?.status !== "proposed") return;
 // Soma releases only the machine account's own claim: a refusal means it holds none.
 const claim = released.released ? "claim released" : `no claim to release (${released.assignees.join(", ") || "unclaimed"})`;
 journal.updateWorker(veto.nodeId, map.repo, {
  status: "released",
  phase: null,
  pid: null,
  finishedAt: now().toISOString(),
  outcome: `${VETOED}: ${veto.detail ?? "the principal's 👎"} — ${claim}; refused, yours to take`,
 });
 journal.recordEvent("released", { nodeId: veto.nodeId, repo: map.repo, detail: `vetoed — ${claim}; never proposed again` });
 result.vetoed.push(`${map.repo}#${veto.nodeId}`);
 if (ctx.refuseCard === undefined) return;
 try {
  await ctx.refuseCard(map, veto);
 } catch (error) {
  result.errors.push(`#${veto.nodeId}: vetoed, but the card edit failed (${message(error)}) — the escalation desk edits it on its next pass`);
 }
}

/**
 * A proposal a lost journal dropped (ruling D1): an open node the machine
 * account still claims, with no worker row, whose comments hold the bot's
 * proposal marker. Its row comes back `proposed` with the bound comment id
 * (or the vetoed one, when a veto comment stands, which the loop then
 * finishes). The open claims come from the last audit the walk cached, at
 * most `budget` comment reads per tick; a node with no marker is not read again.
 * A cached audit without `openClaimed` is reported, not passed over: no lost
 * proposal can be found until the walk caches a fresh audit.
 */
async function recoverLost(tick: RatifyTick, m: RatifyMap, budget: { left: number }): Promise<void> {
 const { ctx, result, now } = tick;
 const { journal } = ctx;
 const { map, token, botIdentity } = m;
 const open = cachedOpenClaims(journal, map.repo, map.root);
 if (open === null) return;
 if (open.claims === null) {
  result.errors.push(`${mapKey(map)}: the audit cached at ${open.fetchedAt} carries no openClaimed — lost proposals are not looked for until the walk caches a fresh audit`);
  return;
 }
 const lost = open.claims.filter((claim) =>
  claim.assignees.some((a) => sameLogin(a, botIdentity)) &&
  journal.getWorker(claim.id, map.repo) === null &&
  journal.getHealth(recoverReadKey(map.repo, claim.id)) === null);
 if (lost.length === 0) return;
 try {
  assertNotPrincipal(ctx.config, botIdentity, map.repo);
 } catch (error) {
  result.errors.push(`${mapKey(map)}: proposal recovery skipped (${message(error)})`);
  return;
 }
 const port = ctx.portFor(map.repo);
 for (const claim of lost) {
  const id = `${map.repo}#${claim.id}`;
  if (budget.left <= 0) {
   result.deferred.push(id);
   continue;
  }
  budget.left -= 1;
  try {
   const comments = await readComments(port, map.repo, claim.id, token);
   const proposal = boundProposalComment(comments, botIdentity, claim.id);
   const veto = boundVeto(comments, botIdentity, claim.id);
   // A claim took the node while its comments were read: the row is its.
   if (journal.getWorker(claim.id, map.repo) !== null) continue;
   if (proposal === null && veto === null) {
    journal.setHealth(recoverReadKey(map.repo, claim.id), now().toISOString());
    continue;
   }
   if (veto !== null) recordRecoveredVeto(journal, map, claim.id, veto, botIdentity);
   const commentId = veto?.proposalCommentId ?? proposal!;
   journal.upsertWorker({
    nodeId: claim.id,
    repo: map.repo,
    root: map.root,
    status: "proposed",
    lane: "research",
    attempts: 0,
    finishedAt: now().toISOString(),
    proposalCommentId: commentId,
    outcome: `proposal comment ${commentId}, recovered from GitHub`,
   });
   journal.recordEvent("proposal-recovered", {
    nodeId: claim.id,
    repo: map.repo,
    detail: `proposal comment ${commentId}: the journal had no row for a node ${botIdentity} claims`,
   });
   result.recovered.push(id);
  } catch (error) {
   result.errors.push(`#${claim.id}: proposal recovery read failed (${message(error)}) — read again next tick`);
  }
 }
}

/** One node's comments, from a port that may read none. */
function readComments(port: Pick<ForgePort, "issueComments">, repo: string, nodeId: string, token: string): Promise<IssueComment[]> {
 if (port.issueComments === undefined) throw new Error(`the forge port for ${repo} reads no comments`);
 return port.issueComments(repo, Number(nodeId), token);
}

/** Record a veto read back from the node's comments (ruling D1): the row and its event. */
function recordRecoveredVeto(
 journal: Journal,
 map: RangerMapConfig,
 nodeId: string,
 veto: { commentId: string; proposalCommentId: string },
 botIdentity: string,
): void {
 journal.recordVeto({
  repo: map.repo, nodeId, root: map.root, commentId: veto.commentId, proposalCommentId: veto.proposalCommentId,
  detail: `veto comment ${veto.commentId} on proposal comment ${veto.proposalCommentId}, rebuilt from GitHub`,
 });
 journal.recordEvent("veto-recovered", { nodeId, repo: map.repo, detail: `veto comment ${veto.commentId} by ${botIdentity}` });
}

/**
 * Rebuild vetoes from GitHub before a claim (node #240, rulings D1, D7):
 * each propose research node the walk would claim has its comments read,
 * and a veto comment the machine account wrote is recorded. Read on every
 * claim, not once: a journal restored from a backup must not lose a veto
 * either. The first failed read returns its error, and the caller claims no
 * propose research node on that map this tick.
 */
export async function rebuildVetoes(args: {
 journal: Journal;
 map: RangerMapConfig;
 botIdentity: string;
 token: string;
 port: Pick<ForgePort, "issueComments">;
 nodeIds: readonly string[];
}): Promise<{ rebuilt: string[]; error: string | null }> {
 const { journal, map, botIdentity, token, port } = args;
 const rebuilt: string[] = [];
 for (const nodeId of args.nodeIds) {
  if (journal.hasVeto(nodeId, map.repo)) continue;
  let veto: ReturnType<typeof boundVeto>;
  try {
   veto = boundVeto(await readComments(port, map.repo, nodeId, token), botIdentity, nodeId);
  } catch (error) {
   return { rebuilt, error: `#${nodeId}: ${message(error)}` };
  }
  if (veto === null) continue;
  recordRecoveredVeto(journal, map, nodeId, veto, botIdentity);
  rebuilt.push(nodeId);
 }
 return { rebuilt, error: null };
}

/** A propose research node: its claim waits on a veto read (node #240). */
export const isProposeResearch = (node: ClassifiedNode): boolean =>
 node.route.route === "research" && node.route.ratify === "propose";

/**
 * Gate a tick's propose research claims on a veto read (node #240, rulings
 * D1, D7). Only the propose nodes the tick can reach are read: those the
 * plan takes within the spawn cap's `room`, at most `readsPerTick`. A
 * rebuilt veto lands in the journal, so the plan is made again; a propose
 * node is claimable only if its comments were read this tick and every read
 * answered. A node the second plan brings in, a node past the bounds and
 * every node after a failed read waits for a later tick.
 */
export async function gateProposeReads(args: {
 plan: TickPlan;
 replan: () => TickPlan;
 room: number;
 readsPerTick: number;
 rebuild: (nodeIds: readonly string[]) => Promise<{ rebuilt: string[]; error: string | null }>;
}): Promise<{ plan: TickPlan; claimable: (node: ClassifiedNode) => boolean; errors: string[] }> {
 const reachable = args.plan.take.slice(0, Math.max(0, args.room)).filter(isProposeResearch);
 const toRead = reachable.slice(0, Math.max(0, args.readsPerTick));
 const vetoes = await args.rebuild(toRead.map((n) => n.id));
 const errors: string[] = [];
 if (vetoes.error !== null) {
  errors.push(`veto rebuild failed (${vetoes.error}) — no propose research node claimed this tick`);
 } else if (reachable.length > toRead.length) {
  errors.push(`${reachable.slice(toRead.length).map((n) => `#${n.id}`).join(", ")} past ratify.readsPerTick — veto read and claim deferred to the next tick`);
 }
 const read = new Set(vetoes.error === null ? toRead.map((n) => n.id) : []);
 return {
  plan: vetoes.rebuilt.length === 0 ? args.plan : args.replan(),
  claimable: (node) => !isProposeResearch(node) || read.has(node.id),
  errors,
 };
}

import { principalLoginForRepo, type RangerConfig, type RangerMapConfig } from "./config.ts";
import type { CommentReaction, ForgePort, IssueComment } from "./forge.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { assertNotPrincipal } from "./identity.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { mapKey } from "./maps.ts";

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

/** When the phase last read this proposal; the rotation key (journal `health`). */
export const ratifyReadKey = (repo: string, nodeId: string) => `ratify-read.${repo}#${nodeId}`;

export interface RatifyResult {
 /** `repo#node` of every proposal whose reactions were read. */
 read: string[];
 /** Ratified and resumed at the close. */
 closing: string[];
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
 portFor: (repo: string) => Pick<ForgePort, "issueComments" | "commentReactions">;
 /** Spawn the resume-for-close run-node; null when nothing started. */
 spawn: (nodeId: string, repo: string, root: number) => Promise<number | null>;
 now?: () => Date;
}

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Ruling D6's pin: the principal's `+1`, and no `-1` from the principal. */
export function principalRatified(reactions: readonly CommentReaction[], principal: string): boolean {
 const mine = reactions.filter((r) => sameLogin(r.author, principal));
 return mine.some((r) => r.content === "+1") && !mine.some((r) => r.content === "-1");
}

/**
 * The proposal comment id from the node's comments (ruling D8): the newest
 * comment the machine account wrote that carries this node's marker, else
 * null. Ranger never guesses past that.
 */
export function boundProposalComment(comments: readonly IssueComment[], botIdentity: string, nodeId: string): string | null {
 const marker = proposalMarker(nodeId);
 const bound = comments
  .filter((c) => sameLogin(c.author, botIdentity) && c.body.includes(marker) && Number.isSafeInteger(c.id) && c.id > 0)
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

export async function ratifyPass(ctx: RatifyContext): Promise<RatifyResult> {
 const { config, journal } = ctx;
 const now = () => ctx.now?.() ?? new Date();
 const result: RatifyResult = { read: [], closing: [], deferred: [], errors: [] };
 // Proposals exist only on GitHub maps (node #246).
 const walked = ctx.maps.filter((m) => parseForgeRef(m.map.repo).forge === "github");
 const rowsOf = new Map<WorkerRow, RatifyMap>();
 for (const m of walked) {
  for (const row of journal.listWorkers(m.map.repo, m.map.root)) rowsOf.set(row, m);
 }
 const order = ratifyOrder(journal, [...rowsOf.keys()]);
 const cap = config.ratify.readsPerTick;
 for (const row of order.slice(cap)) result.deferred.push(`${row.repo}#${row.nodeId}`);

 for (const row of order.slice(0, cap)) {
  const { map, token, botIdentity } = rowsOf.get(row)!;
  const id = `${row.repo}#${row.nodeId}`;
  const port = ctx.portFor(map.repo);
  try {
   // The write identity is the principal's: nothing closes (D4).
   assertNotPrincipal(config, botIdentity, map.repo);
   const principal = principalLoginForRepo(config, map.repo);
   if (principal === undefined) throw new Error(`no principal login for ${mapKey(map)} — nothing can be ratified`);
   if (port.commentReactions === undefined || port.issueComments === undefined) {
    throw new Error(`the forge port for ${map.repo} reads no reactions`);
   }
   result.read.push(id);

   let commentId = row.proposalCommentId;
   if (commentId === null) {
    commentId = boundProposalComment(await port.issueComments(map.repo, Number(row.nodeId), token), botIdentity, row.nodeId);
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
   if (!principalRatified(reactions, principal)) continue;

   // Another pass may have moved the row while the reactions were read.
   const current = journal.getWorker(row.nodeId, row.repo);
   if (current?.status !== "proposed" || current.proposalCommentId !== commentId) continue;
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
   // A failed read moves nothing: the proposal is read again next tick.
   result.errors.push(`#${row.nodeId}: ratify read failed (${error instanceof Error ? error.message : String(error)}) — read again next tick`);
  }
 }
 return result;
}

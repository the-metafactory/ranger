import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import { realGitHub, recordedReviews, type GitHubPort } from "./implement.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { evaluateMergeGate } from "./merge-gate.ts";

/**
 * The merge desk (design §4/§5, #23): each tick, every implement-lane row
 * waiting on a merge is re-read from GitHub.
 *
 * - merged → spawn run-node, which resumes at the close phase (F2);
 * - closed unmerged → park (a human declined it; never re-proposed);
 * - open → evaluate the merge gate; on a pass, post the one-tap merge card
 *   ONCE (the card's message id is recorded, and a failed post retries next
 *   tick — a PR nobody knows to merge is the failure this guards against);
 *   a hard gate failure parks with a card; pending waits.
 *
 * Ranger never merges: approver-bot is unprovisioned (node #6/#16), so the
 * principal merges by hand. The review evidence is read from the bot's own
 * markers on the PR, not the journal (the journal is a cache).
 */

export interface MergeDeskContext {
 config: RangerConfig;
 journal: Journal;
 map: RangerMapConfig;
 token: string;
 botIdentity: string;
 github?: GitHubPort;
 /** Post a message to the map's channel; returns the message id. */
 post?: (content: string, label: string) => Promise<string>;
 /** Spawn a detached run-node (the resume-for-close); returns its PID. */
 spawn?: (nodeId: string, repo: string) => Promise<number | null>;
}

export interface MergeDeskResult {
 cards: string[];
 resumed: string[];
 parked: string[];
 pending: string[];
 errors: string[];
}

export async function runMergeDesk(ctx: MergeDeskContext): Promise<MergeDeskResult> {
 const { journal, map, token, botIdentity } = ctx;
 const github = ctx.github ?? realGitHub;
 const repo = map.repo;
 const result: MergeDeskResult = { cards: [], resumed: [], parked: [], pending: [], errors: [] };
 const post =
  ctx.post ??
  ((content: string, label: string) => DiscordAnnouncer.fromMap(map).post(content, label));

 const waiting = journal
  .listWorkers(repo)
  .filter((w) => w.status === "awaiting-merge");

 for (const row of waiting) {
  try {
   await progress(row);
  } catch (error) {
   result.errors.push(
    `#${row.nodeId}: ${error instanceof Error ? error.message : String(error)}`,
   );
  }
 }
 return result;

 async function park(row: WorkerRow, detail: string, title: string): Promise<void> {
  journal.updateWorker(row.nodeId, {
   status: "parked",
   finishedAt: new Date().toISOString(),
   outcome: detail.slice(0, 400),
  });
  journal.recordEvent("parked", { nodeId: row.nodeId, repo, detail: detail.slice(0, 400) });
  result.parked.push(row.nodeId);
  try {
   await post(
    [
     `:ranger: **parked** #${row.nodeId} — ${title}`,
     `map: ${repo}${row.prNumber === null ? "" : ` · PR #${row.prNumber}`}`,
     detail.slice(0, 1500),
    ].join("\n"),
    `park card for #${row.nodeId}`,
   );
  } catch {
   /* the parked row and its event are the durable record */
  }
 }

 async function progress(row: WorkerRow): Promise<void> {
  if (row.prNumber === null) {
   await park(row, "awaiting merge with no PR recorded — journal and GitHub disagree", `node ${row.nodeId}`);
   return;
  }
  const pr = await github.getPr(repo, row.prNumber, token);
  const title = pr.url.length > 0 ? `PR #${pr.number} ${pr.url}` : `PR #${pr.number}`;

  if (pr.merged) {
   if (ctx.spawn === undefined) {
    result.pending.push(row.nodeId);
    return;
   }
   // The resume-for-close: no LLM session, so it neither counts an attempt
   // nor touches the dead-man counter.
   const pid = await ctx.spawn(row.nodeId, repo);
   if (pid === null) {
    result.errors.push(`#${row.nodeId}: merged, but the close run-node did not spawn — retrying next tick`);
    return;
   }
   journal.updateWorker(row.nodeId, { status: "running", phase: "close", pid });
   journal.recordEvent("sweep", {
    nodeId: row.nodeId,
    repo,
    detail: `PR #${pr.number} merged — resuming at the close phase (pid ${pid})`,
   });
   result.resumed.push(row.nodeId);
   return;
  }

  if (pr.state === "closed") {
   await park(row, `PR #${pr.number} was closed without merging — declined; ranger will not reopen or re-propose it`, title);
   return;
  }

  const reviews = recordedReviews(await github.listComments(repo, pr.number, token), botIdentity);
  const last = reviews.find((r) => r.sha === pr.headSha);
  const gate = evaluateMergeGate({
   pr,
   checkRuns: await github.checkRunsFor(repo, pr.headSha, token),
   expectedBase: map.base,
   verdictSha: last?.sha ?? null,
   verdictBlockers: last?.blockers ?? null,
  });

  if (gate.status === "pending") {
   result.pending.push(row.nodeId);
   return;
  }
  if (gate.status === "fail") {
   await park(row, `merge gate failed (${gate.check}): ${gate.reason}`, title);
   return;
  }
  if (row.mergeMessageId !== null) return; // card already up — announce once

  const messageId = await post(
   [
    `:ranger: **merge needed** #${row.nodeId} — ${title}`,
    `map: ${repo}`,
    `Gate passed at \`${gate.headSha.slice(0, 8)}\`: CI green, mergeable, base \`${map.base}\`, sage ${last?.round ?? "?"} round(s) with 0 blockers and ${last?.majors ?? "?"} majors (machine evidence, not a sign-off).`,
    "Merge it by hand (squash). For a `propose` node your merge is the ratification. Ranger closes the node after the merge; it never merges itself.",
   ].join("\n"),
   `merge card for #${row.nodeId}`,
  );
  journal.updateWorker(row.nodeId, { mergeMessageId: messageId });
  journal.recordEvent("merge-card", { nodeId: row.nodeId, repo, detail: `PR #${pr.number}, message ${messageId}` });
  result.cards.push(row.nodeId);
 }
}

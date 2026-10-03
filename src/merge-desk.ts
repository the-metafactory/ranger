import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import {
 gatingFindings,
 realGitHub,
 recordedProbes,
 recordedReviews,
 type GitHubPort,
} from "./implement.ts";
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
 * A PARKED implement-lane PR is watched too, for one event only: the
 * principal merging it anyway (a review-cap park hands good-enough to the
 * principal). The merge resumes the close; nothing else about a parked row
 * changes on its own.
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

/** Rows the desk watches: awaiting a merge, or parked with a PR the principal may still merge. */
export function watchedByMergeDesk(w: WorkerRow): boolean {
 return (
  w.status === "awaiting-merge" ||
  (w.status === "parked" && w.lane === "implement" && w.prNumber !== null)
 );
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
  .filter(watchedByMergeDesk);

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

  // A parked row moves only on a merge.
  if (row.status === "parked") return;

  if (pr.state === "closed") {
   await park(row, `PR #${pr.number} was closed without merging — declined; ranger will not reopen or re-propose it`, title);
   return;
  }

  const comments = await github.listComments(repo, pr.number, token);
  const reviews = recordedReviews(comments, botIdentity);
  const last = reviews.find((r) => r.sha === pr.headSha);
  const probe = recordedProbes(comments, botIdentity).find(
   (p) => p.sha === pr.headSha && p.passed,
  );
  const probesRequired = map.commands.probe !== undefined;

  // Send a ready PR back to run-node when the rules it went ready under no
  // longer hold at its head: the review there still carries gating findings
  // (majors started gating after the PR went ready), or the map now has a
  // probe tier with no passing run recorded. run-node resumes in the review
  // phase: a fix pass and a new round, or only the probe step. The round cap
  // and a failing probe run still park it there. A posted merge card is
  // withdrawn first, so a stale "merge needed" never stands.
  const reworkFindings = last !== undefined && gatingFindings(last) > 0;
  const missingProbes = probesRequired && probe === undefined && last !== undefined;
  if ((reworkFindings || missingProbes) && ctx.spawn !== undefined) {
   const why = reworkFindings
    ? `sage round ${last?.round} at ${pr.headSha.slice(0, 8)} has ${last?.blockers} blocker(s) and ${last?.majors} major(s) to rework`
    : `no passing probe run at ${pr.headSha.slice(0, 8)}`;
   if (row.mergeMessageId !== null) {
    try {
     await post(
      [
       `:ranger: **merge card withdrawn** #${row.nodeId} — ${title}`,
       `Do not merge yet: ${why}. Ranger reworks it; a new merge card follows when the PR is clean.`,
      ].join("\n"),
      `merge card withdrawal for #${row.nodeId}`,
     );
    } catch {
     result.errors.push(`#${row.nodeId}: could not post the card withdrawal — retrying next tick`);
     return;
    }
    journal.updateWorker(row.nodeId, { mergeMessageId: null });
   }
   const pid = await ctx.spawn(row.nodeId, repo);
   if (pid === null) {
    result.errors.push(`#${row.nodeId}: ${why}, but run-node did not spawn — retrying next tick`);
    return;
   }
   journal.updateWorker(row.nodeId, { status: "running", phase: "review", pid });
   journal.recordEvent("sweep", {
    nodeId: row.nodeId,
    repo,
    detail: `PR #${pr.number}: ${why} — run-node resumes (pid ${pid})`,
   });
   result.resumed.push(row.nodeId);
   return;
  }
  const gate = evaluateMergeGate({
   pr,
   checkRuns: await github.checkRunsFor(repo, pr.headSha, token),
   expectedBase: map.base,
   verdictSha: last?.sha ?? null,
   verdictBlockers: last?.blockers ?? null,
   verdictMajors: last?.majors ?? null,
   probesRequired,
   probePassedSha: probe?.sha ?? null,
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
    `Gate passed at \`${gate.headSha.slice(0, 8)}\`: CI green, mergeable, base \`${map.base}\`, sage ${last?.round ?? "?"} round(s), the last with 0 blockers and 0 majors (machine evidence, not a sign-off).`,
    ...(probesRequired
     ? [`Probes passed at \`${gate.headSha.slice(0, 8)}\` (selection ${probe?.mode ?? "?"}, ${probe?.selected ?? "?"} probe(s)). Only the selected probes ran, not the full suite.`]
     : ["No probe tier on this map: CI and the tests are the only automated checks."]),
    "Merge it by hand (squash). For a `propose` node your merge is the ratification. Ranger closes the node after the merge; it never merges itself.",
   ].join("\n"),
   `merge card for #${row.nodeId}`,
  );
  journal.updateWorker(row.nodeId, { mergeMessageId: messageId });
  journal.recordEvent("merge-card", { nodeId: row.nodeId, repo, detail: `PR #${pr.number}, message ${messageId}` });
  result.cards.push(row.nodeId);
 }
}

import { implementLane } from "./lanes.ts";
import { recordImplementStart, mapKey } from "./maps.ts";
import { ClaimLeaseLost, ClaimLockBusy, withClaimLock } from "./claim-lock.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import type { DiscordFile } from "./discord.ts";
import { redactViewsReason, viewsCard, viewsCardMessage, viewsDirectory } from "./views.ts";
import { NEEDS_EYE_LABEL } from "./labels.ts";
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
 post?: (content: string, label: string, files?: readonly DiscordFile[], embeds?: readonly { description: string }[]) => Promise<string>;
 /** Spawn a detached run-node (the resume-for-close); returns its PID. */
 spawn?: (nodeId: string, repo: string, root: number) => Promise<number | null>;
}

export interface MergeDeskResult {
 cards: string[];
 /** PRs ranger squash-merged itself (autoMerge maps, no needs-eye label). */
 merged: string[];
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
 const result: MergeDeskResult = { cards: [], merged: [], resumed: [], parked: [], pending: [], errors: [] };
 let announcer: DiscordAnnouncer | undefined;
 const post =
  ctx.post ??
  ((content: string, label: string, files?: readonly DiscordFile[], embeds?: readonly { description: string }[]) =>
   (announcer ??= DiscordAnnouncer.fromMap(map)).post(content, label, files, embeds));

 const waiting = journal
  .listWorkers(repo, map.root)
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
  journal.updateWorker(row.nodeId, repo, {
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
     `map: ${mapKey(map)}${row.prNumber === null ? "" : ` · PR #${row.prNumber}`}`,
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
   const pid = await ctx.spawn(row.nodeId, repo, row.root);
   if (pid === null) {
    result.errors.push(`#${row.nodeId}: merged, but the close run-node did not spawn — retrying next tick`);
    return;
   }
   journal.updateWorker(row.nodeId, repo, { status: "running", phase: "close", pid });
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
    journal.updateWorker(row.nodeId, repo, { mergeMessageId: null });
   }
   // A send-back starts a worker session (fix pass or probes): it waits for
   // the implement lane like any other start. The stale card is already gone.
   // The lane is read and taken under the claim lock (node #58), as the walk
   // and `ranger build-now` take it, so a claim that read the lane empty is
   // not joined by a send-back before its row holds it.
   const spawnSendBack = ctx.spawn;
   const lane = implementLane(map);
   try {
    await withClaimLock(journal, async (owned) => {
     const holder = journal.laneHolder(lane, { nodeId: row.nodeId, repo });
     if (holder !== null) {
      result.pending.push(row.nodeId);
      journal.recordEvent("sweep", {
       nodeId: row.nodeId,
       repo,
       detail: `PR #${pr.number}: ${why} — waiting for the ${lane} implement lane (held by #${holder.nodeId}, ${mapKey(holder)})`,
      });
      return;
     }
     owned();
     const pid = await spawnSendBack(row.nodeId, repo, row.root);
     if (pid === null) {
      result.errors.push(`#${row.nodeId}: ${why}, but run-node did not spawn — retrying next tick`);
      return;
     }
     journal.updateWorker(row.nodeId, repo, { status: "running", phase: "review", pid });
     recordImplementStart(journal, map);
     journal.recordEvent("sweep", {
      nodeId: row.nodeId,
      repo,
      detail: `PR #${pr.number}: ${why} — run-node resumes (pid ${pid})`,
     });
     result.resumed.push(row.nodeId);
    });
   } catch (error) {
    if (!(error instanceof ClaimLockBusy) && !(error instanceof ClaimLeaseLost)) throw error;
    result.errors.push(`#${row.nodeId}: ${why}, but ${error.message} — retrying next tick`);
   }
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

  // Auto-merge (principal, 2026-10-03): on a map that opts in, ranger
  // squash-merges the gate-passed PR itself, pinned to the gated head, unless
  // the node is labelled ranger:needs-eye. The close follows on this tick.
  let needsEye = false;
  if (map.autoMerge || map.commands.views) {
   try {
    needsEye = (await github.issueLabels(repo, Number(row.nodeId), token)).includes(NEEDS_EYE_LABEL);
   } catch (error) {
    if (map.autoMerge) throw error;
    // On manual maps labels only select evidence; an outage must not suppress the card.
    journal.recordEvent("merge-card", {
     nodeId: row.nodeId, repo,
     detail: `label lookup failed (informational): ${redactViewsReason(String(error), process.env).slice(-500)}`,
    });
   }
  }
  if (map.autoMerge && !needsEye) {
   await github.mergePr(repo, pr.number, gate.headSha, pr.title, token);
   journal.recordEvent("merged", {
    nodeId: row.nodeId,
    repo,
    detail: `PR #${pr.number} squash-merged by ranger at ${gate.headSha.slice(0, 8)} (no ${NEEDS_EYE_LABEL} label; standing grant 2026-10-03)`,
   });
   result.merged.push(row.nodeId);
   try {
    await post(
     [
      `:ranger: **merged** #${row.nodeId} — ${title}`,
      `Gate passed at \`${gate.headSha.slice(0, 8)}\` (CI, mergeable, sage 0 blockers / 0 majors${probesRequired ? ", probes" : ""}); squash-merged by ranger. The node closes through the gate next.`,
     ].join("\n"),
     `merge notice for #${row.nodeId}`,
    );
   } catch {
    /* the merged PR and the event are the record */
   }
   if (ctx.spawn !== undefined) {
    const pid = await ctx.spawn(row.nodeId, repo, row.root);
    if (pid !== null) {
     journal.updateWorker(row.nodeId, repo, { status: "running", phase: "close", pid });
     result.resumed.push(row.nodeId);
    }
   }
   return;
  }

  const content = [
    `:ranger: **merge needed** #${row.nodeId} — ${title}`,
    `map: ${mapKey(map)}`,
    `Gate passed at \`${gate.headSha.slice(0, 8)}\`: CI green, mergeable, base \`${map.base}\`, sage ${last?.round ?? "?"} round(s), the last with 0 blockers and 0 majors (machine evidence, not a sign-off).`,
    ...(probesRequired
     ? [`Probes passed at \`${gate.headSha.slice(0, 8)}\` (selection ${probe?.mode ?? "?"}, ${probe?.selected ?? "?"} probe(s)). Only the selected probes ran, not the full suite.`]
     : ["No probe tier on this map: CI and the tests are the only automated checks."]),
    needsEye
     ? `Labelled \`${NEEDS_EYE_LABEL}\`: your eye is the check. Merge it by hand (squash); ranger closes the node after the merge.`
     : "Merge it by hand (squash). For a `propose` node your merge is the ratification. Ranger closes the node after the merge; it never merges itself.",
   ].join("\n");
  let evidence: Awaited<ReturnType<typeof viewsCard>> | undefined;
  if (needsEye && map.commands.views) {
   try { evidence = await viewsCard(viewsDirectory(journal.path, repo, row.nodeId, gate.headSha), gate.headSha); }
   catch (error) { evidence = { summary: `Sheet could not be made: ${redactViewsReason(String(error), process.env)}`, files: [] }; }
  }
  const message = viewsCardMessage(content, evidence);
  const label = `merge card for #${row.nodeId}`;
  let messageId: string;
  try {
   messageId = await post(message.content, label, message.files, message.embeds);
  } catch (error) {
   if (!message.files?.length && !message.embeds?.length) throw error;
   const reason = redactViewsReason(String(error), process.env).slice(-500);
   journal.recordEvent("merge-card", {
    nodeId: row.nodeId, repo, detail: `views delivery failed (informational): ${reason}`,
   });
   messageId = await post(
    `${content}\nVisual evidence could not be delivered: ${reason}. See the PR views comment for the diff and full local sheet.`.slice(0, 2000),
    label,
   );
  }
  journal.updateWorker(row.nodeId, repo, { mergeMessageId: messageId });
  journal.recordEvent("merge-card", { nodeId: row.nodeId, repo, detail: `PR #${pr.number}, message ${messageId}` });
  result.cards.push(row.nodeId);
 }
}

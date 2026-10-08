import { implementLane } from "./lanes.ts";
import { recordImplementStart, mapKey } from "./maps.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { DiscordAnnouncer } from "./announce.ts";
import type { DiscordFile } from "./discord.ts";
import { redactViewsReason, viewsCard, viewsCardMessage, viewsDirectory } from "./views.ts";
import { NEEDS_EYE_LABEL } from "./labels.ts";
import {
 baseRedNote,
 gatingFindings,
 realGitHub,
 recordedProbes,
 recordedReviews,
 reviewAtHead,
 supersededNote,
} from "./implement.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { evaluateMergeGate, type MergeGateInput, type MergeGateResult } from "./merge-gate.ts";
import type { IssueComment, ChangeRequest, CiVerdict, ForgePort } from "./forge.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { gitlabForgePort } from "./gitlab.ts";
import { CI_FAILED_PARK_OUTCOME, mergeGateFailedOutcome } from "./outcomes.ts";

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
 * principal). The merge resumes the close. One park moves on its own: a park
 * on CI alone (node #104). Once the full gate passes at the live head, the row
 * goes back to awaiting-merge and takes the ordinary merge path. That needs
 * the review and probe certification recorded at that head, and no
 * ranger:needs-eye label. A merge-only move starts no worker session, so the
 * implement lane is never consulted. Anything short of that leaves it parked
 * quietly, with no send-back, no spawn and no new park card.
 *
 * On a GitLab map (node #126) the desk holds the GitLab port. A project under
 * `rebase_merge` may answer `needs-rebase`: once the rest of the gate passes
 * and ranger would merge, it rebases and stops, and the new head is re-gated
 * (a fresh review round, since a review never carries across a rebase). The
 * merge is squashed and pinned to the gated head, and a project whose squash
 * option is `never` parks with a card before any write.
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
 github?: ForgePort;
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

type Review = ReturnType<typeof recordedReviews>[number];
type Probe = ReturnType<typeof recordedProbes>[number];

/**
 * Ranger's standing review and passing probe run recorded at exactly
 * `headSha`. A clean round that set aside an older same-head major (node
 * #106) is named in `superseded`: the reviewer may have missed it, so
 * auto-merge holds and the manual card names it for the principal to check.
 */
function headEvidence(
 comments: IssueComment[],
 headSha: string,
 botIdentity: string,
): { last?: Review; probe?: Probe; superseded: string | null; latestSha: string | null } {
 const reviews = recordedReviews(comments, botIdentity);
 return {
  last: reviewAtHead(reviews, headSha),
  probe: recordedProbes(comments, botIdentity).find((p) => p.sha === headSha && p.passed),
  superseded: supersededNote(reviews, headSha),
  latestSha: reviews.at(-1)?.sha ?? null,
 };
}

/**
 * The forge port for a map: GitLab's for `gitlab:` maps (made per pass, so
 * its read gate runs fresh), GitHub's otherwise.
 */
export function deskPort(config: RangerConfig, map: RangerMapConfig): ForgePort {
 return parseForgeRef(map.repo).forge === "gitlab" ? gitlabForgePort(config) : realGitHub;
}

const REBASED_FROM = /^from=([0-9a-f]{7,64})\b/;

/** The head ranger last asked the forge to rebase this node's change request from, if any. */
function lastRebaseFrom(journal: Journal, repo: string, nodeId: string): string | null {
 const event = journal.listNodeEvents(repo, nodeId).find((e) => e.kind === "rebased");
 return event === undefined ? null : (REBASED_FROM.exec(event.detail ?? "")?.[1] ?? null);
}

function gateInput(map: RangerMapConfig, pr: ChangeRequest, ci: CiVerdict, last?: Review, probe?: Probe): MergeGateInput {
 return {
  pr,
  ci,
  expectedBase: map.base,
  verdictSha: last?.sha ?? null,
  verdictBlockers: last?.blockers ?? null,
  verdictMajors: last?.majors ?? null,
  probesRequired: map.commands.probe !== undefined,
  probePassedSha: probe?.sha ?? null,
 };
}

/**
 * The desk's merge gate for one PR, read live: CI, mergeability, base, and
 * ranger's review and probe run at the live head. `ranger merge-gate` runs
 * it for the dashboard, so a dashboard merge of an awaiting-merge row passes
 * the same gate the desk holds a merge card behind. Reads only.
 */
export async function mergeGateNow(
 github: ForgePort,
 map: RangerMapConfig,
 prNumber: number,
 token: string,
 botIdentity: string,
): Promise<MergeGateResult> {
 const pr = await github.getPr(map.repo, prNumber, token);
 if (pr.state !== "open") return evaluateMergeGate(gateInput(map, pr, { state: "pending", reason: "not read" }));
 const { last, probe } = headEvidence(await github.listComments(map.repo, prNumber, token), pr.headSha, botIdentity);
 return evaluateMergeGate(gateInput(map, pr, await github.ciVerdictFor(map.repo, pr.headSha, token), last, probe));
}

/** Rows the desk watches: awaiting a merge, or parked with a PR the principal may still merge. */
export function watchedByMergeDesk(w: WorkerRow): boolean {
 return (
  w.status === "awaiting-merge" ||
  (w.status === "parked" && w.lane === "implement" && w.prNumber !== null)
 );
}

/** A row the merge desk parked on CI alone, in its awaiting-merge phase (node #104). */
export function ciOnlyPark(w: WorkerRow): boolean {
 return (
  w.status === "parked" &&
  w.lane === "implement" &&
  w.phase === "awaiting-merge" &&
  CI_FAILED_PARK_OUTCOME.test(w.outcome ?? "")
 );
}

export async function runMergeDesk(ctx: MergeDeskContext): Promise<MergeDeskResult> {
 const { journal, map, token, botIdentity } = ctx;
 const github = ctx.github ?? deskPort(ctx.config, map);
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
  const title = pr.webUrl.length > 0 ? `PR #${pr.iid} ${pr.webUrl}` : `PR #${pr.iid}`;

  if (pr.state === "merged") {
   if (ctx.spawn === undefined) {
    result.pending.push(row.nodeId);
    return;
   }
   // Another desk pass (the tick's, or the dashboard's `merge-desk` after a
   // merge) may have started the close while the PR was read: read the row
   // again, so one merge spawns one close.
   const now = journal.getWorker(row.nodeId, repo);
   if (now === null || !watchedByMergeDesk(now)) return;
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
    detail: `PR #${pr.iid} merged — resuming at the close phase (pid ${pid})`,
   });
   result.resumed.push(row.nodeId);
   return;
  }

  // A parked row moves only on a merge, or (a CI-only park) on CI recovering.
  const ciPark = row.status === "parked" && ciOnlyPark(row);
  if (row.status === "parked" && (!ciPark || pr.state === "closed")) return;

  if (pr.state === "closed") {
   await park(row, `PR #${pr.iid} was closed without merging — declined; ranger will not reopen or re-propose it`, title);
   return;
  }

  const { last, probe, superseded, latestSha } = headEvidence(await github.listComments(repo, pr.iid, token), pr.headSha, botIdentity);
  const probesRequired = map.commands.probe !== undefined;

  // Send a ready PR back to run-node when the rules it went ready under no
  // longer hold at its head: the review there still carries gating findings
  // (majors started gating after the PR went ready), the map now has a
  // probe tier with no passing run recorded, or the base moved and the PR
  // now conflicts with it (GitHub runs no CI on it then, seelite #692).
  // run-node resumes in the review phase: a fix pass and a new round, only
  // the probe step, or a base merge pass and a new round. The round cap, a
  // failing probe run and a conflict that outlasts its merge passes still
  // park it there. A posted merge card is withdrawn first, so a stale
  // "merge needed" never stands.
  const reworkFindings = last !== undefined && gatingFindings(last) > 0;
  const conflicting = last !== undefined && pr.mergeState === "conflict";
  const missingProbes = probesRequired && probe === undefined && last !== undefined;
  // Ranger rebased the reviewed head (a forge under rebase_merge asked): the
  // new head has no review, so it is re-gated by a fresh round, not parked.
  // The review never carries across the rebase: the gate binds to its head.
  const rebaseFrom = last === undefined ? lastRebaseFrom(journal, repo, row.nodeId) : null;
  const rebased = rebaseFrom !== null && rebaseFrom === latestSha && rebaseFrom !== pr.headSha;
  const sendBack = reworkFindings || conflicting || missingProbes || rebased;
  // A send-back is a worker session; a CI-only park never starts one.
  if (ciPark && sendBack) return;
  if (sendBack && ctx.spawn !== undefined) {
   const why = reworkFindings
    ? `sage round ${last?.round} at ${pr.headSha.slice(0, 8)} has ${last?.blockers} blocker(s) and ${last?.majors} major(s) to rework`
    : conflicting
     ? `PR #${pr.iid} conflicts with ${map.base} at ${pr.headSha.slice(0, 8)}`
     : rebased
      ? `ranger rebased PR #${pr.iid} from ${rebaseFrom.slice(0, 8)}; the new head ${pr.headSha.slice(0, 8)} has no review yet`
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
   const lane = implementLane(map);
   const holder = journal.laneHolder(lane, { nodeId: row.nodeId, repo });
   if (holder !== null) {
    result.pending.push(row.nodeId);
    journal.recordEvent("sweep", {
     nodeId: row.nodeId,
     repo,
     detail: `PR #${pr.iid}: ${why} — waiting for the ${lane} implement lane (held by #${holder.nodeId}, ${mapKey(holder)})`,
    });
    return;
   }
   const pid = await ctx.spawn(row.nodeId, repo, row.root);
   if (pid === null) {
    result.errors.push(`#${row.nodeId}: ${why}, but run-node did not spawn — retrying next tick`);
    return;
   }
   journal.updateWorker(row.nodeId, repo, { status: "running", phase: "review", pid });
   recordImplementStart(journal, map);
   journal.recordEvent("sweep", {
    nodeId: row.nodeId,
    repo,
    detail: `PR #${pr.iid}: ${why} — run-node resumes (pid ${pid})`,
   });
   result.resumed.push(row.nodeId);
   return;
  }
  // A forge that asks for a rebase (GitLab under rebase_merge) is gated on
  // everything else first: ranger rebases only a change it would merge.
  const needsRebase = pr.mergeState === "needs-rebase" && github.rebasePr !== undefined;
  const gated = needsRebase ? { ...pr, mergeState: "mergeable" as const } : pr;
  const gate = evaluateMergeGate(gateInput(map, gated, await github.ciVerdictFor(repo, pr.headSha, token), last, probe));

  // A CI-only park stays parked, quietly, until the whole gate passes.
  if (ciPark && gate.status !== "pass") return;
  if (gate.status === "pending") {
   result.pending.push(row.nodeId);
   return;
  }
  if (gate.status === "fail") {
   await park(row, mergeGateFailedOutcome(gate), title);
   return;
  }
  if (!ciPark && row.mergeMessageId !== null) return; // card already up — announce once

  // Auto-merge (principal, 2026-10-03): on a map that opts in, ranger
  // squash-merges the gate-passed PR itself, pinned to the gated head, unless
  // the node is labelled ranger:needs-eye. The close follows on this tick.
  // A CI-only park always reads the labels: needs-eye keeps it parked.
  let needsEye = false;
  if (ciPark || map.autoMerge || map.commands.views) {
   try {
    needsEye = (await github.issueLabels(repo, Number(row.nodeId), token)).includes(NEEDS_EYE_LABEL);
   } catch (error) {
    if (ciPark || map.autoMerge) throw error;
    // On manual maps labels only select evidence; an outage must not suppress the card.
    journal.recordEvent("merge-card", {
     nodeId: row.nodeId, repo,
     detail: `label lookup failed (informational): ${redactViewsReason(String(error), process.env).slice(-500)}`,
    });
   }
  }
  if (ciPark) {
   if (needsEye) return;
   journal.updateWorker(row.nodeId, repo, { status: "awaiting-merge", finishedAt: null, outcome: null });
   journal.recordEvent("sweep", {
    nodeId: row.nodeId,
    repo,
    detail: `PR #${pr.iid}: CI recovered at ${gate.headSha.slice(0, 8)}, the gate passes there — the CI-only park returns to awaiting-merge (no worker, no lane)`,
   });
   if (row.mergeMessageId !== null) return; // its card is still up
  }
  if (map.autoMerge && !needsEye && superseded === null) {
   // Ranger merges only squashed: a project that forbids it escalates before any write.
   const squashRefusal = github.squashRefusal === undefined ? null : await github.squashRefusal(repo, token);
   if (squashRefusal !== null) {
    await park(row, `${squashRefusal}. Merge it by hand, or allow squash on the project.`, title);
    return;
   }
   if (needsRebase && github.rebasePr !== undefined) {
    // Rebase, then stop: the new head is re-gated on a later pass, never merged in this one.
    const rebase = await github.rebasePr(repo, pr.iid, token);
    if (rebase.status === "not-mergeable") {
     await park(row, rebase.reason, title);
     return;
    }
    journal.recordEvent("rebased", {
     nodeId: row.nodeId,
     repo,
     detail: `from=${gate.headSha} ${rebase.status === "head-moved" ? `to=${rebase.headSha}` : `(${rebase.reason})`}: PR #${pr.iid} rebased by ranger onto ${map.base}; the head moved, so it is re-gated there`,
    });
    result.pending.push(row.nodeId);
    return;
   }
   const merge = (await github.mergePr(repo, pr.iid, gate.headSha, pr.title, token)) ?? { status: "merged" as const };
   if (merge.status === "head-moved") {
    journal.recordEvent("sweep", { nodeId: row.nodeId, repo, detail: `PR #${pr.iid}: nothing merged, ${merge.reason}; re-gating the new head` });
    result.pending.push(row.nodeId);
    return;
   }
   if (merge.status !== "merged") {
    await park(row, merge.reason, title);
    return;
   }
   journal.recordEvent("merged", {
    nodeId: row.nodeId,
    repo,
    detail: `PR #${pr.iid} squash-merged by ranger at ${gate.headSha.slice(0, 8)} (no ${NEEDS_EYE_LABEL} label; standing grant 2026-10-03)`,
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
    ...(superseded !== null
     ? [`Note: ${superseded}; the reviewer may have missed it, check before you merge.${map.autoMerge ? " Auto-merge is held on this head for that reason." : ""}`]
     : []),
    ...(needsRebase ? [`The forge asks for a rebase first: rebase the MR onto \`${map.base}\`, then merge it.`] : []),
    ...(probesRequired
     ? [`Probes passed at \`${gate.headSha.slice(0, 8)}\` (selection ${probe?.mode ?? "?"}, ${probe?.selected ?? "?"} probe(s)). Only the selected probes ran, not the full suite.${baseRedNote(probe)}`]
     : ["No probe tier on this map: CI and the tests are the only automated checks."]),
    needsEye
     ? `Labelled \`${NEEDS_EYE_LABEL}\`: your eye is the check. Merge it by hand (squash); ranger closes the node after the merge.`
     : `Merge it by hand (squash). For a \`propose\` node your merge is the ratification. Ranger closes the node after the merge; ${map.autoMerge ? "it does not merge this one itself" : "it never merges itself"}.`,
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
  journal.recordEvent("merge-card", { nodeId: row.nodeId, repo, detail: `PR #${pr.iid}, message ${messageId}${superseded !== null ? `; ${superseded}` : ""}` });
  result.cards.push(row.nodeId);
 }
}

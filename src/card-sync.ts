import { EscalationDiscord, DiscordMessageGoneError } from "./discord.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal, EscalationRow } from "./journal.ts";
import { ESCALATE_REASONS, type ClassifiedNode } from "./route.ts";
import { LeaseLostError, type OwnedCheck } from "./lock.ts";
import { assertReadOnlyToken, type ResolvedToken } from "./token-gate.ts";

/** The per-tick request budget (round-21) — split into two lanes so NEITHER
 *  starves the other (round-33 review): the ACTIVE pass caps at
 *  MAX_CARDS_PER_TICK - ABSENT_RESERVE, and the ABSENT-card reconciliation
 *  is guaranteed ABSENT_RESERVE ops per tick regardless of active-card
 *  churn, so an obsolete actionable card is always eventually reconciled
 *  ("no absent card starves" holds). The total per-tick bound is still
 *  MAX_CARDS_PER_TICK (50). */
export const MAX_CARDS_PER_TICK = 50;
export const ABSENT_RESERVE = 5;
export const ACTIVE_CARD_CAP = MAX_CARDS_PER_TICK - ABSENT_RESERVE;
/** Bounded total rows the absent-card reconciliation may scan (raw keyset
 *  pages, no SQL exclusion — round-36) — a large drain must not walk the
 *  whole journal (round-27 review). */
export const MAX_ABSENT_SCAN = 500;

/**
 * Card sync + reconciliation (design §5) — extracted from escalate.ts
 * (round-37 maintainability finding): card rendering, the post/edit/recover
 * lifecycle, the active-page sync, and absent-card reconciliation, plus the
 * shared desk-context resolution. The public orchestration (per-map pass,
 * daily digest) lives in escalate.ts.
 */

// ---- card content ----

const CARD_HEADS: Record<string, string> = {
  grilling: "🧭 **Decision needed**",
  prototype: "🖼️ **Handoff**",
  propose: "🤔 **HITL decision**",
  approve: "🔔 **Approve** (notification)",
  untyped: "⚠️ **Needs typing**",
  "hitl-kind-as-auto": "🧹 **Map hygiene**",
  provisioning: "🔧 **Provisioning needed**",
};

function cardHead(node: ClassifiedNode): string {
  if (node.route.route === "provisioning") return CARD_HEADS.provisioning;
  if (node.route.route === "escalate-hitl") {
    if (node.kind === "grilling") return CARD_HEADS.grilling;
    if (node.kind === "prototype") return CARD_HEADS.prototype;
    if (node.route.reason === "untyped") return CARD_HEADS.untyped;
    if (node.route.reason === "hitl-kind-as-auto")
      return CARD_HEADS["hitl-kind-as-auto"];
    if (node.autonomy === "approve") return CARD_HEADS.approve;
    return CARD_HEADS.propose;
  }
  return "ℹ️";
}

/** Age band (design §5): shown from day 1, louder at 3+, @-mention at 7+. */
type AgeBand = "fresh" | "aging" | "overdue";

export function ageBand(ageDays: number): AgeBand {
  if (ageDays >= 7) return "overdue";
  if (ageDays >= 3) return "aging";
  return "fresh";
}

/** Host-local YYYY-MM-DD — the digest cache key and date must match the
 * launchd schedule (host-local 07:30), not the UTC calendar day. */
export function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Label a digest run honestly: fresh post | in-place edit | no-op. */
export function digestAction(
  posted: boolean,
  edited: boolean,
): "posted" | "edited" | "unchanged" {
  if (posted) return "posted";
  if (edited) return "edited";
  return "unchanged";
}

/** Collapse prose to one line, truncating at `max` chars. */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Inert a `<` in graph-derived text so Discord cannot parse mention/emoji
 * tokens out of it (a node title could otherwise embed `<@principal-id>` and
 * force a ping outside the 7-day policy, or `<@&role>`). `‹` reads like `<`
 * but is not mention syntax.
 */
export function sanitizeGraphText(text: string | null | undefined): string {
  return (text ?? "").replace(/</g, "\u2039");
}

function ageSuffix(
  ageDays: number,
  principal: string,
  principalDiscordId?: string,
): string {
  if (ageBand(ageDays) === "overdue") {
    // A real Discord ping needs `<@id>` in content; the id is allow-listed
    // in allowed_mentions. Without a configured id, the mention is inert text.
    return principalDiscordId === undefined
      ? `📣 @${principal} **${ageDays}d** — needs your attention ` +
          "(no ping — configure principal.discordId)"
      : `📣 <@${principalDiscordId}> **${ageDays}d** — needs your attention`;
  }
  if (ageBand(ageDays) === "aging") {
    return (
      `⚠️ **${ageDays}d** — aging; blocked-descendant count unavailable ` +
      "(read-only surface can't enumerate blocked nodes)"
    );
  }
  return `· ${ageDays}d`;
}

/** Route-specific card framing: the mention-inerted head/map/url/checkpoint
 *  prefix plus (for provisioning cards) the blocked-probe registration lines. */
function cardFraming(
  node: ClassifiedNode,
  map: { repo: string },
): {
  prefixLines: string[];
  probeLines: string[];
} {
  const reason = sanitizeGraphText(
    node.route.route === "escalate-hitl"
      ? ESCALATE_REASONS[node.route.reason]
      : "auto node with registry-blocked probes — provisioning needed",
  );
  const probeLines =
    node.route.route === "provisioning" && node.blockedProbes !== undefined
      ? [
          "register these in the probe registry (run + cwd must match exactly):",
          ...node.blockedProbes
            .slice(0, 6)
            .map((p) =>
              p.type === "command"
                ? `  · command: run \`${sanitizeGraphText(p.run)}\` · cwd \`${sanitizeGraphText(p.cwd)}\``
                : `  · url host: \`${sanitizeGraphText(p.host)}\` (target \`${sanitizeGraphText(p.target)}\`)`,
            ),
          ...(node.blockedProbes.length > 6
            ? [`  · … and ${node.blockedProbes.length - 6} more probes`]
            : []),
        ]
      : [];
  const prefixLines = [
    // Every graph-derived interpolation is mention-inerted (a graph author
    // can set kind/autonomy/title/url to `<@principal-id>`), and the title
    // is capped so a giant title can't evict the decision body or the suffix.
    `${cardHead(node)} — **#${sanitizeGraphText(node.id)}** ${truncate(sanitizeGraphText(node.title), 200)}`,
    `map: ${map.repo} · ${sanitizeGraphText(node.kind)} · ${sanitizeGraphText(node.autonomy)}`,
    `url: ${sanitizeGraphText(node.url)}`,
    node.checkpointId !== undefined && node.checkpointId.length > 0
      ? `checkpoint: \`${sanitizeGraphText(node.checkpointId)}\``
      : null,
    reason ? `_${reason}_` : null,
  ].filter((line): line is string => line !== null);
  return { prefixLines, probeLines };
}

/** The decision body, budgeted to the room the rest of the card leaves up to
 *  Discord's 2000-char message cap (an arbitrary small cap would drop options
 *  sooner) and truncated with an explicit `…` — never silently. The `url:`
 *  line is the graph node's reference; whether it renders the full body is
 *  the graph surface's job, not ranger's. */
function renderBoundedBody(
  bodyText: string | null,
  prefixLines: string[],
  suffix: string,
  kind: string,
): string | null {
  if (bodyText === null) return null;
  const bodyBudget = 1950 - prefixLines.join("\n").length - suffix.length - 8;
  return `_${truncate(
    bodyText,
    kind === "grilling" ? Math.max(120, bodyBudget) : 140,
  )}_`;
}

function cardContent(
  node: ClassifiedNode,
  map: { repo: string },
  ageDays: number,
  principal: string,
  principalDiscordId?: string,
): string {
  const { prefixLines, probeLines } = cardFraming(node, map);
  const bodyText =
    node.route.route === "escalate-hitl" &&
    node.body !== undefined &&
    node.body.trim().length > 0
      ? sanitizeGraphText(node.body)
      : null;
  const suffix = ageSuffix(ageDays, principal, principalDiscordId);
  const bodyLine = renderBoundedBody(bodyText, prefixLines, suffix, node.kind);
  const lines = [...prefixLines, bodyLine, ...probeLines, suffix].filter(
    (line): line is string => line !== null,
  );
  // Discord rejects >2000-char messages. Cap the FRONT of the card (graph
  // fields + body) so the trailing suffix — which carries the 7-day `<@id>`
  // mention — always survives: a long graph title can never strip the ping.
  const joined = lines.join("\n");
  const suffixLength = suffix.length;
  const front = joined.slice(0, joined.length - suffixLength);
  const maxFront = 1949 - suffixLength - 1;
  if (joined.length <= 1950) return joined;
  const frontCapped =
    front.length > maxFront ? `${front.slice(0, maxFront - 1)}…` : front;
  return `${frontCapped}\n${suffix}`;
}

// ---- the cards run ----

export interface EscalationCard {
  nodeId: string;
  title: string;
  kind: string;
  autonomy: string;
  url: string;
  checkpointId?: string;
  route: string;
  reason?: string;
  ageDays: number;
  status: "open" | "closed";
  createdAt: string;
  messageId: string;
}

export interface EscalateMapResult {
  repo: string;
  /** discriminates cards-pass results from digest results in renderers. */
  kind: "cards";
  ok: boolean;
  error?: string;
  /** Node ids whose card was posted fresh (announce-once). */
  posted: string[];
  /** Node ids whose card was edited in place (edit-not-repost). */
  edited: string[];
  /**
   * Node ids whose card was deferred because this tick's request budget ran
   * out (round-21 bound) — the card is still open and still needs a request;
   * it is served on a later tick. Not an error and not a resolution.
   */
  deferred: string[];
  /**
   * Node ids whose node left the HITL/provisioning queue: the card was
   * edited to a "no longer on queue" note but KEPT open — cards persist
   * until a principal response or operator verb resolves them (design §5).
   */
  keptOpen: string[];
  /** Per-card transient failures (e.g. Discord 429) — retried next tick. */
  cardErrors: string[];
  cards: EscalationCard[];
}

export interface EscalateResult {
  generatedAt: string;
  maps: EscalateMapResult[];
}

export function dayDiff(fromIso: string, now: Date): number {
  const from = new Date(fromIso);
  const fromDay = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  );
  const nowDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.floor((nowDay - fromDay) / 86_400_000);
}

/** Bounded-concurrency pool — preserves input order in the results array. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await fn(items[index], index);
        }
      })(),
    );
  }
  // allSettled — wait for every in-flight worker before propagating a failure,
  // so the caller never releases the announce-once lock while a sibling's
  // journal write is still pending (a second run could otherwise post dupes).
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(
    (s): s is PromiseRejectedResult => s.status === "rejected",
  );
  if (rejected !== undefined) {
    throw rejected.reason;
  }
  return results;
}

/**
 * Cross-process advisory lock over the escalation card/digest runs. The
 * announce-once contract is read-then-post, so two overlapping runs could
 * both POST a fresh card and clobber the journal message id — the lock
 * serializes them so the second run sees the first's row and edits instead.
 * An atomic mkdir next to the journal doubles as the lock; released on
 * completion or error.
 */

/**
 * One card's post/edit/journal state machine, isolated from map
 * orchestration (announce-once for fresh cards, edit-on-change for repeats,
 * transient failures returned as outcomes — never thrown).
 */
export type SyncOutcome =
  | { action: "posted"; id: string; card: EscalationCard }
  | { action: "edited"; id: string; card: EscalationCard }
  | { action: "unchanged"; id: string; card: EscalationCard }
  | { action: "deferred"; id: string }
  | { action: "error"; id: string; error: string };

/**
 * Shared per-map budget of card operations for one tick — bounds the pass so
 * a large frontier can't starve `walk`. `remaining` caps logical Discord
 * requests (unchanged no-ops are free); `deadline` caps WALL TIME so a
 * rate-limited/cooldown-bound tick defers the rest instead of holding the
 * walk lane (round-26 review). Deferred cards stay unsynced and are served
 * next tick.
 */
export interface CardBudget {
  remaining: number;
  deadline: number;
}

/** Shared context for one card's sync lifecycle — the per-card derivations
 *  (key, age, content) plus the pass context, so post/edit/recover/migrate
 *  live as focused module-level helpers instead of coupled closures
 *  (round-31 suggestion). */
/** The pass context shared by every card-sync stage — the base for both
 *  `syncCard` (which builds the per-card derivations on top) and the full
 *  `CardSyncContext` (round-33 suggestion: one shape, no duplicated fields).
 */
export interface CardSyncCtxBase {
  client: EscalationDiscord;
  clientFor: (channelId: string) => EscalationDiscord;
  journal: Journal;
  map: RangerMapConfig;
  config: RangerConfig;
  now: Date;
  budget: CardBudget;
  /** Pre-mutation lease-ownership assertion (round-35): re-reads the lock
   *  nonce and throws LeaseLostError when the lock is no longer ours, so a
   *  resumed holder whose lease was reclaimed stops BEFORE its next Discord
   *  write or journal update instead of posting alongside the new owner. */
  owned: OwnedCheck;
}

export interface CardSyncContext extends CardSyncCtxBase {
  node: ClassifiedNode;
  key: string;
  ageDays: number;
  content: string;
}

/** One row assembly shared by post and edit — card fields live in one place. */
function escalationRow(
  ctx: CardSyncContext,
  params: {
    messageId: string;
    lastContent: string;
    createdAt: string;
    lastEditedAt?: string;
  },
) {
  const { client, map, node } = ctx;
  return {
    key: ctx.key,
    repo: map.repo,
    nodeId: node.id,
    title: node.title,
    route: node.route.route,
    channelId: client.channel,
    lastContent: params.lastContent,
    messageId: params.messageId,
    createdAt: params.createdAt,
    ...(params.lastEditedAt === undefined
      ? {}
      : { lastEditedAt: params.lastEditedAt }),
    status: "open" as const,
    // A fresh or re-activated card is never reconciled.
    notedAt: null,
  };
}

/** Persist the card row and build the outcome — the shared tail of every
 *  successful post/edit. */
function saveAndReturn(
  ctx: CardSyncContext,
  row: ReturnType<typeof escalationRow>,
  action: "posted" | "edited",
): SyncOutcome {
  // Fence the row write: the new owner's journal must not be overwritten by
  // a resumed holder (round-35 blocker).
  ctx.owned();
  ctx.journal.upsertEscalation(row);
  return {
    action,
    id: ctx.node.id,
    card: cardFrom(ctx.node, row, ctx.ageDays),
  };
}

/** Post a fresh card in the client's channel + record row + destination.
 *  `priorCreatedAt` preserves the card's IMMUTABLE first-appearance age on a
 *  repost (moved channel / message gone); a brand-new card (no arg) starts
 *  its age now. */
async function postFresh(
  ctx: CardSyncContext,
  priorCreatedAt?: string,
): Promise<SyncOutcome> {
  const { client, journal, budget, node, now } = ctx;
  if (!charge(budget)) return { action: "deferred", id: node.id };
  // A resumed holder whose lease was reclaimed must stop before its next
  // mutation (round-35 blocker): the fresh post is the announcement itself.
  ctx.owned();
  // The posted content is the SAME `content` the edit path would use — one
  // render source, no drift (round-30 suggestion). A reposted card is the
  // SAME unresolved escalation, re-surfaced WITH ITS AGE (design §5); new
  // cards render age 0.
  const messageId = await client.post(ctx.content, budget.deadline);
  const row = escalationRow(ctx, {
    messageId,
    lastContent: ctx.content,
    // Immutable first-appearance timestamp: the card's age is its age since
    // it first appeared, preserved across reposts. The per-destination
    // created_at (escalation_destinations) tracks each channel visit for
    // recovery, not the card's age.
    createdAt: priorCreatedAt ?? now.toISOString(),
  });
  // Fence the destination + row writes too: a resumed holder must not
  // overwrite the new owner's journal state (round-35).
  ctx.owned();
  journal.setEscalationDestination(
    ctx.key,
    client.channel,
    messageId,
    now.toISOString(),
  );
  return saveAndReturn(ctx, row, "posted");
}

/** Edit a card message in place; if the message is gone (deleted or in a
 *  moved channel), repost fresh (keeping the card's age) instead of retrying
 *  a doomed edit. */
async function editInPlace(
  ctx: CardSyncContext,
  messageId: string,
  editContent: string,
  createdAt: string,
): Promise<SyncOutcome> {
  const { client, budget, node, now } = ctx;
  if (!charge(budget)) return { action: "deferred", id: node.id };
  // Fence the edit (round-35 blocker): a reclaimed holder must not write.
  ctx.owned();
  try {
    await client.edit(messageId, editContent, budget.deadline);
  } catch (cardError) {
    if (cardError instanceof DiscordMessageGoneError) {
      return await postFresh(ctx, createdAt);
    }
    throw cardError;
  }
  const row = escalationRow(ctx, {
    messageId,
    lastContent: editContent,
    createdAt,
    lastEditedAt: now.toISOString(),
  });
  return saveAndReturn(ctx, row, "edited");
}

/** Edit the card we're LEAVING (in the prior channel) to a "moved" note —
 *  one active card per escalation: a channel move must not leave the old card
 *  active-looking (round-25 review, resolves the round-23 stale-B gap). A 404
 *  (already gone) is fine; a deferral aborts the move so we never create a
 *  second active card without retiring the first. */
async function noteMoved(
  ctx: CardSyncContext,
  priorChannelId: string | null,
  priorMessageId: string,
): Promise<"noted" | SyncOutcome> {
  const { clientFor, client, budget, node } = ctx;
  // The caller only routes here when prior.channelId is a real, different
  // channel, but TS can't carry that narrowing through — a null is a legacy
  // row with no channel to note (nothing to do).
  if (priorChannelId === null) return "noted";
  if (!charge(budget)) return { action: "deferred", id: node.id };
  // Fence the note-write (round-35): a reclaimed holder must not mutate.
  ctx.owned();
  try {
    await clientFor(priorChannelId).edit(
      priorMessageId,
      movedCardNote(node.id, node.title, client.channel),
      budget.deadline,
    );
    return "noted";
  } catch (cardError) {
    if (cardError instanceof DiscordMessageGoneError) {
      return "noted"; // already gone — nothing to note
    }
    throw cardError;
  }
}

/** A card whose destination channel moved: recover its existing message in
 *  the CURRENT channel if one exists (edit in place, age kept — it is the
 *  same card), else post fresh — never a duplicate while a channel is
 *  re-visited (destination recovery, round-14/15). */
async function syncMovedCard(
  ctx: CardSyncContext,
  prior: EscalationRow,
): Promise<SyncOutcome> {
  const { client, journal } = ctx;
  const noted = await noteMoved(ctx, prior.channelId, prior.messageId);
  if (noted !== "noted") return noted;
  const recoveredId = journal.getEscalationDestination(ctx.key, client.channel);
  if (recoveredId !== null) {
    return editInPlace(ctx, recoveredId, ctx.content, prior.createdAt);
  }
  return postFresh(ctx, prior.createdAt);
}

/** One card's post/edit/journal lifecycle — a thin dispatcher: derive the
 *  per-card context, then route to the named stage (post / edit-in-place /
 *  moved-channel recovery). Isolated from map orchestration (announce-once
 *  for fresh cards, edit-on-change for repeats, transient failures returned
 *  as outcomes — never thrown). */
async function syncCard(
  ctx: CardSyncCtxBase,
  node: ClassifiedNode,
  prior: EscalationRow | undefined,
): Promise<SyncOutcome> {
  const { client, config, map, now } = ctx;
  const ageDays = prior === undefined ? 0 : dayDiff(prior.createdAt, now);
  const content = cardContent(
    node,
    map,
    ageDays,
    config.principal.login,
    config.principal.discordId,
  );
  const cardCtx: CardSyncContext = {
    ...ctx,
    node,
    key: `${map.repo}:${node.id}`,
    ageDays,
    content,
  };
  try {
    if (prior === undefined) {
      return await postFresh(cardCtx);
    }
    // A card CLOSED by the write-side (node #21) must not be re-activated by
    // a sync — the row's status is preserved, not force-set to open (round-31
    // review: closed cards would otherwise reopen on the next content/age
    // update while still on the frontier).
    if (prior.status === "closed") {
      return {
        action: "unchanged" as const,
        id: node.id,
        card: cardFrom(node, prior, ageDays),
      };
    }
    if (prior.channelId !== null && prior.channelId !== client.channel) {
      return await syncMovedCard(cardCtx, prior);
    }
    // Edit-on-change: a 900s tick re-runs ~96×/day; re-editing identical
    // cards churns Discord writes and trips rate limits (observed live).
    // Only PATCH when the rendered content actually differs.
    if (prior.lastContent === content) {
      return {
        action: "unchanged" as const,
        id: node.id,
        card: cardFrom(node, prior, ageDays),
      };
    }
    return await editInPlace(
      cardCtx,
      prior.messageId,
      content,
      prior.createdAt,
    );
  } catch (cardError) {
    // A transient Discord failure on one card must not fail the whole desk —
    // the card retries next tick (announce-once stays intact: a failed post
    // writes no row, a failed edit keeps its row). A LOST LEASE is NOT a
    // per-card failure: it aborts the whole pass and surfaces loudly
    // (round-35 blocker).
    if (cardError instanceof LeaseLostError) throw cardError;
    return {
      action: "error" as const,
      id: node.id,
      error: cardError instanceof Error ? cardError.message : String(cardError),
    };
  }
}

/**
 * Cards whose node left the HITL/provisioning queue are edited to a "no
 * longer on queue" note but KEPT OPEN — design §5 says cards persist until a
 * principal response or an operator verb resolves them; leaving the frontier
 * is not a resolution. Edit-on-change applies, so a re-run of an already-
 * noted card is a no-op. Bounded-pool like the active pass.
 * Returns the node ids kept open this pass.
 */
export async function markAbsentCards(
  ctx: {
    client: EscalationDiscord;
    journal: Journal;
    map: RangerMapConfig;
    now: Date;
    budget: CardBudget;
    owned: OwnedCheck;
  },
  neededIds: ReadonlySet<string>,
): Promise<{ keptOpen: string[]; deferred: string[]; errors: string[] }> {
  const { client, journal, map, now, budget, owned } = ctx;
  // Reconcile ONLY open, un-noted cards ABSENT from the current frontier — a
  // no-op tick never loads (or skips) the active cards (round-19 review), and
  // a noted card drops out entirely. Closing resolved cards (which shrinks
  // the open set) is the write-side resolution lifecycle (node #21). The
  // candidate selection (bounded + cursor-swept past needed rows) is
  // `selectAbsentCards`; the per-card destination reconciliation is
  // `reconcileAbsentCard`.
  const usable = selectAbsentCards(journal, map.repo, neededIds, budget);
  const clientFor = channelClientFor(client);
  const reconcileCtx = { clientFor, journal, map, now, budget, owned };
  const outcomes = await mapPool(usable, 3, (prior) =>
    reconcileAbsentCard(reconcileCtx, prior),
  );
  const keptOpen: string[] = [];
  const deferred: string[] = [];
  const errors: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.action === "error") {
      errors.push(`#${outcome.id}: ${outcome.error}`);
    } else if (outcome.action === "deferred") {
      deferred.push(outcome.id);
    } else if (outcome.action === "keptOpen") {
      keptOpen.push(outcome.id);
    }
  }
  return { keptOpen, deferred, errors };
}

/**
 * Select up to budget.remaining USABLE (non-needed) open cards for absent-
 * card reconciliation. Cap the LOAD to the remaining request budget (oldest
 * exits first): each card needs ≥1 destination edit, so loading more than the
 * budget could never be fully processed this tick — and a large drain must
 * not walk every unnoted card after the budget is spent. The SQL NOT IN
 * exclusion is capped too (bind limit); JS-filtering against the FULL needed
 * set here preserves correctness at any frontier size — a needed card that
 * slipped past the truncated exclusion is never treated as absent. A PERSISTED
 * cursor advances the resume point each tick: with >ABSENT_EXCLUDE_CAP needed
 * cards older than a real absent card, a scan restarting at 0 every tick
 * would repeatedly discard the same needed prefix and never reach the absent
 * one (round-29: "no absent card starves" must hold). The scan stays bounded
 * (MAX_ABSENT_SCAN rows) and wraps to 0 once it sweeps the whole set.
 */
function selectAbsentCards(
  journal: Journal,
  repo: string,
  neededIds: ReadonlySet<string>,
  budget: CardBudget,
): EscalationRow[] {
  const wanted = Math.max(budget.remaining, 0);
  const scanPage = 50;
  const cursorKey = `escalate.absentCursor.${repo}`;
  // KEYSET cursor (the last row seen: createdAt + nodeId tiebreak) — resumes
  // AFTER it, which is O(page) per tick instead of the O(offset) skip a
  // growing queue would incur (round-31 review).
  let after: { createdAt: string; nodeId: string } | undefined;
  const cursorRaw = journal.getHealth(cursorKey);
  if (cursorRaw !== null) {
    try {
      after = JSON.parse(cursorRaw) as { createdAt: string; nodeId: string };
    } catch {
      after = undefined; // corrupt cursor — restart the sweep
    }
  }
  let scanned = 0;
  let reachedEnd = false;
  const openCards: EscalationRow[] = [];
  while (openCards.length < wanted && scanned < MAX_ABSENT_SCAN) {
    // Raw keyset pages (NO SQL exclusion — a NOT IN against a large
    // all-active queue would force SQLite to scan every row proving no
    // results, round-36 review). Needed rows are dropped here in JS, and the
    // cursor advances on the RAW last row so an all-active queue still
    // terminates.
    const batch = journal.listUnreconciledOpen(repo, {
      limit: scanPage,
      after,
    });
    scanned += batch.length;
    openCards.push(...batch.filter((row) => !neededIds.has(row.nodeId)));
    if (batch.length < scanPage) {
      reachedEnd = true; // swept the whole raw set — reset the cursor next tick
      break;
    }
    const last = batch[batch.length - 1]; // non-empty: length >= scanPage here
    after = { createdAt: last.createdAt, nodeId: last.nodeId };
  }
  journal.setHealth(
    cursorKey,
    reachedEnd || after === undefined ? "" : JSON.stringify(after),
  );
  return openCards.slice(0, wanted);
}

type AbsentOutcome =
  | { action: "keptOpen" | "unchanged"; id: string }
  | { action: "deferred"; id: string }
  | { action: "error"; id: string; error: string };

/**
 * Reconcile ONE absent card: write the queue-exit note to EVERY destination's
 * card (a card that moved channels still holds a live message in each visited
 * channel — none may stay active-looking), then set notedAt. Shares the same
 * per-tick request budget as the active pass (a mass queue exit can't blow
 * the bound); a deferred card keeps notedAt null and is re-reconciled next
 * tick; a transient failure is returned (never thrown) so one card can't fail
 * the desk.
 */
async function reconcileAbsentCard(
  ctx: {
    clientFor: (channelId: string) => EscalationDiscord;
    journal: Journal;
    map: RangerMapConfig;
    now: Date;
    budget: CardBudget;
    owned: OwnedCheck;
  },
  prior: EscalationRow,
): Promise<AbsentOutcome> {
  const { clientFor, journal, map, now, budget, owned } = ctx;
  const nodeId = prior.nodeId;
  const key = `${map.repo}:${nodeId}`;
  const content = queueExitContent(nodeId, prior.title, map.repo);
  const cursorKey = `escalate.reconcile.${key}`;
  try {
    // Reconcile EVERY destination's card: a card that moved channels still
    // holds a live, actionable message in each visited channel — write the
    // queue-exit note to all of them so none stays active-looking (round-19
    // review). Legacy rows (pre-0006, no destination rows) fall back to the
    // row's own channel/message when known.
    const stored = journal.getEscalationDestinations(key);
    let destinations: { channelId: string; messageId: string }[];
    if (stored.length > 0) {
      destinations = stored;
    } else if (prior.channelId === null) {
      destinations = [];
    } else {
      destinations = [
        { channelId: prior.channelId, messageId: prior.messageId },
      ];
    }
    // A per-card destination cursor: with more destinations than the
    // remaining budget, a restart-at-0 would re-edit the same first N each
    // tick and never reach the tail (round-32 review). Resume from the
    // persisted index; destinations are createdAt-ordered (deterministic).
    let start = journal.getInt(cursorKey);
    if (start > destinations.length) start = 0; // destinations changed
    let anyEdit = false;
    let i = start;
    for (; i < destinations.length; i++) {
      const dest = destinations[i];
      if (!charge(budget)) {
        // Persist the resume point; notedAt stays null → re-reconciled next
        // tick from where we left off.
        journal.setHealth(cursorKey, String(i));
        return { action: "deferred", id: nodeId };
      }
      // A resumed holder whose lease was reclaimed must stop before its next
      // write — the queue-exit note is a Discord mutation (round-35).
      owned();
      try {
        await clientFor(dest.channelId).edit(
          dest.messageId,
          content,
          budget.deadline,
        );
        anyEdit = true;
      } catch (destError) {
        if (!(destError instanceof DiscordMessageGoneError)) throw destError;
        // this destination's card is already gone — nothing to note there
      }
    }
    // All destinations reconciled (or a definitive 404 each) — clear the
    // cursor + set notedAt; a transient failure throws → retried next tick.
    journal.setHealth(cursorKey, "");
    // Fence the row write too: the new owner's journal must not be
    // overwritten by a resumed holder (round-35).
    owned();
    journal.upsertEscalation({
      key,
      repo: map.repo,
      nodeId,
      title: prior.title,
      lastContent: content,
      messageId: prior.messageId,
      channelId: prior.channelId,
      createdAt: prior.createdAt,
      lastEditedAt: now.toISOString(),
      status: prior.status, // stays open — cards persist (design §5)
      notedAt: now.toISOString(),
    });
    return {
      action: (anyEdit ? "keptOpen" : "unchanged") as "keptOpen" | "unchanged",
      id: nodeId,
    };
  } catch (cardError) {
    // A transient failure on one card must not fail the desk — it retries
    // next tick and the card stays open. A LOST LEASE aborts the pass
    // (round-35 blocker): the new owner owns the journal now.
    if (cardError instanceof LeaseLostError) throw cardError;
    return {
      action: "error" as const,
      id: nodeId,
      error: cardError instanceof Error ? cardError.message : String(cardError),
    };
  }
}

/** One throttled client per channel, shared by a pass — edits to OTHER
 *  channels (a moved card's "left the channel" note, absent-card queue-exit
 *  notes) share a limiter instead of each card building its own and bursting
 *  the rate-limit bucket. Seeded with the pass's own client so the current
 *  channel reuses its state (round-26: single source for both paths). */
function channelClientFor(
  client: EscalationDiscord,
): (channelId: string) => EscalationDiscord {
  const clients = new Map<string, EscalationDiscord>([
    [client.channel, client],
  ]);
  return (channelId: string): EscalationDiscord => {
    let c = clients.get(channelId);
    if (c === undefined) {
      c = client.forChannel(channelId);
      clients.set(channelId, c);
    }
    return c;
  };
}

/** Charge one Discord-request slot from the shared tick budget. Returns false
 *  when the budget is exhausted — the caller defers (the card stays open and
 *  unsynced) and serves it next tick, rather than holding this pass past the
 *  walk interval. Shared by the active-card pass and the absent-card
 *  reconciliation so the per-tick request bound is one budget across both. */
function charge(budget: CardBudget): boolean {
  if (Date.now() > budget.deadline) return false; // pass deadline — defer
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

/** The deterministic "card moved channels" note — one source of truth for
 *  the reconciliation a channel move leaves behind (round-25 review). */
function movedCardNote(
  nodeId: string,
  title: string | null,
  channelId: string,
): string {
  // Mention-inert (a graph id/title can't ping), non-actionable, and title-
  // CAPPED: a graph title over Discord's 2000-char message limit would fail
  // the PATCH and leave the old card active-looking — the note must always
  // fit (round-30 review).
  return `~~**#${sanitizeGraphText(nodeId)}** ${truncate(sanitizeGraphText(title ?? ""), 200)}~~ moved to channel ${channelId} — the active card is in the new channel`;
}

/** The deterministic queue-exit note — one source of truth for card content. */
function queueExitContent(
  nodeId: string,
  title: string | null,
  repo: string,
): string {
  // Title is CAPPED (like movedCardNote): a graph title over Discord's
  // 2000-char limit would fail the PATCH and leave the card actionable
  // (round-30 review).
  return [
    `~~**#${sanitizeGraphText(nodeId)}** ${truncate(sanitizeGraphText(title ?? ""), 200)}~~ no longer on the HITL/provisioning queue`,
    `map: ${repo} — card kept open; resolves on a principal response or operator verb`,
  ]
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

export function ageText(
  band: AgeBand,
  ageDays: number,
  principal: string,
  principalDiscordId?: string,
): string {
  if (band === "overdue") {
    if (principalDiscordId !== undefined) {
      return `📣 <@${principalDiscordId}> ${ageDays}d`;
    }
    return `📣 @${principal} ${ageDays}d (no ping)`;
  }
  if (band === "aging") {
    return `⚠️ ${ageDays}d`;
  }
  return `${ageDays}d`;
}

/** Build the card + journal-row inputs for a node in one place (no drift). */
export function cardFrom(
  node: ClassifiedNode,
  row: {
    nodeId: string;
    title: string | null;
    messageId: string;
    createdAt: string;
  },
  ageDays: number,
): EscalationCard {
  return {
    nodeId: row.nodeId,
    title: row.title ?? `#${sanitizeGraphText(row.nodeId)}`,
    kind: node.kind,
    autonomy: node.autonomy,
    url: node.url,
    checkpointId: node.checkpointId,
    route: node.route.route,
    reason:
      node.route.route === "escalate-hitl"
        ? node.route.reason
        : "registry-blocked",
    ageDays,
    status: "open",
    createdAt: row.createdAt,
    messageId: row.messageId,
  };
}

export function cardNeeded(node: ClassifiedNode): boolean {
  return (
    node.route.route === "escalate-hitl" || node.route.route === "provisioning"
  );
}

/**
 * Shared map-context setup for the cards and digest runs: read-only token
 * (no keyring fallback) + the per-map Discord client. One place for the
 * policy; both runs use it so they can't drift.
 */
export async function resolveDeskContext(
  config: RangerConfig,
  map: RangerMapConfig,
): Promise<{ token: ResolvedToken; client: EscalationDiscord }> {
  const { token } = await assertReadOnlyToken(config, map.repo);
  const client = EscalationDiscord.fromMap(map, config.principal.discordId);
  return { token, client };
}

/** One tick's ACTIVE card pass for a map — extracted from the map
 *  orchestration so paging, sync, and result-collation don't live inline in
 *  the 160+-line map flow (round-35 suggestion). Bounds the pass: a REQUEST
 *  budget charged only when syncCard actually POSTs/EDITs (unchanged no-op
 *  cards are free) caps logical card operations; a PAGE of candidates
 *  evaluated this tick, swept via a persisted cursor, caps the SQL lookup
 *  and the render+decision walk. Nothing starves: the cursor advances each
 *  tick so every needed node is eventually evaluated, and fresh cards (no
 *  row) within the page announce before page re-edits. Returns the collated
 *  outcomes + the budget the absent-card pass reuses with its reserved slice
 *  (round-33).
 */
export async function syncActivePage(ctx: {
  client: EscalationDiscord;
  config: RangerConfig;
  map: RangerMapConfig;
  journal: Journal;
  now: Date;
  passDeadline: number;
  needed: ClassifiedNode[];
  owned: OwnedCheck;
}): Promise<{
  cards: EscalationCard[];
  posted: string[];
  edited: string[];
  deferred: string[];
  cardErrors: string[];
  budget: CardBudget;
}> {
  const {
    client,
    config,
    map,
    journal,
    now,
    passDeadline,
    needed,
    owned,
  } = ctx;
  const budget = {
    remaining: ACTIVE_CARD_CAP,
    deadline: passDeadline,
  };
  const cursorKey = `escalate.cursor.${map.repo}`;
  const sorted = [...needed].sort((a, b) => a.id.localeCompare(b.id));
  const pageSize = MAX_CARDS_PER_TICK * 2;
  const offset =
    sorted.length === 0 ? 0 : journal.getInt(cursorKey) % sorted.length;
  // A bounded page of candidate nodes swept through the frontier via a
  // persisted cursor. When the whole frontier fits in one page there is
  // nothing to sweep — use it DIRECTLY: the modulo wrap would duplicate
  // IDs already in the first slice (a duplicated FRESH id both enters
  // postFresh and posts two cards, round-34 blocker). Only when the
  // frontier EXCEEDS the page do we window it, and the wrap appends the
  // exact overflow (offset+pageSize-N < N for N>pageSize, so no overlap).
  const page =
    sorted.length <= pageSize
      ? sorted
      : sorted
          .slice(offset, offset + pageSize)
          .concat(
            offset + pageSize > sorted.length
              ? sorted.slice(0, offset + pageSize - sorted.length)
              : [],
          );
  if (sorted.length > pageSize) {
    journal.setHealth(
      cursorKey,
      String((offset + pageSize) % sorted.length),
    );
  }

  // The active pass needs ONLY the rows for the nodes in this tick's page
  // — query them directly instead of scanning the whole repo's escalation
  // history every 15-minute tick (round-15 review). The absent-card pass
  // separately queries open cards.
  const existing = journal.getEscalations(map.repo, page.map((n) => n.id));
  // Fresh cards (no row yet) announce before page re-edits — they are the
  // urgent ones and must not wait behind a sweep of already-synced cards.
  const pageOrder = page
    .filter((n) => !existing.has(n.id))
    .concat(page.filter((n) => existing.has(n.id)));

  const cards: EscalationCard[] = [];
  const posted: string[] = [];
  const edited: string[] = [];
  const deferred: string[] = [];
  const cardErrors: string[] = [];
  const clientFor = channelClientFor(client);
  const outcomes = await mapPool(pageOrder, 3, (node) =>
    syncCard(
      { client, clientFor, journal, map, config, now, budget, owned },
      node,
      existing.get(node.id),
    ),
  );
  for (const outcome of outcomes) {
    if (outcome.action === "deferred") {
      deferred.push(outcome.id);
    } else if (
      outcome.action === "posted" ||
      outcome.action === "edited" ||
      outcome.action === "unchanged"
    ) {
      cards.push(outcome.card);
    } else {
      cardErrors.push(`#${outcome.id}: ${outcome.error}`);
    }
    if (outcome.action === "posted") posted.push(outcome.id);
    else if (outcome.action === "edited") edited.push(outcome.id);
  }
  return {
    cards,
    posted,
    edited,
    deferred,
    cardErrors,
    budget,
  };
}


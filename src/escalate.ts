import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { EscalationDiscord } from "./discord.ts";
import { classify, hitlWaiting, loadProbeRegistry } from "./route.ts";
import { GRAPH_CALL_TIMEOUT_MS, graphAudit, graphFrontier } from "./graph.ts";
import { type OwnedCheck, withEscalateLock } from "./lock.ts";
import type { ResolvedToken } from "./token-gate.ts";
import type { Journal } from "./journal.ts";
import {
  ABSENT_RESERVE,
  type EscalateMapResult,
  type EscalateResult,
  cardNeeded,
  dayDiff,
  digestAction,
  markAbsentCards,
  resolveDeskContext,
  sanitizeGraphText,
  syncActivePage,
} from "./card-sync.ts";

export type { EscalateResult } from "./card-sync.ts";
import {
  type DigestMapResult,
  type DigestResult,
  digestContent,
  syncDailyDigest,
} from "./digest.ts";

export type { DigestResult } from "./digest.ts";

/** One pass's wall-clock budget: after this the pass defers remaining cards
 *  and returns, so the escalation lane never blocks the walk lane (the tick
 *  awaits escalateMaps before walk). */
const MAX_PASS_MS = 120_000;

/**
 * Escalation desk (design §5, build-path step 2) — graph-read-only.
 *
 * The map pings the principal: one HITL/provisioning card per frontier node in
 * each map's Discord thread, announce-once and edited-not-reposted (the card
 * updates in place via the journal-cached message id), aged from first post
 * (day 1 age shown, 3+ louder, 7+ @-mention the principal). Plus a daily
 * digest: aged cards + audit findings + budget/spend. v1 writes nothing to the
 * graph (node #8: reads are outside the doctrine's teeth) — its only side
 * effects are Discord messages and the journal `escalations` table.
 */

/**
 * The Discord API base for production, with a hardened test seam — shared
 * with the walker announcer (src/discord.ts).
 */

async function escalateOneMap(
  config: RangerConfig,
  map: RangerMapConfig,
  journal: Journal,
  registry: ReturnType<typeof loadProbeRegistry>,
  now: Date,
  passDeadline: number,
  owned: OwnedCheck,
): Promise<EscalateMapResult> {
  const base: EscalateMapResult = {
    repo: map.repo,
    kind: "cards",
    ok: true,
    posted: [],
    edited: [],
    deferred: [],
    keptOpen: [],
    cardErrors: [],
    cards: [],
  };

  // Pre-map deadline gate: if the tick-wide pass deadline has already passed
  // (a prior map consumed it), skip this map's graph calls entirely — its
  // cards are served next tick. This keeps the per-map overhead bounded so
  // the end-to-end pass can't drift unboundedly past the deadline (round-30
  // review: the 120s bound is not just the budget's charge gate).
  if (Date.now() > passDeadline) {
    return {
      ...base,
      ok: false,
      error: "pass deadline reached before this map",
    };
  }

  let token: ResolvedToken;
  let client: EscalationDiscord;
  try {
    ({ token, client } = await resolveDeskContext(config, map));
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const frontier = await graphFrontier(map.repo, map.root, token, {
      timeoutMs: GRAPH_CALL_TIMEOUT_MS,
    });

    const classified = frontier.frontier.map((entry) =>
      classify(entry, map.repo, map.walk, registry),
    );
    const needed = [
      ...hitlWaiting(classified),
      ...classified.filter((n) => n.route.route === "provisioning"),
    ].filter(cardNeeded);

    // The absent-card reconciliation runs FIRST so its GUARANTEED reserved
    // ops also get a FRESH wall-clock window — if it ran after the active
    // pass and the active pass's rate-limited ops consumed the 120s deadline,
    // every absent Discord call would immediately defer and an obsolete
    // actionable card could starve despite the reserve (round-37 review). The
    // active pass then uses the remaining deadline; its deferred cards are
    // served next tick (only absent carries the hard guarantee). Total
    // per-tick bound is still MAX_CARDS_PER_TICK (active cap + absent
    // reserve).
    const neededIds = new Set(needed.map((n) => n.id));
    const absent = await markAbsentCards(
      {
        client,
        journal,
        map,
        now,
        budget: { remaining: ABSENT_RESERVE, deadline: passDeadline },
        owned,
      },
      neededIds,
    );
    base.keptOpen.push(...absent.keptOpen);
    base.deferred.push(...absent.deferred);
    base.cardErrors.push(...absent.errors);
    const active = await syncActivePage({
      client,
      config,
      map,
      journal,
      now,
      passDeadline,
      needed,
      owned,
    });
    base.posted.push(...active.posted);
    base.edited.push(...active.edited);
    base.deferred.push(...active.deferred);
    base.cardErrors.push(...active.cardErrors);

    return { ...base, cards: active.cards };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The cards run across every registered map. */
export async function escalateMaps(
  config: RangerConfig,
  journal: Journal,
  opts: { now?: Date } = {},
): Promise<EscalateResult> {
  return withEscalateLock(journal, async (owned) => {
    const now = opts.now ?? new Date();
    // ONE tick-wide deadline for the whole escalation pass — maps are
    // serialized, so a fresh 120s per map would let a two-map config hold
    // walk for ~240s (round-28 review: "escalation never blocks walking"
    // is bounded at the TICK scope, not per map). Deferred maps/cards are
    // served next tick.
    const passDeadline = Date.now() + MAX_PASS_MS;
    const registry = loadProbeRegistry();
    const maps: EscalateMapResult[] = [];
    for (const map of config.maps) {
      maps.push(
        await escalateOneMap(
          config,
          map,
          journal,
          registry,
          now,
          passDeadline,
          owned,
        ),
      );
    }
    return { generatedAt: now.toISOString(), maps };
  });
}

async function digestOneMap(
  config: RangerConfig,
  map: RangerMapConfig,
  journal: Journal,
  now: Date,
  owned: OwnedCheck,
): Promise<DigestMapResult> {
  const base: DigestMapResult = {
    repo: map.repo,
    kind: "digest",
    ok: true,
    cards: [],
    receiptLessCloses: [],
    openWithoutCheckpoint: [],
    openClaims: [],
    budget: {
      spawnsToday: journal.spawnsToday(now),
      spawnCapPerDay: config.workers.spawnCapPerDay,
      deadman: journal.deadmanCount(),
      paused: journal.isPaused(),
    },
    digestMessageId: "",
    posted: false,
    action: "unchanged" as const,
  };

  // The digest is one logical op per map, but it must still not hold the
  // tick past a bound under rate-limiting — a generous per-digest deadline
  // (round-27 review: the cooldown cap already bounds each wait).
  const digestDeadline = Date.now() + MAX_PASS_MS;

  let token: ResolvedToken;
  let client: EscalationDiscord;
  try {
    ({ token, client } = await resolveDeskContext(config, map));
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    // Every graph call is TIMEOUT-bound: a hung `soma` audit must not hold
    // the shared escalation lock indefinitely (blocking later card + digest
    // runs). Capped by both the graph-call timeout and the remaining digest
    // deadline (round-30 blocker).
    const remainingMs = Math.max(0, digestDeadline - Date.now());
    const audit = await graphAudit(map.repo, map.root, token, {
      timeoutMs: Math.min(
        GRAPH_CALL_TIMEOUT_MS,
        remainingMs || GRAPH_CALL_TIMEOUT_MS,
      ),
    });
    // Open cards only — capped to what the digest renders (≤15), with the
    // total + age aggregates from the same query, so the daily read doesn't
    // grow with historical escalations (round-17/20 reviews).
    const openCards = journal.listOpenEscalations(map.repo, now, {
      limit: 15,
    });
    const open = openCards.rows.map((row) => ({
      nodeId: row.nodeId,
      title: row.title ?? `#${sanitizeGraphText(row.nodeId)}`,
      route: row.route ?? "escalate-hitl",
      ageDays: dayDiff(row.createdAt, now),
      messageId: row.messageId,
    }));

    const content = digestContent({
      map,
      cards: open,
      openCount: openCards.total,
      ageCounts: openCards,
      audit,
      budget: base.budget,
      principal: config.principal.login,
      principalDiscordId: config.principal.discordId,
      now,
    });

    // Digest delivery is its own state machine (cached post/edit/repost) —
    // see syncDailyDigest.
    const synced = await syncDailyDigest({
      client,
      journal,
      repo: map.repo,
      content,
      now,
      deadline: digestDeadline,
      owned,
    });

    return {
      ...base,
      cards: open,
      receiptLessCloses: audit.closedWithoutReceipt,
      openWithoutCheckpoint: audit.openWithoutCheckpoint,
      openClaims: audit.openClaimed,
      digestMessageId: synced.messageId,
      posted: synced.posted,
      // Honest label for the operator: fresh post | in-place edit | no-op.
      action: digestAction(synced.posted, synced.edited),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The daily digest run across every registered map. */
export async function runDigest(
  config: RangerConfig,
  journal: Journal,
  opts: { now?: Date } = {},
): Promise<DigestResult> {
  return withEscalateLock(journal, async (owned) => {
    const now = opts.now ?? new Date();
    const maps: DigestMapResult[] = [];
    for (const map of config.maps) {
      maps.push(await digestOneMap(config, map, journal, now, owned));
    }
    return { generatedAt: now.toISOString(), maps };
  });
}

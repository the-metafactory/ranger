import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import {
  EscalationDiscord,
  EscalateError,
  DiscordMessageGoneError,
  sleep,
} from "./discord.ts";
import {
  classify,
  ESCALATE_REASONS,
  hitlWaiting,
  loadProbeRegistry,
  type ClassifiedNode,
} from "./route.ts";
import { graphAudit, graphFrontier, type AuditResult } from "./graph.ts";
import { assertReadOnlyToken, type ResolvedToken } from "./token-gate.ts";
import type { EscalationRow, Journal } from "./journal.ts";

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

function ageBand(ageDays: number): AgeBand {
  if (ageDays >= 7) return "overdue";
  if (ageDays >= 3) return "aging";
  return "fresh";
}

/** Host-local YYYY-MM-DD — the digest cache key and date must match the
 * launchd schedule (host-local 07:30), not the UTC calendar day. */
function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Label a digest run honestly: fresh post | in-place edit | no-op. */
function digestAction(
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
function sanitizeGraphText(text: string | null | undefined): string {
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
function cardFraming(node: ClassifiedNode, map: { repo: string }): {
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
  const bodyBudget =
    1950 - prefixLines.join("\n").length - suffix.length - 8;
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
  const bodyLine = renderBoundedBody(
    bodyText,
    prefixLines,
    suffix,
    node.kind,
  );
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

interface EscalationCard {
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

interface EscalateMapResult {
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

function dayDiff(fromIso: string, now: Date): number {
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
/** Atomic create-with-content: returns true when we now hold the lock. */
function tryAcquireLock(lockFile: string, owner: string): boolean {
  try {
    writeFileSync(lockFile, owner, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/**
 * Is the lock's owner a dead process (ESRCH)? Never reclaim on age or on an
 * unreadable owner — stealing a live run's lock breaks announce-once.
 */
/** A lock older than this is a dead run — no live escalate pass takes this
 *  long (throttled writes + bounded backoffs finish in minutes). The age arm
 *  catches the PID-reuse case a PID check cannot: a dead process's lock whose
 *  pid got recycled by an unrelated, still-alive process would otherwise look
 *  live forever and strand the desk (every tick times out, no cards/digests). */
/** Lease expiry (and heartbeat interval) for the announce-once lock — see
 *  `withEscalateLock`. A holder renews its lease while running, so a live run
 *  is NEVER stale, while a dead/crashed/recycled-pid holder's lease expires
 *  and the lock becomes safely reclaimable. */
const LOCK_LEASE_MS = 60_000;
/**
 * Per-map cap on cards synced in one escalate tick. Bounds the pass so a
 * large frontier can't starve `walk` (each card spends ≥1s in the Discord
 * throttle); capped-out cards stay "needed" and are served next tick.
 */
const MAX_CARDS_PER_TICK = 50;
/** Legacy locks (pre-lease, or the reclaim marker) fall back to age. */
const LOCK_STALE_MS = 30 * 60 * 1000;
/** The reclaim marker is held for microseconds — any marker this old is a
 *  crash artifact (immediate cleanup on a dead pid, plus this age arm for
 *  the recycled-pid case). */
const MARKER_STALE_MS = 60_000;

/**
 * Is the lock's owner provably gone? For a LEASED lock: true when its
 * `leaseUntil` has passed — a live run renews the lease, so an expired lease
 * means the holder died, crashed, or its pid got recycled (no heartbeat). For
 * legacy/marker locks: true when the recorded pid is dead (ESRCH) OR the
 * lock is older than `maxAgeMs`. A live, renewing run is never reclaimed.
 * Never reclaim on an unreadable owner — stealing a live run's lock breaks
 * announce-once.
 */
function lockOwnerStale(
  lockFile: string,
  maxAgeMs: number = LOCK_STALE_MS,
): boolean {
  try {
    const prior = JSON.parse(readFileSync(lockFile, "utf8")) as {
      pid?: number;
      startedAt?: number;
      at?: number;
      leaseUntil?: number;
    };
    if (typeof prior.pid !== "number") return false;
    // Leased lock: the LEASE governs — an expired lease is a definitive signal
    // the holder is gone (its heartbeat stopped), which is what makes
    // PID-reuse reclaimable while never touching a live run's RENEWED lock.
    // A valid lease NEVER falls through to the age arm (a run held >30min
    // with a renewed lease is not stale — round-28 review).
    if (typeof prior.leaseUntil === "number") {
      return prior.leaseUntil < Date.now();
    }
    // Legacy / marker fallback (no lease): dead pid OR old enough to be a
    // crash artifact.
    const stamp = prior.startedAt ?? prior.at;
    if (typeof stamp === "number" && Date.now() - stamp > maxAgeMs) {
      return true;
    }
    try {
      process.kill(prior.pid, 0);
      return false;
    } catch (killError) {
      return (killError as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    /* unreadable owner — never reclaim on a guess */
    return false;
  }
}

/**
 * Reclaim outcome for a dead-owner lock: `acquired` (we now hold it),
 * `busy` (a live holder is mid-reclaim), or `not-dead` (the lock was
 * replaced by a live owner while we waited — do NOT delete it).
 */
type ReclaimOutcome = "acquired" | "busy" | "not-dead";

/**
 * EXCLUSIVE reclaim of a dead-owner lock. The reclaim marker is created
 * atomically (wx), so only one process can hold it and remove+re-acquire.
 * Two refinements make this both race-safe and crash-safe:
 *
 * - Stale-marker reclaim: a process that dies mid-reclaim leaves `.reclaiming`
 *   behind, which would strand every later run (EEXIST forever → timeout).
 *   When the marker's OWNER is provably dead, we remove it and retry the wx
 *   create — the desk can never permanently stop.
 * - Owner revalidation: after acquiring the marker we RE-READ the main lock
 *   and delete it only if the owner is STILL dead. If another contender
 *   reclaimed and re-acquired it while we waited for the marker, we back off
 *   instead of deleting a live lock (which would let two runs both POST).
 *
 * Returns "acquired" | "busy" | "not-dead". The residual window — a stale-
 * marker cleanup unlinking a marker re-created in the same instant — is
 * documented in docs/live-validation: its worst case is one visible duplicate
 * card, the same class as the acknowledged POST→journal crash window.
 */
function reclaimDeadLock(
  lockFile: string,
  reclaimMarker: string,
  owner: string,
): ReclaimOutcome {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(
        reclaimMarker,
        JSON.stringify({ pid: process.pid, at: Date.now() }),
        { flag: "wx" },
      );
      break;
    } catch (markerError) {
      if ((markerError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw markerError;
      }
      // Someone holds the marker. If its owner is provably stale (dead pid
      // or old enough to be a crashed reclaim), remove it and retry —
      // otherwise a live holder is mid-reclaim and we wait.
      if (!lockOwnerStale(reclaimMarker, MARKER_STALE_MS) || attempt >= 2) {
        return "busy";
      }
      try {
        rmSync(reclaimMarker, { force: true });
      } catch {
        return "busy"; // lost the unlink race — someone else owns the marker
      }
    }
  }
  try {
    // Revalidate the main lock before deleting it: a contender may have
    // reclaimed and re-acquired it while we waited for the marker. Delete
    // only a lock whose owner is STILL stale.
    if (!lockOwnerStale(lockFile)) {
      return "not-dead";
    }
    rmSync(lockFile, { force: true });
    writeFileSync(lockFile, owner, { flag: "wx" });
    return "acquired";
  } finally {
    try {
      rmSync(reclaimMarker, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** An acquired announce-once lease: the lock file + marker paths and the
 *  owner nonce + fresh-owner generator used by the heartbeat and release. */
interface Lease {
  lockFile: string;
  reclaimMarker: string;
  ownerNonce: string;
  leaseOwner: () => string;
}

/**
 * Acquire the announce-once lease, waiting (up to the timeout) under
 * contention and reclaiming a provably-dead/stale owner. The owner payload is
 * generated FRESH at each attempt: the wait can run ~60s, and a lease
 * computed beforehand would already be expired when acquisition succeeds —
 * letting another run reclaim our live lock before the heartbeat starts
 * (round-22 blocker).
 */
async function acquireLease(
  lockFile: string,
  reclaimMarker: string,
): Promise<Lease> {
  const started = Date.now();
  const timeoutMs = 60_000;
  const lockStartedAt = Date.now();
  // The lock carries a LEASE and an OWNER NONCE. The lease (renewed by a
  // heartbeat while we hold the lock) makes an actively-running run
  // never-stale, so only a dead/crashed/recycled-pid holder is reclaimed.
  // The nonce FENCES the lease: if our lease ever expires and another run
  // reclaims the lock, our heartbeat and release re-read the lock and act
  // only when the nonce is still OURS — a resumed holder can never overwrite
  // or unlink a lock another run now owns (round-21 blocker).
  const ownerNonce = `${process.pid}-${randomUUID()}`;
  const leaseOwner = () =>
    JSON.stringify({
      nonce: ownerNonce,
      pid: process.pid,
      startedAt: lockStartedAt,
      leaseUntil: Date.now() + LOCK_LEASE_MS,
    });
  const lease: Lease = { lockFile, reclaimMarker, ownerNonce, leaseOwner };
  for (;;) {
    if (tryAcquireLock(lockFile, leaseOwner())) return lease;
    if (lockOwnerStale(lockFile)) {
      const outcome = reclaimDeadLock(lockFile, reclaimMarker, leaseOwner());
      if (outcome === "acquired") return lease;
      // "busy" / "not-dead" — wait and re-check the lock below.
    }
    if (Date.now() - started > timeoutMs) {
      throw new EscalateError(
        `another escalate run holds the lock (${lockFile}) — ` +
          "refusing to risk duplicate cards",
      );
    }
    await sleep(250);
  }
}

/**
 * Renew the lease while the run is live so a long (or paused) run is never
 * reclaimed by an expired lease — but only while the lock is still OURS. If
 * the nonce changed (another run reclaimed us), stop heartbeating: never
 * overwrite their lock. Returns the interval plus a ref the release uses to
 * surface a lost-ownership reclaim loudly.
 */
function startHeartbeat(
  lease: Lease,
): { heartbeat: ReturnType<typeof setInterval>; lostOwnership: { value: boolean } } {
  const lostOwnership = { value: false };
  const heartbeat = setInterval(() => {
    try {
      const cur = JSON.parse(readFileSync(lease.lockFile, "utf8")) as {
        nonce?: string;
      };
      if (cur.nonce !== lease.ownerNonce) {
        lostOwnership.value = true;
        clearInterval(heartbeat);
        return;
      }
      writeFileSync(lease.lockFile, lease.leaseOwner());
    } catch {
      /* lock released — nothing to renew */
    }
  }, LOCK_LEASE_MS / 2);
  return { heartbeat, lostOwnership };
}

/**
 * Stop the heartbeat and release the lock — but only OUR lock: if the nonce
 * changed (we were reclaimed), leave the new owner's lock alone (unlinking it
 * would let a third run in), and surface the lost-ownership reclaim loudly.
 * The `.reclaiming` marker is deliberately NOT touched here: it is owned by
 * reclaimDeadLock (removed in its own finally), and a resumed holder must
 * never unlink a marker a NEW reclaimer currently holds — doing so would let
 * a third run in and deserialize the desk (round-25 review). A crashed
 * reclaimer's marker is cleaned by the next run's stale-marker reclaim.
 */
function releaseLease(
  lease: Lease,
  heartbeat: ReturnType<typeof setInterval>,
  lostOwnership: { value: boolean },
): void {
  clearInterval(heartbeat);
  try {
    let ours = false;
    try {
      const cur = JSON.parse(readFileSync(lease.lockFile, "utf8")) as {
        nonce?: string;
      };
      ours = cur.nonce === lease.ownerNonce;
    } catch {
      /* unreadable — nothing to release */
    }
    if (ours) rmSync(lease.lockFile, { force: true });
  } catch {
    /* best-effort release */
  }
  if (lostOwnership.value) {
    // We were reclaimed mid-run (lease expired, machine paused >60s): our
    // cards already posted this run are duplicative of the new holder's —
    // surface it loudly rather than hiding it.
    console.error(
      "[escalate] lock was reclaimed mid-run (lease expired >60s); " +
        "another run owns the desk now — check for duplicate cards",
    );
  }
}

async function withEscalateLock<T>(
  journal: Journal,
  fn: () => Promise<T>,
): Promise<T> {
  const lockFile = join(dirname(journal.path), ".escalate.lock");
  const reclaimMarker = `${lockFile}.reclaiming`;
  const lease = await acquireLease(lockFile, reclaimMarker);
  const { heartbeat, lostOwnership } = startHeartbeat(lease);
  try {
    return await fn();
  } finally {
    releaseLease(lease, heartbeat, lostOwnership);
  }
}

/**
 * One card's post/edit/journal state machine, isolated from map
 * orchestration (announce-once for fresh cards, edit-on-change for repeats,
 * transient failures returned as outcomes — never thrown).
 */
type SyncOutcome =
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
interface CardBudget {
  remaining: number;
  deadline: number;
}

/** One pass's wall-clock budget: after this the pass defers remaining cards
 *  and returns, so the escalation lane never blocks the walk lane (the tick
 *  awaits escalateMaps before walk). */
const MAX_PASS_MS = 120_000;
/** Bounded total rows the absent-card reconciliation may scan (offset
 *  pagination past needed rows) — a large drain must not walk the whole
 *  journal (round-27 review). */
const MAX_ABSENT_SCAN = 500;
/** Timeout on every graph CLI call the escalation pass makes — a hung `soma`
 *  command must not hold the tick (and hence walk) indefinitely (round-29
 *  blocker). Generous: the CLI responds in seconds; this covers slow networks
 *  without letting a hang block the pass bound. */
const GRAPH_CALL_TIMEOUT_MS = 60_000;

/** Shared context for one card's sync lifecycle — the per-card derivations
 *  (key, age, content) plus the pass context, so post/edit/recover/migrate
 *  live as focused module-level helpers instead of coupled closures
 *  (round-31 suggestion). */
interface CardSyncContext {
  client: EscalationDiscord;
  clientFor: (channelId: string) => EscalationDiscord;
  journal: Journal;
  map: RangerMapConfig;
  config: RangerConfig;
  now: Date;
  budget: CardBudget;
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
  const { client, journal, budget, node, now } = ctx;
  if (!charge(budget)) return { action: "deferred", id: node.id };
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
  ctx: {
    client: EscalationDiscord;
    clientFor: (channelId: string) => EscalationDiscord;
    journal: Journal;
    map: RangerMapConfig;
    config: RangerConfig;
    now: Date;
    budget: CardBudget;
  },
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
    return await editInPlace(cardCtx, prior.messageId, content, prior.createdAt);
  } catch (cardError) {
    // A transient Discord failure on one card must not fail the whole desk —
    // the card retries next tick (announce-once stays intact: a failed post
    // writes no row, a failed edit keeps its row).
    return {
      action: "error" as const,
      id: node.id,
      error:
        cardError instanceof Error ? cardError.message : String(cardError),
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
async function markAbsentCards(
  ctx: {
    client: EscalationDiscord;
    journal: Journal;
    map: RangerMapConfig;
    now: Date;
    budget: CardBudget;
  },
  neededIds: ReadonlySet<string>,
): Promise<{ keptOpen: string[]; deferred: string[]; errors: string[] }> {
  const { client, journal, map, now, budget } = ctx;
  // Reconcile ONLY open, un-noted cards ABSENT from the current frontier — a
  // no-op tick never loads (or skips) the active cards (round-19 review), and
  // a noted card drops out entirely. Closing resolved cards (which shrinks
  // the open set) is the write-side resolution lifecycle (node #21). The
  // candidate selection (bounded + cursor-swept past needed rows) is
  // `selectAbsentCards`; the per-card destination reconciliation is
  // `reconcileAbsentCard`.
  const usable = selectAbsentCards(journal, map.repo, neededIds, budget);
  const clientFor = channelClientFor(client);
  const reconcileCtx = { clientFor, journal, map, now, budget };
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
    const batch = journal.listUnreconciledOpen(repo, neededIds, {
      limit: scanPage,
      after,
    });
    scanned += batch.length;
    openCards.push(...batch.filter((row) => !neededIds.has(row.nodeId)));
    if (batch.length < scanPage) {
      reachedEnd = true; // swept the whole set — reset the cursor next tick
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
  },
  prior: EscalationRow,
): Promise<AbsentOutcome> {
  const { clientFor, journal, map, now, budget } = ctx;
  const nodeId = prior.nodeId;
  const content = queueExitContent(nodeId, prior.title, map.repo);
  try {
    // Reconcile EVERY destination's card: a card that moved channels still
    // holds a live, actionable message in each visited channel — write the
    // queue-exit note to all of them so none stays active-looking (round-19
    // review). Legacy rows (pre-0006, no destination rows) fall back to the
    // row's own channel/message when known.
    const stored = journal.getEscalationDestinations(`${map.repo}:${nodeId}`);
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
    let anyEdit = false;
    for (const dest of destinations) {
      if (!charge(budget)) return { action: "deferred", id: nodeId };
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
    // Set notedAt only after every destination reconciled (or a definitive
    // 404 each); a transient failure throws → retried next tick.
    journal.upsertEscalation({
      key: `${map.repo}:${nodeId}`,
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
      action: (anyEdit ? "keptOpen" : "unchanged") as
        | "keptOpen"
        | "unchanged",
      id: nodeId,
    };
  } catch (cardError) {
    // A transient failure on one card must not fail the desk — it retries
    // next tick and the card stays open.
    return {
      action: "error" as const,
      id: nodeId,
      error:
        cardError instanceof Error ? cardError.message : String(cardError),
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

function ageText(
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
function cardFrom(
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

function cardNeeded(node: ClassifiedNode): boolean {
  return (
    node.route.route === "escalate-hitl" || node.route.route === "provisioning"
  );
}

/**
 * Shared map-context setup for the cards and digest runs: read-only token
 * (no keyring fallback) + the per-map Discord client. One place for the
 * policy; both runs use it so they can't drift.
 */
async function resolveDeskContext(
  config: RangerConfig,
  map: RangerMapConfig,
): Promise<{ token: ResolvedToken; client: EscalationDiscord }> {
  const { token } = await assertReadOnlyToken(config, map.repo);
  const client = EscalationDiscord.fromMap(map, config.principal.discordId);
  return { token, client };
}

async function escalateOneMap(
  config: RangerConfig,
  map: RangerMapConfig,
  journal: Journal,
  registry: ReturnType<typeof loadProbeRegistry>,
  now: Date,
  passDeadline: number,
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
    return { ...base, ok: false, error: "pass deadline reached before this map" };
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

    // Bound the pass so a large frontier can't hold this tick past the walk
    // interval. TWO bounds work together (rounds 21–24):
    //  1. A REQUEST budget charged only when syncCard actually POSTs/EDITs
    //     (unchanged no-op cards are free) — caps logical card operations at
    //     50. NOTE: the budget counts one POST/PATCH per card op, not raw
    //     HTTP calls — a rate-limited op retries per the client's own 429
    //     policy (each PATCH/POST can make up to 4 fetchOnce calls), so under
    //     heavy rate-limiting the wall time per op grows and a tick may not
    //     finish its 50 ops before the next one — the desk converges over
    //     ticks (round-25 review).
    //  2. A PAGE of candidate nodes evaluated this tick, swept through the
    //     frontier via a persisted cursor — caps the SQL lookup (SQLite bind
    //     limit) and the render+decision walk, and nothing starves: the
    //     cursor advances each tick, so every needed node is eventually
    //     evaluated, and fresh cards (no row) within the page go first.
    const budget = {
      remaining: MAX_CARDS_PER_TICK,
      deadline: passDeadline,
    };
    const cursorKey = `escalate.cursor.${map.repo}`;
    const sorted = [...needed].sort((a, b) => a.id.localeCompare(b.id));
    const pageSize = MAX_CARDS_PER_TICK * 2;
    const offset =
      sorted.length === 0
        ? 0
        : (journal.getInt(cursorKey) % sorted.length);
    const page = sorted
      .slice(offset, offset + pageSize)
      .concat(
        offset + pageSize > sorted.length
          ? sorted.slice(0, (offset + pageSize) % sorted.length)
          : [],
      );
    if (sorted.length > 0) {
      journal.setHealth(
        cursorKey,
        String((offset + pageSize) % sorted.length),
      );
    }

    // The active pass needs ONLY the rows for the nodes in this tick's page
    // — query them directly instead of scanning the whole repo's escalation
    // history every 15-minute tick (round-15 review). The absent-card pass
    // separately queries open cards.
    const existing = journal.getEscalations(
      map.repo,
      page.map((n) => n.id),
    );
    // Fresh cards (no row yet) announce before page re-edits — they are the
    // urgent ones and must not wait behind a sweep of already-synced cards.
    const pageOrder = page
      .filter((n) => !existing.has(n.id))
      .concat(page.filter((n) => existing.has(n.id)));

    const cards: EscalationCard[] = [];
    const clientFor = channelClientFor(client);
    const outcomes = await mapPool(pageOrder, 3, (node) =>
      syncCard(
        { client, clientFor, journal, map, config, now, budget },
        node,
        existing.get(node.id),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.action === "deferred") {
        base.deferred.push(outcome.id);
      } else if (
        outcome.action === "posted" ||
        outcome.action === "edited" ||
        outcome.action === "unchanged"
      ) {
        cards.push(outcome.card);
      } else {
        base.cardErrors.push(`#${outcome.id}: ${outcome.error}`);
      }
      if (outcome.action === "posted") base.posted.push(outcome.id);
      else if (outcome.action === "edited") base.edited.push(outcome.id);
    }

    const neededIds = new Set(needed.map((n) => n.id));
    const absent = await markAbsentCards(
      { client, journal, map, now, budget },
      neededIds,
    );
    base.keptOpen.push(...absent.keptOpen);
    base.deferred.push(...absent.deferred);
    base.cardErrors.push(...absent.errors);

    return { ...base, cards };
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
  return withEscalateLock(journal, async () => {
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
        ),
      );
    }
    return { generatedAt: now.toISOString(), maps };
  });
}

// ---- the daily digest ----

interface DigestCard {
  nodeId: string;
  title: string;
  route: string;
  ageDays: number;
  messageId: string;
}

interface DigestMapResult {
  repo: string;
  /** discriminates digest results from cards-pass results in renderers. */
  kind: "digest";
  ok: boolean;
  error?: string;
  cards: DigestCard[];
  receiptLessCloses: string[];
  openWithoutCheckpoint: string[];
  openClaims: { id: string; assignees: string[] }[];
  budget: {
    spawnsToday: number;
    spawnCapPerDay: number;
    deadman: number;
    paused: boolean;
  };
  digestMessageId: string;
  posted: boolean;
  /** what happened to today's digest message: fresh post | in-place edit | no-op. */
  action: "posted" | "edited" | "unchanged";
}

export interface DigestResult {
  generatedAt: string;
  maps: DigestMapResult[];
}

interface DigestInputs {
  map: RangerMapConfig;
  cards: DigestCard[];
  /** total open cards (cards is capped at what the message can render). */
  openCount: number;
  /** age-band counts over ALL open cards (the header must not under-report
   *  an overdue card that falls outside the rendered ≤15 list). */
  ageCounts: { aged: number; overdue: number };
  audit: AuditResult;
  budget: DigestMapResult["budget"];
  principal: string;
  principalDiscordId?: string;
  now: Date;
}

function digestContent(inputs: DigestInputs): string {
  const {
    map,
    cards,
    openCount,
    ageCounts,
    audit,
    budget,
    principal,
    principalDiscordId,
    now,
  } = inputs;
  const header = [
    `:newspaper: **ranger digest** — ${map.repo} (root ${map.root}, walk: ${map.walk}) · ${localDateKey(now)}`,
    "",
    `**Cards: ${openCount}**${ageCounts.aged > 0 ? ` (${ageCounts.aged} aged 3+d, ${ageCounts.overdue} 7+d${principalDiscordId ? " @-mentioned" : " no ping"})` : ""}`,
  ];
  const summarize = (items: string[], max: number): string => {
    if (items.length === 0) return "";
    // Every item is graph-derived — sanitize so a crafted `<@principal-id>`
    // audit value can't ping the principal before the 7-day policy
    // (round-26 review).
    const inert = items.map(sanitizeGraphText);
    const head = inert.slice(0, max).join(", ");
    return items.length > max
      ? `${head}, …+${items.length - max}`
      : head;
  };
  const auditLines: string[] = [
    `**Audit:** receipt-less closes ${audit.closedWithoutReceipt.length}${audit.closedWithoutReceipt.length > 0 ? ` (${summarize(audit.closedWithoutReceipt, 8)})` : ""} · open w/o checkpoint ${audit.openWithoutCheckpoint.length}${audit.openWithoutCheckpoint.length > 0 ? ` (${summarize(audit.openWithoutCheckpoint, 8)})` : ""} · open claims ${audit.openClaimed.length}`,
  ];
  if (audit.openClaimed.length > 0) {
    for (const c of audit.openClaimed.slice(0, 8)) {
      auditLines.push(
        `    #${sanitizeGraphText(c.id)} [${c.assignees.map(sanitizeGraphText).join(", ")}]`,
      );
    }
    if (audit.openClaimed.length > 8) {
      auditLines.push(
        `    … and ${audit.openClaimed.length - 8} more open claims`,
      );
    }
  }
  const budgetLine = `**Budget:** spawns today ${budget.spawnsToday}/${budget.spawnCapPerDay} · dead-man ${budget.deadman} · ${budget.paused ? "PAUSED" : "running"}`;
  // Reserve room for the audit + budget sections so a long card list can
  // never evict the promised parts of a "cards + audit + budget" digest —
  // the card list is capped to fit, not the tail sliced off.
  const reserved =
    header.join("\n").length +
    2 +
    auditLines.join("\n").length +
    1 +
    budgetLine.length;
  const cardBudget = 1950 - reserved - 80; // +80 slack for the "… N more" line
  const cardLines: string[] = [];
  if (cards.length === 0) {
    cardLines.push("  none open — clean");
  } else {
    let shown = 0;
    for (const card of cards) {
      if (shown >= 15) break; // hard cap on per-message card count
      const band = ageBand(card.ageDays);
      const line = `  #${sanitizeGraphText(card.nodeId)} ${sanitizeGraphText(card.title)} — ${card.route} · ${ageText(
        band,
        card.ageDays,
        principal,
        principalDiscordId,
      )}`;
      if (
        cardBudget > 0 &&
        cardLines.join("\n").length + line.length + 1 > cardBudget
      ) {
        break; // stop before the promised sections would be evicted
      }
      cardLines.push(line);
      shown++;
    }
    // skipped counts against the TRUE total (openCount), not the capped
    // query's length — with 16+ open cards the query returns 15 but the
    // remainder must still be reported (round-20 review).
    const skipped = openCount - shown;
    if (skipped > 0) {
      cardLines.push(
        `  … and ${skipped} more open cards (full list in the thread)`,
      );
    }
  }
  const joined = [...header, ...cardLines, "", ...auditLines, budgetLine].join(
    "\n",
  );
  // Final guard (should not trigger — audit/budget are reserved above).
  return joined.length > 1950 ? `${joined.slice(0, 1949)}…` : joined;
}

async function digestOneMap(
  config: RangerConfig,
  map: RangerMapConfig,
  journal: Journal,
  now: Date,
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
      timeoutMs: Math.min(GRAPH_CALL_TIMEOUT_MS, remainingMs || GRAPH_CALL_TIMEOUT_MS),
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

    // Digest is edit-not-repost within a day — and edit-on-change within the
    // day: cache {today, messageId, lastContent}; a new (host-local) day posts
    // a fresh digest, a same-day content change edits in place, and an
    // unchanged same-day digest is a no-op (no Discord write — re-runs must
    // not churn rate limits).
    const today = localDateKey(now);
    const cachedRaw = journal.getHealth(`digest.${map.repo}`);
    let cached: {
      today: string;
      messageId: string;
      lastContent: string;
    } | null = null;
    if (cachedRaw !== null) {
      try {
        cached = JSON.parse(cachedRaw) as {
          today: string;
          messageId: string;
          lastContent: string;
        };
      } catch {
        cached = null; // pre-edit-on-change cache format — treat as fresh
      }
    }
    let messageId = "";
    let posted = false;
    let edited = false;
    if (cached !== null && cached.today === today) {
      messageId = cached.messageId;
      if (cached.lastContent === content) {
        // Unchanged same-day digest is a write no-op — but a DELETED cached
        // message is only noticed via a read. Verify it still exists; if it
        // is definitively gone (404), repost so the daily audit/budget digest
        // never silently vanishes.
        if (!(await client.messageExists(messageId, digestDeadline))) {
          messageId = await client.post(content, digestDeadline);
          posted = true;
        }
      } else {
        try {
          await client.edit(messageId, content, digestDeadline);
          edited = true;
        } catch (editError) {
          if (!(editError instanceof DiscordMessageGoneError)) throw editError;
          // The cached digest message was deleted (or moved): post a fresh
          // digest and replace the cached message id — otherwise unchanged
          // runs would no-op against the stale cache and leave NO digest
          // until the next day.
          messageId = await client.post(content, digestDeadline);
          posted = true;
        }
      }
      journal.setHealth(
        `digest.${map.repo}`,
        JSON.stringify({ today, messageId, lastContent: content }),
      );
    } else {
      messageId = await client.post(content, digestDeadline);
      journal.setHealth(
        `digest.${map.repo}`,
        JSON.stringify({ today, messageId, lastContent: content }),
      );
      posted = true;
    }

    return {
      ...base,
      cards: open,
      receiptLessCloses: audit.closedWithoutReceipt,
      openWithoutCheckpoint: audit.openWithoutCheckpoint,
      openClaims: audit.openClaimed,
      digestMessageId: messageId,
      posted,
      // Honest label for the operator: fresh post | in-place edit | no-op.
      action: digestAction(posted, edited),
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
  return withEscalateLock(journal, async () => {
    const now = opts.now ?? new Date();
    const maps: DigestMapResult[] = [];
    for (const map of config.maps) {
      maps.push(await digestOneMap(config, map, journal, now));
    }
    return { generatedAt: now.toISOString(), maps };
  });
}

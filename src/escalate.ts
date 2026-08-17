import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { resolveDiscordApiBase } from "./discord.ts";
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

class EscalateError extends Error {
  override name = "EscalateError";
}

/** A PATCH targeted a message that is not in the current channel — the
 *  destination moved (or the card was deleted); the caller reposts. */
class DiscordMessageGoneError extends EscalateError {
  override readonly name = "DiscordMessageGoneError";
}

// ---- Discord card client (POST announce / PATCH edit) ----

/**
 * Cap on any client-wide Discord cooldown (a global 429's Retry-After): a
 * long retry must not hold the tick — and hence the walk lane — indefinitely
 * (round-26 review). After the cap the client resumes and retries, and the
 * attempt budget defers the card rather than sleeping the whole cooldown.
 */
const MAX_COOLDOWN_MS = 30_000;

export class EscalationDiscord {
  /**
   * Minimum spacing between API calls from one client — Discord throttles
   * message writes per channel (~5/5s for bots), and a pooled pass of many
   * cards would otherwise trip 429s (observed live). Test seam:
   * `RANGER_DISCORD_MIN_INTERVAL_MS` shrinks it so e2e suites stay fast.
   */
  private readonly minIntervalMs =
    Number(process.env.RANGER_DISCORD_MIN_INTERVAL_MS) || 1000;
  private lastRequestAt = 0;
  /** Client-wide pause (epoch ms): set on a global 429 so POOLED requests —
   *  not just the one that got the 429 — wait it out before sending. Without
   *  this, concurrent cards already past the throttle fire into a hot bucket
   *  and extend the cooldown (observed live). */
  private cooldownUntil = 0;

  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly apiBase: string = resolveDiscordApiBase(),
    private readonly principalDiscordId?: string,
  ) {}

  /** The configured Discord channel this client posts/edits in. */
  get channel(): string {
    return this.channelId;
  }

  /** A client for a DIFFERENT channel, sharing token/base/principal config.
   *  Used to reconcile a card that lives in a channel the map moved away
   *  from (patch its queue-exit note where it actually is). */
  forChannel(channelId: string): EscalationDiscord {
    return new EscalationDiscord(
      this.token,
      channelId,
      this.apiBase,
      this.principalDiscordId,
    );
  }

  static fromMap(
    map: RangerMapConfig,
    principalDiscordId?: string,
    env: NodeJS.ProcessEnv = process.env,
  ): EscalationDiscord {
    if (map.discord === undefined) {
      throw new EscalateError(
        `map ${map.repo} has no discord surface — cannot post escalation cards. ` +
          `Add a discord.tokenEnv + channelId to the map (node #7).`,
      );
    }
    const token = env[map.discord.tokenEnv];
    if (token === undefined || token.length === 0) {
      throw new EscalateError(
        `discord token env ${map.discord.tokenEnv} is unset — cannot post escalation cards for ${map.repo}.`,
      );
    }
    return new EscalationDiscord(
      token,
      map.discord.channelId,
      undefined,
      principalDiscordId,
    );
  }

  /** Wait out any client-wide cooldown (a global 429) before sending. */
  private async waitForCooldown(): Promise<void> {
    while (this.cooldownUntil > Date.now()) {
      await sleep(Math.min(250, this.cooldownUntil - Date.now()));
    }
    this.cooldownUntil = 0;
  }

  /**
   * One throttled, cooldown-aware, timeout-bounded fetch — the shared setup
   * for every Discord write AND read (writes and existence checks can't
   * drift on throttling/timeout behavior). Throws on network errors/timeout.
   */
  private async fetchOnce(
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH";
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<Response> {
    await this.waitForCooldown();
    await this.throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(`${this.apiBase}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(init.headers ?? {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    method: "POST" | "PATCH",
    path: string,
    content: string,
  ): Promise<Response> {
    // Every call times out — a run can never stall indefinitely holding the
    // announce-once lock. Calls are spaced ≥1s apart. On a rate limit (429),
    // a GLOBAL cooldown must be waited out in full — retrying into it just
    // resets the bucket and extends the throttle (observed live) — so a global
    // 429 waits max(Retry-After, 30s); a local 429 waits Retry-After.
    const maxAttempts = 4;
    let lastStatus = 0;
    let firstRetryAfterSec = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchOnce(path, {
          method,
          headers: { "Content-Type": "application/json" },
          // parse: [] suppresses untrusted @everyone/@here/role mentions in
          // graph-derived content; only the principal's id (when configured)
          // is allowed to ping.
          body: JSON.stringify({
            content,
            allowed_mentions: {
              parse: [],
              users: this.principalDiscordId ? [this.principalDiscordId] : [],
            },
          }),
        });
      } catch (error) {
        throw new EscalateError(
          `discord ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status !== 429 && response.status < 500) {
        return response;
      }
      lastStatus = response.status;
      const retryAfter = Number(response.headers.get("retry-after"));
      if (attempt === 1) {
        firstRetryAfterSec = Number.isFinite(retryAfter) ? retryAfter : 0;
      }
      const global = response.headers.get("x-ratelimit-global") !== null;
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** (attempt - 1);
      if (global) {
        // Advance the client-wide deadline so every pooled request waits
        // this out too, not just this one. CAPPED at MAX_COOLDOWN_MS: an
        // arbitrary Retry-After (Discord can return minutes-to-an-hour) must
        // not hold the tick — and hence the walk lane — for that long
        // (round-26 review: "escalation never blocks walking"). After the
        // cap the request resumes, likely 429s again, and the attempt budget
        // eventually defers the card rather than sleeping the whole cooldown.
        const cooldownMs = Math.max(waitMs, 30_000);
        this.cooldownUntil = Math.min(
          Math.max(this.cooldownUntil, Date.now() + cooldownMs),
          Date.now() + MAX_COOLDOWN_MS,
        );
      }
      // A long first cooldown (>30s) means the card is hot; retrying into it
      // just extends it (observed live) — fail fast so the card is deferred
      // to next tick instead of hammering.
      if (attempt === 1 && firstRetryAfterSec > 30) {
        break;
      }
      await sleep(global ? Math.max(waitMs, 30_000) : Math.min(waitMs, 30_000));
    }
    throw new EscalateError(
      `discord ${method} ${path} failed after ${lastStatus === 0 ? "setup" : maxAttempts} attempts (last HTTP ${lastStatus}${firstRetryAfterSec > 0 ? `, retry-after ${firstRetryAfterSec}s` : ""})`,
    );
  }

  /** Space calls from this client apart so a pooled pass stays rate-limit-safe.
   *  The slot is reserved synchronously BEFORE any await, so concurrent
   *  callers line up at 1s offsets instead of sleeping the same delay and
   *  waking together (a burst that re-triggers the 429s). */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const target = Math.max(this.lastRequestAt + this.minIntervalMs, now);
    this.lastRequestAt = target; // reserve — atomic within the event loop
    const wait = target - now;
    if (wait > 0) {
      await sleep(wait);
    }
  }

  /** Post a new card; returns the Discord message id (announce-once). */
  async post(content: string): Promise<string> {
    const response = await this.request(
      "POST",
      `/channels/${this.channelId}/messages`,
      content,
    );
    if (!response.ok) {
      throw new EscalateError(`discord post returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: string };
    if (typeof body.id !== "string" || body.id.length === 0) {
      throw new EscalateError("discord post returned no message id");
    }
    return body.id;
  }

  /** Edit an existing card in place (edit-not-repost). */
  async edit(messageId: string, content: string): Promise<void> {
    const response = await this.request(
      "PATCH",
      `/channels/${this.channelId}/messages/${messageId}`,
      content,
    );
    // 404 = the message is not in THIS channel — the destination moved (or
    // the card was deleted). Surface it distinctly so the caller can repost
    // fresh instead of retrying a doomed edit every tick.
    if (response.status === 404) {
      throw new DiscordMessageGoneError(
        `discord message ${messageId} is not in channel ${this.channelId} — destination moved; repost needed`,
      );
    }
    if (!response.ok) {
      throw new EscalateError(
        `discord edit ${messageId} returned HTTP ${response.status}`,
      );
    }
  }

  /**
   * Does a message still exist in this channel? The digest's unchanged
   * same-day path is a write-no-op, so a DELETED message is only noticed via
   * a read — return false on a definitive 404 so the caller reposts. On a
   * transient read failure (5xx, network, timeout) assume it exists: a repost
   * decision must never be made on an unreliable read.
   */
  async messageExists(messageId: string): Promise<boolean> {
    const path = `/channels/${this.channelId}/messages/${messageId}`;
    let response: Response;
    try {
      response = await this.fetchOnce(path, { method: "GET" });
    } catch {
      return true; // transient read failure — do not repost on a guess
    }
    if (response.status === 404) return false;
    // A 5xx is transient — retry a couple of times before falling back to
    // "assume it exists" (a repost must never be based on an unreliable
    // read; a persistent 5xx is an outage, not a deletion).
    if (response.status >= 500) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await sleep(500 * (attempt + 1));
        try {
          response = await this.fetchOnce(path, { method: "GET" });
        } catch {
          return true;
        }
        if (response.status === 404) return false;
        if (response.status < 500) break;
      }
    }
    // 2xx / 401 / 403 / persistent 5xx — NOT a definitive delete.
    return true;
  }
}

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
  status: "open" | "resolved";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // Leased lock: an expired lease is a definitive signal the holder is gone
    // (its heartbeat stopped). This is what makes PID-reuse reclaimable while
    // never touching a live run's renewed lock.
    if (typeof prior.leaseUntil === "number" && prior.leaseUntil < Date.now()) {
      return true;
    }
    // Legacy / marker fallback: dead pid OR old enough to be a crash.
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
  const { client, clientFor, journal, map, config, now, budget } = ctx;
  const ageDays = prior === undefined ? 0 : dayDiff(prior.createdAt, now);
  const content = cardContent(
    node,
    map,
    ageDays,
    config.principal.login,
    config.principal.discordId,
  );
  const key = `${map.repo}:${node.id}`;
  /** One row assembly shared by post and edit — card fields live in one place. */
  const escalationRow = (params: {
    messageId: string;
    lastContent: string;
    createdAt: string;
    lastEditedAt?: string;
  }) => ({
    key,
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
  });
  /** Persist the card row and build the outcome — the shared tail of every
   *  successful post/edit. */
  const saveAndReturn = (
    row: ReturnType<typeof escalationRow>,
    action: "posted" | "edited",
  ): SyncOutcome => {
    journal.upsertEscalation(row);
    return { action, id: node.id, card: cardFrom(node, row, ageDays) };
  };
  /** Post a fresh card in the client's channel + record row + destination. */
  const postFresh = async (): Promise<SyncOutcome> => {
    if (!charge(budget)) return { action: "deferred", id: node.id };
    // A reposted card (moved channel / message gone) is the SAME unresolved
    // escalation, re-surfaced WITH ITS AGE (design §5 "edited not reposted,
    // re-surfaced with age") — a channel move must not erase a card's
    // 3/7-day escalation state (round-23 review). New cards (prior undefined)
    // render age 0.
    const freshContent = cardContent(
      node,
      map,
      ageDays,
      config.principal.login,
      config.principal.discordId,
    );
    const messageId = await client.post(freshContent);
    const row = escalationRow({
      messageId,
      lastContent: freshContent,
      // Immutable first-appearance timestamp: the card's age is its age
      // since it first appeared, preserved across reposts. The per-destination
      // created_at (escalation_destinations) tracks each channel visit for
      // recovery, not the card's age.
      createdAt: prior?.createdAt ?? now.toISOString(),
    });
    journal.setEscalationDestination(
      key,
      client.channel,
      messageId,
      now.toISOString(),
    );
    return saveAndReturn(row, "posted");
  };
  /** Edit a card message in place; if the message is gone (deleted or in a
   *  moved channel), repost fresh instead of retrying a doomed edit. */
  const editInPlace = async (
    messageId: string,
    editContent: string,
    createdAt: string,
  ): Promise<SyncOutcome> => {
    if (!charge(budget)) return { action: "deferred", id: node.id };
    try {
      await client.edit(messageId, editContent);
    } catch (cardError) {
      if (cardError instanceof DiscordMessageGoneError) {
        return await postFresh();
      }
      throw cardError;
    }
    const row = escalationRow({
      messageId,
      lastContent: editContent,
      createdAt,
      lastEditedAt: now.toISOString(),
    });
    return saveAndReturn(row, "edited");
  };
  /** A card whose destination channel moved: recover its existing message in
   *  the CURRENT channel if one exists (edit in place, age kept — it is the
   *  same card), else post fresh — never a duplicate while a channel is
   *  re-visited (destination recovery, round-14/15). */
  /** Edit the card we're LEAVING (in the prior channel) to a "moved" note —
   *  one active card per escalation: a channel move must not leave the old
   *  card active-looking (round-25 review, resolves the round-23 stale-B
   *  gap). A 404 (already gone) is fine; a deferral aborts the move so we
   *  never create a second active card without retiring the first. */
  const noteMoved = async (
   priorChannelId: string | null,
   priorMessageId: string,
  ): Promise<"noted" | SyncOutcome> => {
   // The caller only routes here when prior.channelId is a real, different
   // channel, but TS can't carry that narrowing through — a null is a
   // legacy row with no channel to note (nothing to do).
   if (priorChannelId === null) return "noted";
   if (!charge(budget)) return { action: "deferred", id: node.id };
   try {
    await clientFor(priorChannelId).edit(
     priorMessageId,
     movedCardNote(node.id, node.title, client.channel),
    );
    return "noted";
   } catch (cardError) {
    if (cardError instanceof DiscordMessageGoneError) {
     return "noted"; // already gone — nothing to note
    }
    throw cardError;
   }
  };
  const syncMovedCard = async (prior: EscalationRow): Promise<SyncOutcome> => {
   const noted = await noteMoved(prior.channelId, prior.messageId);
   if (noted !== "noted") return noted;
   const recoveredId = journal.getEscalationDestination(key, client.channel);
   if (recoveredId !== null) {
    return editInPlace(recoveredId, content, prior.createdAt);
   }
   return postFresh();
  };
  try {
    if (prior === undefined) {
      return await postFresh();
    }
    if (prior.channelId !== null && prior.channelId !== client.channel) {
      return await syncMovedCard(prior);
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
    return await editInPlace(prior.messageId, content, prior.createdAt);
  } catch (cardError) {
    // A transient Discord failure on one card must not fail the whole desk —
    // the card retries next tick (announce-once stays intact: a failed post
    // writes no row, a failed edit keeps its row).
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
  // the open set) is the write-side resolution lifecycle (node #21).
  // Cap the LOAD to the remaining request budget (oldest exits first): each
  // card needs ≥1 destination edit, so loading more than the budget could
  // never be fully processed this tick — and a large drain must not walk
  // every unnoted card after the budget is spent (round-23 review). The SQL
  // NOT IN exclusion is capped too (bind limit); JS-filtering against the
  // FULL needed set here preserves correctness at any frontier size — a
  // needed card that slipped past the truncated exclusion is never treated
  // as absent (round-26 review).
  let openCards = journal.listUnreconciledOpen(map.repo, neededIds, {
    limit: Math.max(budget.remaining, 0),
  });
  openCards = openCards.filter((row) => !neededIds.has(row.nodeId));
  const clientFor = channelClientFor(client);
  const outcomes = await mapPool(openCards, 3, async (prior) => {
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
        // The reconciliation shares the SAME per-tick request budget as the
        // active pass — a mass queue exit can't blow the 50-request bound
        // and starve the tick (round-22 review). A deferred card keeps its
        // notedAt null and is re-reconciled next tick.
        if (!charge(budget)) return { action: "deferred", id: nodeId };
        try {
          await clientFor(dest.channelId).edit(dest.messageId, content);
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
  });
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
  // Mention-inert (a graph id/title can't ping), non-actionable: the active
  // card lives in the current channel.
  return `~~**#${sanitizeGraphText(nodeId)}** ${sanitizeGraphText(title ?? "")}~~ moved to channel ${channelId} — the active card is in the new channel`;
}

/** The deterministic queue-exit note — one source of truth for card content. */
function queueExitContent(
  nodeId: string,
  title: string | null,
  repo: string,
): string {
  return [
    `~~**#${sanitizeGraphText(nodeId)}** ${sanitizeGraphText(title ?? "")}~~ no longer on the HITL/provisioning queue`,
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
    const frontier = await graphFrontier(map.repo, map.root, token);

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
      deadline: Date.now() + MAX_PASS_MS,
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
    const registry = loadProbeRegistry();
    const maps: EscalateMapResult[] = [];
    for (const map of config.maps) {
      maps.push(await escalateOneMap(config, map, journal, registry, now));
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
    const audit = await graphAudit(map.repo, map.root, token);
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
        if (!(await client.messageExists(messageId))) {
          messageId = await client.post(content);
          posted = true;
        }
      } else {
        try {
          await client.edit(messageId, content);
          edited = true;
        } catch (editError) {
          if (!(editError instanceof DiscordMessageGoneError)) throw editError;
          // The cached digest message was deleted (or moved): post a fresh
          // digest and replace the cached message id — otherwise unchanged
          // runs would no-op against the stale cache and leave NO digest
          // until the next day.
          messageId = await client.post(content);
          posted = true;
        }
      }
      journal.setHealth(
        `digest.${map.repo}`,
        JSON.stringify({ today, messageId, lastContent: content }),
      );
    } else {
      messageId = await client.post(content);
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

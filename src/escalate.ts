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
) {
 }

 /** The configured Discord channel this client posts/edits in. */
 get channel(): string {
  return this.channelId;
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
      // A global cooldown applies to every request on this client — wait it
      // out BEFORE reserving a throttle slot, so pooled cards that finished
      // a cooldown re-serialize through the throttle instead of firing
      // together with now-expired reservations (re-triggering 429s).
      await this.waitForCooldown();
      await this.throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(`${this.apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            "Content-Type": "application/json",
          },
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
          signal: controller.signal,
        });
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
          // this out too, not just this one.
          const cooldownMs = Math.max(waitMs, 30_000);
          this.cooldownUntil = Math.max(
            this.cooldownUntil,
            Date.now() + cooldownMs,
          );
        }
        // A long first cooldown (>30s) means the card is hot; retrying into it
        // just extends it (observed live) — fail fast so the card is deferred
        // to next tick instead of hammering.
        if (attempt === 1 && firstRetryAfterSec > 30) {
          break;
        }
        await sleep(
          global ? Math.max(waitMs, 30_000) : Math.min(waitMs, 30_000),
        );
      } catch (error) {
        throw new EscalateError(
          `discord ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
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

function cardContent(
  node: ClassifiedNode,
  map: { repo: string },
  ageDays: number,
  principal: string,
  principalDiscordId?: string,
): string {
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
  const bodyText =
    node.route.route === "escalate-hitl" &&
    node.body !== undefined &&
    node.body.trim().length > 0
      ? sanitizeGraphText(node.body)
      : null;
  const prefixLines = [
    // Every graph-derived interpolation is mention-inerted (a graph author
    // can set kind/autonomy/title/url to `<@principal-id>`), and the title
    // is capped so a giant title can't evict the decision body or the suffix.
    `${cardHead(node)} — **#${node.id}** ${truncate(sanitizeGraphText(node.title), 200)}`,
    `map: ${map.repo} · ${sanitizeGraphText(node.kind)} · ${sanitizeGraphText(node.autonomy)}`,
    `url: ${sanitizeGraphText(node.url)}`,
    node.checkpointId !== undefined && node.checkpointId.length > 0
      ? `checkpoint: \`${sanitizeGraphText(node.checkpointId)}\``
      : null,
    reason ? `_${reason}_` : null,
  ].filter((line): line is string => line !== null);
  const suffix = ageSuffix(ageDays, principal, principalDiscordId);
  // The body IS the decision payload (grilling question + prose options) —
  // give it the room the rest of the card leaves up to Discord's message cap
  // rather than an arbitrary truncation that silently omits options. Other
  // HITL kinds stay terse. The assembled card is hard-capped below as a final
  // guard.
  const bodyBudget =
    bodyText === null
      ? 0
      : 1950 - prefixLines.join("\n").length - suffix.length - 8;
  const bodyLine =
    bodyText === null
      ? null
      : `_${truncate(
          bodyText,
          node.kind === "grilling" ? Math.max(120, bodyBudget) : 140,
        )}_`;
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
function lockOwnerDead(lockFile: string): boolean {
  try {
    const prior = JSON.parse(readFileSync(lockFile, "utf8")) as {
      pid?: number;
    };
    if (typeof prior.pid !== "number") return false;
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
      // Someone holds the marker. If its owner is provably dead (a crashed
      // reclaim), remove the stale marker and retry — otherwise a live
      // holder is mid-reclaim and we wait.
      if (!lockOwnerDead(reclaimMarker) || attempt >= 2) {
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
    // only a lock whose owner is STILL dead.
    if (!lockOwnerDead(lockFile)) {
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

async function withEscalateLock<T>(
  journal: Journal,
  fn: () => Promise<T>,
): Promise<T> {
  const lockFile = join(dirname(journal.path), ".escalate.lock");
  const reclaimMarker = `${lockFile}.reclaiming`;
  const started = Date.now();
  const timeoutMs = 60_000;
  const owner = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  for (;;) {
    if (tryAcquireLock(lockFile, owner)) break;
    if (lockOwnerDead(lockFile)) {
      const outcome = reclaimDeadLock(lockFile, reclaimMarker, owner);
      if (outcome === "acquired") break;
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
  try {
    return await fn();
  } finally {
    try {
      rmSync(lockFile, { force: true });
      rmSync(reclaimMarker, { force: true });
    } catch {
      /* best-effort release */
    }
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
  | { action: "error"; id: string; error: string };

async function syncCard(
  ctx: {
    client: EscalationDiscord;
    journal: Journal;
    map: RangerMapConfig;
    config: RangerConfig;
    now: Date;
  },
  node: ClassifiedNode,
  prior: EscalationRow | undefined,
): Promise<SyncOutcome> {
  const { client, journal, map, config, now } = ctx;
  const ageDays = prior === undefined ? 0 : dayDiff(prior.createdAt, now);
  const content = cardContent(
    node,
    map,
    ageDays,
    config.principal.login,
    config.principal.discordId,
  );
  const key = `${map.repo}:${node.id}`;
  /** Post a fresh card in the client's channel + record row + destination.
   *  The card's age restarts — it is new in this channel. */
  const postFresh = async (): Promise<SyncOutcome> => {
    // Render age-0 content INSIDE the post: a reposted card (destination
    // moved or the old message gone) must start fresh — posting content that
    // still shows the old age/ping, then editing it back to 0d on the next
    // pass, would send an erroneous 7-day ping on a brand-new card.
    const freshContent = cardContent(
      node,
      map,
      0,
      config.principal.login,
      config.principal.discordId,
    );
    const messageId = await client.post(freshContent);
    const row = {
      key,
      repo: map.repo,
      nodeId: node.id,
      title: node.title,
      route: node.route.route,
      channelId: client.channel,
      lastContent: freshContent,
      messageId,
      createdAt: now.toISOString(),
      status: "open" as const,
    };
    journal.upsertEscalation(row);
    journal.setEscalationDestination(
      key,
      client.channel,
      messageId,
      now.toISOString(),
    );
    return {
      action: "posted" as const,
      id: node.id,
      card: cardFrom(node, row, 0),
    };
  };
  /** Edit a card message in place; if the message is gone (deleted or in a
   *  moved channel), repost fresh instead of retrying a doomed edit. */
  const editInPlace = async (
    messageId: string,
    editContent: string,
    createdAt: string,
  ): Promise<SyncOutcome> => {
    try {
      await client.edit(messageId, editContent);
    } catch (cardError) {
      if (cardError instanceof DiscordMessageGoneError) {
        return await postFresh();
      }
      throw cardError;
    }
    const row = {
      key,
      repo: map.repo,
      nodeId: node.id,
      title: node.title,
      route: node.route.route,
      channelId: client.channel,
      lastContent: editContent,
      messageId,
      createdAt,
      lastEditedAt: now.toISOString(),
      status: "open" as const,
    };
    journal.upsertEscalation(row);
    return {
      action: "edited" as const,
      id: node.id,
      card: cardFrom(node, row, ageDays),
    };
  };
  try {
    if (prior === undefined) {
      return await postFresh();
    }
    // The card's destination moved (persisted channelId differs from the
    // current channel): if the card already has a message in the current
    // channel from a prior visit, RECOVER it (edit in place, age kept — it
    // is the same card) instead of posting a duplicate; only post fresh the
    // first time a channel is seen.
    if (prior.channelId !== null && prior.channelId !== client.channel) {
      const recoveredId = journal.getEscalationDestination(
        key,
        client.channel,
      );
      if (recoveredId !== null) {
        return await editInPlace(recoveredId, content, prior.createdAt);
      }
      return await postFresh();
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
 },
 neededIds: Set<string>,
): Promise<{ keptOpen: string[]; errors: string[] }> {
 const { client, journal, map, now } = ctx;
 // Open cards only (resolved history is never materialized). Cards already
 // reconciled to the queue-exit note are skipped by content compare, so as
 // cards age the per-pass work stays bounded; only the write-side resolution
 // lifecycle (node #21) closes cards and shrinks the open set itself.
 const openCards = journal.listOpenEscalations(map.repo);
 const outcomes = await mapPool(openCards, 3, async (prior) => {
  const nodeId = prior.nodeId;
  if (neededIds.has(nodeId)) return { action: "skip" as const };
  const content = [
   `~~**#${nodeId}** ${sanitizeGraphText(prior.title ?? "")}~~ no longer on the HITL/provisioning queue`,
   `map: ${map.repo} — card kept open; resolves on a principal response or operator verb`,
  ]
   .filter((l) => l.trim().length > 0)
   .join("\n");
  // Already reconciled to the queue-exit note — a no-op, no Discord write.
  if (prior.lastContent === content) {
   return { action: "unchanged" as const, id: nodeId };
  }
  try {
   // The note lives where the card lives: if the card's destination moved
   // to another channel, leave the row (no repost noise for an absent node).
   if (prior.channelId !== null && prior.channelId !== client.channel) {
    return { action: "unchanged" as const, id: nodeId };
   }
   await client.edit(prior.messageId, content);
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
   });
   return { action: "keptOpen" as const, id: nodeId };
  } catch (cardError) {
   // The card is gone (deleted or the channel moved on a legacy row):
   // nothing to edit — the row persists until an operator verb resolves it.
   // A transient failure retries next tick.
   if (cardError instanceof DiscordMessageGoneError) {
    return { action: "unchanged" as const, id: nodeId };
   }
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
 const errors: string[] = [];
 for (const outcome of outcomes) {
  if (outcome.action === "error") {
   errors.push(`#${outcome.id}: ${outcome.error}`);
  } else if (outcome.action === "keptOpen") {
   keptOpen.push(outcome.id);
  }
 }
 return { keptOpen, errors };
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
    title: row.title ?? `#${row.nodeId}`,
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

    // The active pass needs ONLY the rows for nodes on the frontier now —
    // query them directly instead of scanning the whole repo's escalation
    // history every 15-minute tick (round-15 review: the scan grows as
    // cards accumulate until the write-side resolution lifecycle closes
    // them). The absent-card pass separately queries open cards.
    const existing = new Map(
      needed
        .map((node) => journal.getEscalation(map.repo, node.id))
        .filter((row): row is EscalationRow => row !== null)
        .map((row) => [row.nodeId, row] as const),
    );

    const cards: EscalationCard[] = [];
    const outcomes = await mapPool(needed, 3, (node) =>
      syncCard(
        { client, journal, map, config, now },
        node,
        existing.get(node.id),
      ),
    );
    for (const outcome of outcomes) {
      if (outcome.action === "posted" || outcome.action === "edited") {
        cards.push(outcome.card);
      } else if (outcome.action === "unchanged") {
        cards.push(outcome.card);
      } else {
        base.cardErrors.push(`#${outcome.id}: ${outcome.error}`);
      }
      if (outcome.action === "posted") base.posted.push(outcome.id);
      else if (outcome.action === "edited") base.edited.push(outcome.id);
    }

    const neededIds = new Set(needed.map((n) => n.id));
    const absent = await markAbsentCards(
      { client, journal, map, now },
      neededIds,
    );
    base.keptOpen.push(...absent.keptOpen);
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
}

export interface DigestResult {
  generatedAt: string;
  maps: DigestMapResult[];
}

interface DigestInputs {
  map: RangerMapConfig;
  cards: DigestCard[];
  audit: AuditResult;
  budget: DigestMapResult["budget"];
  principal: string;
  principalDiscordId?: string;
  now: Date;
}

function digestContent(inputs: DigestInputs): string {
  const { map, cards, audit, budget, principal, principalDiscordId, now } =
    inputs;
  const aged = cards.filter((c) => ageBand(c.ageDays) !== "fresh"); // 3+
  const overdue = cards.filter((c) => ageBand(c.ageDays) === "overdue"); // 7+
  const header = [
    `:newspaper: **ranger digest** — ${map.repo} (root ${map.root}, walk: ${map.walk}) · ${localDateKey(now)}`,
    "",
    `**Cards: ${cards.length}**${aged.length > 0 ? ` (${aged.length} aged 3+d, ${overdue.length} 7+d${principalDiscordId ? " @-mentioned" : " no ping"})` : ""}`,
  ];
  const summarize = (items: string[], max: number): string => {
    if (items.length === 0) return "";
    const head = items.slice(0, max).join(", ");
    return items.length > max ? `${head}, …+${items.length - max}` : head;
  };
  const auditLines: string[] = [
    `**Audit:** receipt-less closes ${audit.closedWithoutReceipt.length}${audit.closedWithoutReceipt.length > 0 ? ` (${summarize(audit.closedWithoutReceipt, 8)})` : ""} · open w/o checkpoint ${audit.openWithoutCheckpoint.length}${audit.openWithoutCheckpoint.length > 0 ? ` (${summarize(audit.openWithoutCheckpoint, 8)})` : ""} · open claims ${audit.openClaimed.length}`,
  ];
  if (audit.openClaimed.length > 0) {
    for (const c of audit.openClaimed.slice(0, 8)) {
      auditLines.push(`    #${c.id} [${c.assignees.join(", ")}]`);
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
      const line = `  #${card.nodeId} ${sanitizeGraphText(card.title)} — ${card.route} · ${ageText(
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
    const skipped = cards.length - shown;
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
    // Open cards only — the digest never needs resolved history (suggestion).
    const open = journal.listOpenEscalations(map.repo).map((row) => ({
      nodeId: row.nodeId,
      title: row.title ?? `#${row.nodeId}`,
      route: row.route ?? "escalate-hitl",
      ageDays: dayDiff(row.createdAt, now),
      messageId: row.messageId,
    }));

    const content = digestContent({
      map,
      cards: open,
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
    if (cached !== null && cached.today === today) {
      messageId = cached.messageId;
      if (cached.lastContent !== content) {
        try {
          await client.edit(messageId, content);
        } catch (editError) {
          if (!(editError instanceof DiscordMessageGoneError)) throw editError;
          // The cached digest message was deleted (or moved): post a fresh
          // digest and replace the cached message id — otherwise unchanged
          // runs would no-op against the stale cache and leave NO digest
          // until the next day.
          messageId = await client.post(content);
          posted = true;
        }
        journal.setHealth(
          `digest.${map.repo}`,
          JSON.stringify({ today, messageId, lastContent: content }),
        );
      }
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

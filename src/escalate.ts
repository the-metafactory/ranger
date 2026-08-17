import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  assertReadOnlyToken,
  GateError,
  type ResolvedToken,
} from "./token-gate.ts";
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

export class EscalateError extends Error {
  override readonly name = "EscalateError";
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

  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly apiBase: string = resolveDiscordApiBase(),
    private readonly principalDiscordId?: string,
  ) {}

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
        // A long first cooldown (>30s) means the card is hot; retrying into it
        // just extends it (observed live) — fail fast so the card is deferred
        // to next tick instead of hammering.
        if (attempt === 1 && firstRetryAfterSec > 30) {
          break;
        }
        await sleep(global ? Math.max(waitMs, 30_000) : Math.min(waitMs, 30_000));
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

/** Collapse prose to one line, truncating at `max` chars. */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
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
  const reason =
    node.route.route === "escalate-hitl"
      ? ESCALATE_REASONS[node.route.reason]
      : "auto node with registry-blocked probes — provisioning needed";
  const probeLines =
    node.route.route === "provisioning" && node.blockedProbes !== undefined
      ? [
          "register these in the probe registry (run + cwd must match exactly):",
          ...node.blockedProbes.map((p) =>
            p.type === "command"
              ? `  · command: run \`${p.run}\` · cwd \`${p.cwd}\``
              : `  · url host: \`${p.host}\` (target \`${p.target}\`)`,
          ),
        ]
      : [];
  const bodyLine =
    node.route.route === "escalate-hitl" &&
    node.body !== undefined &&
    node.body.trim().length > 0
      ? `_${truncate(node.body, 140)}_`
      : null;
  const lines = [
    `${cardHead(node)} — **#${node.id}** ${node.title}`,
    `map: ${map.repo} · ${node.kind} · ${node.autonomy}`,
    `url: ${node.url}`,
    node.checkpointId !== undefined && node.checkpointId.length > 0
      ? `checkpoint: \`${node.checkpointId}\``
      : null,
    reason ? `_${reason}_` : null,
    bodyLine,
    ...probeLines,
    ageSuffix(ageDays, principal, principalDiscordId),
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
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
  ok: boolean;
  error?: string;
  /** Node ids whose card was posted fresh (announce-once). */
  posted: string[];
  /** Node ids whose card was edited in place (edit-not-repost). */
  edited: string[];
  /** Node ids whose card was marked resolved (no longer on the HITL queue). */
  resolved: string[];
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
async function withEscalateLock<T>(
  journal: Journal,
  fn: () => Promise<T>,
): Promise<T> {
  const lockFile = join(dirname(journal.path), ".escalate.lock");
  const started = Date.now();
  const timeoutMs = 60_000;
  const owner = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  for (;;) {
    try {
      // Atomic create-with-content (wx): the lock never exists without an
      // owner, so there is no window where a paused run looks ownerless.
      writeFileSync(lockFile, owner, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Someone holds the lock. Reclaim it ONLY when the owner's pid is dead
      // (kill(pid,0) → ESRCH). We never reclaim a lock whose owner is alive,
      // whatever its age — stealing a live run's lock would let two runs both
      // POST fresh cards and break announce-once. A rebooted host whose old
      // pid got recycled (alive but unrelated) is left to the 60s timeout → a
      // visible refusal, never silent duplicates; the operator clears it.
      let reclaimable = false;
      try {
        const prior = JSON.parse(readFileSync(lockFile, "utf8")) as {
          pid?: number;
        };
        if (typeof prior.pid === "number") {
          try {
            process.kill(prior.pid, 0);
          } catch (killError) {
            reclaimable = (killError as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        /* unreadable owner — never reclaim on a guess */
        reclaimable = false;
      }
      if (reclaimable) {
        // Atomically replace the dead lock via rename (rename replaces the
        // target in one step) — never delete-then-recreate, which lets two
        // reclaims delete each other's freshly-acquired lock and both POST.
        const tmp = join(
          dirname(lockFile),
          `.escalate.lock.${process.pid}.tmp`,
        );
        writeFileSync(tmp, owner);
        try {
          renameSync(tmp, lockFile);
        } catch {
          try {
            rmSync(tmp, { force: true });
          } catch {
            /* best-effort */
          }
          continue; // concurrent rename — keep waiting
        }
        // Verify we actually hold it: a racing reclaim may have renamed over
        // ours in the same instant — the loser waits instead of proceeding, so
        // exactly one reclaiming process takes the lock (no duplicate cards).
        let mine = false;
        try {
          const after = JSON.parse(readFileSync(lockFile, "utf8")) as {
            pid?: number;
          };
          mine = after.pid === process.pid;
        } catch {
          mine = false;
        }
        if (mine) break; // we hold the lock
        continue;
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
  try {
    return await fn();
  } finally {
    try {
      rmSync(lockFile, { force: true });
    } catch {
      /* best-effort release */
    }
  }
}

/**
 * Resolution phase: edit cards whose node left the HITL/provisioning queue to
 * a resolved note (design §5 — cards persist; only resolution ends them).
 * Returns the resolved node ids. Bounded-pool like the active pass so a
 * many-card map doesn't edit serially.
 */
async function resolveStaleCards(
  ctx: {
    client: EscalationDiscord;
    journal: Journal;
    map: RangerMapConfig;
    now: Date;
  },
  existing: Map<string, EscalationRow>,
  neededIds: Set<string>,
): Promise<{ resolved: string[]; errors: string[] }> {
  const { client, journal, map, now } = ctx;
  const resolvable = [...existing.entries()].filter(
    ([, prior]) => prior.status !== "resolved",
  );
  const outcomes = await mapPool(resolvable, 3, async ([nodeId, prior]) => {
    if (neededIds.has(nodeId)) return { action: "skip" as const };
    try {
      const content = [
        `~~**#${nodeId}** ${prior.title ?? ""}~~ ✅ resolved`,
        `map: ${map.repo} — no longer on the HITL/provisioning queue`,
        `_edited ${now.toISOString()}_`,
      ]
        .filter((l) => l.trim().length > 0)
        .join("\n");
      await client.edit(prior.messageId, content);
      journal.upsertEscalation({
        key: `${map.repo}:${nodeId}`,
        repo: map.repo,
        nodeId,
        title: prior.title,
        lastContent: content,
        messageId: prior.messageId,
        createdAt: prior.createdAt,
        lastEditedAt: now.toISOString(),
        status: "resolved",
      });
      return { action: "resolved" as const, id: nodeId };
    } catch (cardError) {
      // A transient failure on one resolution must not fail the desk — the
      // card stays open and resolves on a later tick.
      return {
        action: "error" as const,
        id: nodeId,
        error: cardError instanceof Error ? cardError.message : String(cardError),
      };
    }
  });
  const resolved: string[] = [];
  const errors: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.action === "error") {
      errors.push(`#${outcome.id}: ${outcome.error}`);
    } else if (outcome.action === "resolved") {
      resolved.push(outcome.id);
    }
  }
  return { resolved, errors };
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

async function escalateOneMap(
  config: RangerConfig,
  map: RangerMapConfig,
  journal: Journal,
  registry: ReturnType<typeof loadProbeRegistry>,
  now: Date,
): Promise<EscalateMapResult> {
  const base: EscalateMapResult = {
    repo: map.repo,
    ok: true,
    posted: [],
    edited: [],
    resolved: [],
    cardErrors: [],
    cards: [],
  };

  let token: ResolvedToken;
  try {
    ({ token } = await assertReadOnlyToken(config, map.repo));
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof GateError ? error.message : String(error),
    };
  }

  let client: EscalationDiscord;
  try {
    client = EscalationDiscord.fromMap(map, config.principal.discordId);
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

    const existing = new Map(
      journal
        .listEscalations(map.repo)
        .map((row) => [row.nodeId, row] as const),
    );

    const principal = config.principal.login;
    const cards: EscalationCard[] = [];
    const outcomes = await mapPool(needed, 3, async (node) => {
      const prior = existing.get(node.id);
      const ageDays = prior === undefined ? 0 : dayDiff(prior.createdAt, now);
      const content = cardContent(
        node,
        map,
        ageDays,
        principal,
        config.principal.discordId,
      );
      try {
        if (prior === undefined) {
          const messageId = await client.post(content);
          const row = {
            key: `${map.repo}:${node.id}`,
            repo: map.repo,
            nodeId: node.id,
            title: node.title,
            route: node.route.route,
            lastContent: content,
            messageId,
            createdAt: now.toISOString(),
            status: "open" as const,
          };
          journal.upsertEscalation(row);
          return {
            action: "posted" as const,
            id: node.id,
            card: cardFrom(node, row, ageDays),
          };
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
        await client.edit(prior.messageId, content);
        const row = {
          key: `${map.repo}:${node.id}`,
          repo: map.repo,
          nodeId: node.id,
          title: node.title,
          route: node.route.route,
          lastContent: content,
          messageId: prior.messageId,
          createdAt: prior.createdAt,
          lastEditedAt: now.toISOString(),
          status: "open" as const,
        };
        journal.upsertEscalation(row);
        return {
          action: "edited" as const,
          id: node.id,
          card: cardFrom(node, row, ageDays),
        };
      } catch (cardError) {
        // A transient Discord failure on one card must not fail the whole
        // desk — the card retries next tick (announce-once stays intact: a
        // failed post writes no row, a failed edit keeps its row).
        return {
          action: "error" as const,
          id: node.id,
          error: cardError instanceof Error ? cardError.message : String(cardError),
        };
      }
    });
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
    const resolution = await resolveStaleCards(
      { client, journal, map, now },
      existing,
      neededIds,
    );
    base.resolved.push(...resolution.resolved);
    base.cardErrors.push(...resolution.errors);

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
  const lines: string[] = [
    `:newspaper: **ranger digest** — ${map.repo} (root ${map.root}, walk: ${map.walk}) · ${now.toISOString().slice(0, 10)}`,
    "",
    `**Cards: ${cards.length}**${aged.length > 0 ? ` (${aged.length} aged 3+d, ${overdue.length} 7+d${principalDiscordId ? " @-mentioned" : " no ping"})` : ""}`,
  ];
  if (cards.length === 0) {
    lines.push("  none open — clean");
  } else {
    for (const card of cards) {
      const band = ageBand(card.ageDays);
      lines.push(
        `  #${card.nodeId} ${card.title} — ${card.route} · ${ageText(
          band,
          card.ageDays,
          principal,
          principalDiscordId,
        )}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `**Audit:** receipt-less closes ${audit.closedWithoutReceipt.length}${audit.closedWithoutReceipt.length > 0 ? ` (${audit.closedWithoutReceipt.join(", ")})` : ""} · open w/o checkpoint ${audit.openWithoutCheckpoint.length}${audit.openWithoutCheckpoint.length > 0 ? ` (${audit.openWithoutCheckpoint.join(", ")})` : ""} · open claims ${audit.openClaimed.length}`,
  );
  if (audit.openClaimed.length > 0) {
    for (const c of audit.openClaimed) {
      lines.push(`    #${c.id} [${c.assignees.join(", ")}]`);
    }
  }
  lines.push(
    `**Budget:** spawns today ${budget.spawnsToday}/${budget.spawnCapPerDay} · dead-man ${budget.deadman} · ${budget.paused ? "PAUSED" : "running"}`,
  );
  return lines.join("\n");
}

async function digestOneMap(
  config: RangerConfig,
  map: RangerMapConfig,
  journal: Journal,
  now: Date,
): Promise<DigestMapResult> {
  const base: DigestMapResult = {
    repo: map.repo,
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
  try {
    ({ token } = await assertReadOnlyToken(config, map.repo));
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof GateError ? error.message : String(error),
    };
  }
  let client: EscalationDiscord;
  try {
    client = EscalationDiscord.fromMap(map, config.principal.discordId);
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

    // Digest is edit-not-repost within a day: cache the message id under
    // `digest.<repo>`; a new day posts a fresh digest.
    const today = now.toISOString().slice(0, 10);
    const cached = journal.getHealth(`digest.${map.repo}`);
    let messageId = "";
    let posted = false;
    if (cached !== null && cached.startsWith(`${today}:`)) {
      messageId = cached.slice(today.length + 1);
      await client.edit(messageId, content);
    } else {
      messageId = await client.post(content);
      journal.setHealth(`digest.${map.repo}`, `${today}:${messageId}`);
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

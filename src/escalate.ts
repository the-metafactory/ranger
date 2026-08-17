import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
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
import type { Journal } from "./journal.ts";

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
  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly apiBase: string = escalationApiBase(),
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
    try {
      return await fetch(`${this.apiBase}${path}`, {
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
            users: this.principalDiscordId
              ? [this.principalDiscordId]
              : [],
          },
        }),
      });
    } catch (error) {
      throw new EscalateError(
        `discord ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      throw new EscalateError(
        `discord post returned HTTP ${response.status}`,
      );
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
 * The Discord API base for production, with a hardened test seam.
 * `RANGER_DISCORD_API_BASE` may only target discord.com over https, or a
 * loopback listener when the test seam is explicitly opted in
 * (`RANGER_DISCORD_ALLOW_TEST_OVERRIDE=1`) — an injected override can
 * otherwise redirect the bot token to an attacker host (security review).
 * Absent/empty → the fixed Discord origin.
 */
function escalationApiBase(): string {
  const override = process.env.RANGER_DISCORD_API_BASE;
  if (override === undefined || override.length === 0) {
    return "https://discord.com/api/v10";
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new EscalateError(
      "RANGER_DISCORD_API_BASE is not a valid URL; refusing to use it",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host === "discord.com") {
    if (url.protocol !== "https:") {
      throw new EscalateError(
        "RANGER_DISCORD_API_BASE discord.com override must be https",
      );
    }
    return override;
  }
  // Loopback is only a test seam, and only when explicitly opted in — an
  // injected override otherwise redirects the bot token to a local listener.
  if (
    (host === "localhost" || host === "127.0.0.1") &&
    process.env.RANGER_DISCORD_ALLOW_TEST_OVERRIDE === "1"
  ) {
    return override;
  }
  throw new EscalateError(
    `RANGER_DISCORD_API_BASE host ${host} is not allowed — ` +
      "discord.com (https) or an explicit localhost test override only",
  );
}

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

function ageSuffix(ageDays: number, principal: string): string {
  if (ageBand(ageDays) === "overdue") {
    return `📣 @${principal} **${ageDays}d** — needs your attention`;
  }
  if (ageBand(ageDays) === "aging") {
    return `⚠️ **${ageDays}d** — aging; blocked-descendant count unavailable ` +
      "(read-only surface can't enumerate blocked nodes)";
  }
  return `· ${ageDays}d`;
}

function cardContent(
  node: ClassifiedNode,
  map: { repo: string },
  ageDays: number,
  principal: string,
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
    ageSuffix(ageDays, principal),
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
  await Promise.all(workers);
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
  const lockDir = join(dirname(journal.path), ".escalate.lock");
  const started = Date.now();
  const timeoutMs = 60_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started > timeoutMs) {
        throw new EscalateError(
          `another escalate run holds the lock (${lockDir}) — ` +
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
      rmSync(lockDir, { recursive: true });
    } catch {
      /* best-effort release */
    }
  }
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
    const needed = [...hitlWaiting(classified), ...classified.filter((n) => n.route.route === "provisioning")].filter(cardNeeded);

    const existing = new Map(
      journal
        .listEscalations(map.repo)
        .map((row) => [row.nodeId, row] as const),
    );

    const principal = config.principal.login;
    const cards: EscalationCard[] = [];
    const outcomes = await mapPool(needed, 3, async (node) => {
      const prior = existing.get(node.id);
      const ageDays =
        prior === undefined ? 0 : dayDiff(prior.createdAt, now);
      const content = cardContent(node, map, ageDays, principal);
      if (prior === undefined) {
        const messageId = await client.post(content);
        const row = {
          key: `${map.repo}:${node.id}`,
          repo: map.repo,
          nodeId: node.id,
          title: node.title,
          route: node.route.route,
          messageId,
          createdAt: now.toISOString(),
          status: "open" as const,
        };
        journal.upsertEscalation(row);
        return { action: "posted" as const, id: node.id, card: cardFrom(node, row, ageDays) };
      }
      await client.edit(prior.messageId, content);
      const row = {
        key: `${map.repo}:${node.id}`,
        repo: map.repo,
        nodeId: node.id,
        title: node.title,
        route: node.route.route,
        messageId: prior.messageId,
        createdAt: prior.createdAt,
        lastEditedAt: now.toISOString(),
        status: "open" as const,
      };
      journal.upsertEscalation(row);
      return { action: "edited" as const, id: node.id, card: cardFrom(node, row, ageDays) };
    });
    for (const outcome of outcomes) {
      if (outcome.action === "posted") base.posted.push(outcome.id);
      else base.edited.push(outcome.id);
      cards.push(outcome.card);
    }

    // Resolve cards whose node is no longer on the HITL/provisioning queue —
    // the card is edited to a resolved note, never silently dropped (design
    // §5: cards persist; only resolution ends them). Bounded-pool like the
    // active pass so a many-card map doesn't edit serially.
    const neededIds = new Set(needed.map((n) => n.id));
    const resolvable = [...existing.entries()].filter(
      ([, prior]) => prior.status !== "resolved",
    );
    const resolved = await mapPool(resolvable, 3, async ([nodeId, prior]) => {
      if (neededIds.has(nodeId)) return null;
      await client.edit(
        prior.messageId,
        [
          `~~**#${nodeId}** ${prior.title ?? ""}~~ ✅ resolved`,
          `map: ${map.repo} — no longer on the HITL/provisioning queue`,
          `_edited ${now.toISOString()}_`,
        ]
          .filter((l) => l.trim().length > 0)
          .join("\n"),
      );
      journal.upsertEscalation({
        key: `${map.repo}:${nodeId}`,
        repo: map.repo,
        nodeId,
        title: prior.title,
        messageId: prior.messageId,
        createdAt: prior.createdAt,
        lastEditedAt: now.toISOString(),
        status: "resolved",
      });
      return nodeId;
    });
    for (const nodeId of resolved) {
      if (nodeId !== null) base.resolved.push(nodeId);
    }

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
  budget: { spawnsToday: number; spawnCapPerDay: number; deadman: number; paused: boolean };
  digestMessageId: string;
  posted: boolean;
}

export interface DigestResult {
  generatedAt: string;
  maps: DigestMapResult[];
}

function digestContent(
  map: RangerMapConfig,
  cards: DigestCard[],
  audit: AuditResult,
  budget: DigestMapResult["budget"],
  principal: string,
  now: Date,
): string {
  const aged = cards.filter((c) => ageBand(c.ageDays) !== "fresh"); // 3+
  const overdue = cards.filter((c) => ageBand(c.ageDays) === "overdue"); // 7+
  const lines: string[] = [
    `:newspaper: **ranger digest** — ${map.repo} (root ${map.root}, walk: ${map.walk}) · ${now.toISOString().slice(0, 10)}`,
    "",
    `**Cards: ${cards.length}**${aged.length > 0 ? ` (${aged.length} aged 3+d, ${overdue.length} @-mentioned)` : ""}`,
  ];
  if (cards.length === 0) {
    lines.push("  none open — clean");
  } else {
    for (const card of cards) {
      const band = ageBand(card.ageDays);
      const age =
        band === "overdue"
          ? `📣 @${principal} ${card.ageDays}d`
          : band === "aging"
            ? `⚠️ ${card.ageDays}d`
            : `${card.ageDays}d`;
      lines.push(`  #${card.nodeId} ${card.title} — ${card.route} · ${age}`);
    }
  }
  lines.push("");
  lines.push(`**Audit:** receipt-less closes ${audit.closedWithoutReceipt.length}${audit.closedWithoutReceipt.length > 0 ? ` (${audit.closedWithoutReceipt.join(", ")})` : ""} · open w/o checkpoint ${audit.openWithoutCheckpoint.length}${audit.openWithoutCheckpoint.length > 0 ? ` (${audit.openWithoutCheckpoint.join(", ")})` : ""} · open claims ${audit.openClaimed.length}`);
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
    const open = journal
      .listOpenEscalations(map.repo)
      .map((row) => ({
        nodeId: row.nodeId,
        title: row.title ?? `#${row.nodeId}`,
        route: row.route ?? "escalate-hitl",
        ageDays: dayDiff(row.createdAt, now),
        messageId: row.messageId,
      }));

    const content = digestContent(
      map,
      open,
      audit,
      base.budget,
      config.principal.login,
      now,
    );

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

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
    private readonly apiBase: string =
      process.env.RANGER_DISCORD_API_BASE ?? "https://discord.com/api/v10",
  ) {}

  static fromMap(
    map: RangerMapConfig,
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
    return new EscalationDiscord(token, map.discord.channelId);
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
        body: JSON.stringify({ content }),
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
function ageSuffix(ageDays: number, principal: string): string {
  if (ageDays >= 7) {
    return `📣 @${principal} **${ageDays}d** — needs your attention`;
  }
  if (ageDays >= 3) {
    return `⚠️ **${ageDays}d** — aging, blocked-descendant count on the digest`;
  }
  return `· ${ageDays}d`;
}

export function cardContent(
  node: ClassifiedNode,
  map: { repo: string },
  ageDays: number,
  principal: string,
): string {
  const reason =
    node.route.route === "escalate-hitl"
      ? ESCALATE_REASONS[node.route.reason]
      : "auto node with registry-blocked probes — provisioning needed";
  const lines = [
    `${cardHead(node)} — **#${node.id}** ${node.title}`,
    `map: ${map.repo} · ${node.kind} · ${node.autonomy}`,
    `url: ${node.url}`,
    node.checkpointId !== undefined && node.checkpointId.length > 0
      ? `checkpoint: \`${node.checkpointId}\``
      : null,
    reason ? `_${reason}_` : null,
    ageSuffix(ageDays, principal),
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
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
  status: "open" | "resolved";
  createdAt: string;
  messageId: string;
}

export interface EscalateMapResult {
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

export interface EscalateOptions {
  configPath: string;
  now?: Date;
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
    client = EscalationDiscord.fromMap(map);
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

    for (const node of needed) {
      const prior = existing.get(node.id);
      const ageDays =
        prior === undefined ? 0 : dayDiff(prior.createdAt, now);
      const content = cardContent(node, map, ageDays, principal);
      if (prior === undefined) {
        const messageId = await client.post(content);
        journal.upsertEscalation({
          key: `${map.repo}:${node.id}`,
          repo: map.repo,
          nodeId: node.id,
          title: node.title,
          messageId,
          createdAt: now.toISOString(),
          status: "open",
        });
        base.posted.push(node.id);
        cards.push({
          nodeId: node.id,
          title: node.title,
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
          createdAt: now.toISOString(),
          messageId,
        });
      } else {
        await client.edit(prior.messageId, content);
        journal.upsertEscalation({
          key: `${map.repo}:${node.id}`,
          repo: map.repo,
          nodeId: node.id,
          title: node.title,
          messageId: prior.messageId,
          createdAt: prior.createdAt,
          lastEditedAt: now.toISOString(),
          status: "open",
        });
        base.edited.push(node.id);
        cards.push({
          nodeId: node.id,
          title: node.title,
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
          createdAt: prior.createdAt,
          messageId: prior.messageId,
        });
      }
    }

    // Resolve cards whose node is no longer on the HITL/provisioning queue —
    // the card is edited to a resolved note, never silently dropped (design
    // §5: cards persist; only resolution ends them).
    for (const [nodeId, prior] of existing) {
      if (prior.status === "resolved") continue;
      if (needed.some((n) => n.id === nodeId)) continue;
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
      base.resolved.push(nodeId);
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
  const now = opts.now ?? new Date();
  const registry = loadProbeRegistry();
  const maps: EscalateMapResult[] = [];
  for (const map of config.maps) {
    maps.push(await escalateOneMap(config, map, journal, registry, now));
  }
  return { generatedAt: now.toISOString(), maps };
}

// ---- the daily digest ----

export interface DigestCard {
  nodeId: string;
  title: string;
  route: string;
  ageDays: number;
  messageId: string;
}

export interface DigestMapResult {
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
  const aged = cards.filter((c) => c.ageDays >= 3);
  const overdue = cards.filter((c) => c.ageDays >= 7);
  const lines: string[] = [
    `:newspaper: **ranger digest** — ${map.repo} (root ${map.root}, walk: ${map.walk}) · ${now.toISOString().slice(0, 10)}`,
    "",
    `**Cards: ${cards.length}**${aged.length > 0 ? ` (${aged.length} aged 3+d, ${overdue.length} @-mentioned)` : ""}`,
  ];
  if (cards.length === 0) {
    lines.push("  none open — clean");
  } else {
    for (const card of cards) {
      const age =
        card.ageDays >= 7
          ? `📣 @${principal} ${card.ageDays}d`
          : card.ageDays >= 3
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
    client = EscalationDiscord.fromMap(map);
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const audit = await graphAudit(map.repo, map.root, token);
    const open = journal
      .listEscalations(map.repo)
      .filter((row) => row.status === "open")
      .map((row) => ({
        nodeId: row.nodeId,
        title: row.title ?? `#${row.nodeId}`,
        route: row.nodeId,
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
  const now = opts.now ?? new Date();
  const maps: DigestMapResult[] = [];
  for (const map of config.maps) {
    maps.push(await digestOneMap(config, map, journal, now));
  }
  return { generatedAt: now.toISOString(), maps };
}

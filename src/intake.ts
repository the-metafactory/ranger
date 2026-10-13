import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { discardedCardContent, draftCardContent, filedCardContent, type IntakeCardDraft } from "./card-sync.ts";
import { oneLine } from "./card-render.ts";
import {
  DiscordMessageGoneError,
  EscalateError,
  EscalationDiscord,
  snowflakeAt,
  THREAD_PAGE_SIZE,
  type ThreadMessage,
} from "./discord.ts";
import type { ForgeReadPort, LabeledIssue } from "./forge.ts";
import { lanePort } from "./forge-lanes.ts";
import { GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";
import { GraphAddUnattached, graphAdd, graphLink } from "./graph-write.ts";
import { assertNotPrincipal, assertWriteIdentity } from "./identity.ts";
import type { IntakeDraftRow, Journal } from "./journal.ts";
import { type OwnedCheck, withOwnedLease } from "./lock.ts";
import { mapKey } from "./maps.ts";

/**
 * Human-observation intake, slice 1 (node #247; #21 rulings D3, D11, D12, D17).
 *
 * Each walk tick reads every intake thread over REST (no gateway): the
 * Discord thread of each registered map that is not `walk: none`. A message
 * counts only when the principal (`principal.discordId`) wrote it and it
 * @-mentions the ranger bot; Discord returns the content of such a message
 * without the privileged Message Content intent. Each one gets a draft node
 * card in its thread, written by the deterministic drafter.
 *
 * Per thread the journal holds a cursor (the newest message id read) and one
 * draft per message id. The cursor moves past each message once it is
 * handled; a message read twice (a crash before the cursor write) finds its
 * draft and posts no second card. A failed read moves nothing.
 *
 * Slice 2, the gate (node #251; rulings D4, D5, D13, D14, with D1): each
 * tick reads the reactions on the thread's open draft cards. The principal's
 * ❌ discards a draft. The principal's 👍 files it, once: the journaled spec
 * must still hash to the hash the card showed, the write identity must pass
 * `assertWriteIdentity`, and the map must hold no node carrying the draft's
 * intake marker. Then `soma graph add` below the map root, as the machine
 * account, labelled `ranger:principal-intake`, with a link to the message
 * and the marker in the body. The node and its marker are the binding
 * record; the journal is a cache (D1).
 */

/** The drafter of this slice (D12's fallback); the LLM drafter is node #252's. */
export const DETERMINISTIC_DRAFTER = "deterministic";

/** Thread pages read per tick: the rest wait for the next tick. */
const MAX_PAGES_PER_THREAD = 5;

/** The whole pass's wall-clock bound, so intake never holds the tick. */
const INTAKE_PASS_MS = 60_000;

/** How long a second intake run waits for the first before it skips. */
const INTAKE_LOCK_TIMEOUT_MS = 30_000;

/** Draft cards whose reactions one thread's gate reads per tick; the rest wait. */
const GATE_READS_PER_THREAD = 10;

/** The provenance label of a node the principal's 👍 filed (ruling D5). */
export const PRINCIPAL_INTAKE_LABEL = "ranger:principal-intake";

/** The 👍 files a draft; the ❌ discards it (ruling D14). Discord's unicode names. */
export const FILE_EMOJI = "👍";
export const DISCARD_EMOJI = "❌";

/** The intake marker a filed node's body carries (ruling D14): it blocks a second add. */
export function intakeMarker(messageId: string): string {
  return `<!-- ranger:intake discord=${messageId} -->`;
}

const TITLE_MAX = 120;
const CHECKPOINT_MAX = 48;
const FALLBACK_TITLE = "Observation from the principal";
const FALLBACK_CHECKPOINT = "observation";

export interface IntakeThreadResult {
  channelId: string;
  /** The maps this thread serves (`repo#root`). */
  maps: string[];
  /** Messages read this tick. */
  read: number;
  /** Message ids that got a draft card this tick. */
  drafted: string[];
  /** Message ids read again whose draft the journal already held. */
  alreadyDrafted: string[];
  /** The cursor after this tick; null when the thread was not read. */
  cursor: string | null;
  /** First tick on this thread: the cursor was set to now and nothing read. */
  seeded?: boolean;
  /** Why this thread was not read, when that is configuration, not a failure. */
  skipped?: string;
  error?: string;
  /** The gate over the thread's open drafts (node #251); absent when none was read. */
  gate?: IntakeGateResult;
}

/** What the gate did with one thread's open drafts this tick (node #251). */
export interface IntakeGateResult {
  /** Draft message ids whose card reactions were read. */
  read: string[];
  /** Drafts filed this tick; `added: false` when the marker found the node already there. */
  filed: { messageId: string; node: string; added: boolean }[];
  /** Drafts the principal's ❌ discarded. */
  discarded: string[];
  /** A principal 👍 that filed nothing, and why: the card stays a draft. */
  refused: { messageId: string; reason: string }[];
  /** Over the per-tick cap or past the deadline: read on a later tick. */
  deferred: string[];
  errors: string[];
}

export interface IntakeResult {
  threads: IntakeThreadResult[];
  /** Why the pass read no thread at all. */
  skipped?: string;
  error?: string;
}

/** The deterministic draft spec (D12): every field derived from the message. */
export interface DraftSpec {
  title: string;
  parent: number;
  checkpoint: string;
  autonomy: "propose";
  drafter: string;
}

/** Drop the bot's own mention tokens (`<@id>`, `<@!id>`). */
function withoutBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").replaceAll(`<@!${botUserId}>`, "");
}

/** Does the message text @-mention this user? */
export function mentionsUser(content: string, userId: string): boolean {
  return content.includes(`<@${userId}>`) || content.includes(`<@!${userId}>`);
}

/** A title slugged to a checkpoint id: lowercase ascii words joined by `-`. */
export function slugCheckpoint(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= CHECKPOINT_MAX) return slug === "" ? FALLBACK_CHECKPOINT : slug;
  // Cut at a word boundary so the id never ends mid-word.
  const cut = slug.slice(0, CHECKPOINT_MAX + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, CHECKPOINT_MAX)).replace(/-+$/, "");
}

/**
 * The deterministic drafter: the title is the message's first line with text
 * (the bot's mention dropped), the parent is the map root, the checkpoint is
 * slugged from the title, and autonomy is `propose`.
 */
export function deterministicDraft(content: string, botUserId: string, root: number): DraftSpec {
  const first = content
    .split(/\r?\n/)
    .map((line) => oneLine(withoutBotMention(line, botUserId)))
    .find((line) => line.length > 0);
  const title = first === undefined ? FALLBACK_TITLE : oneLine(first, TITLE_MAX);
  return {
    title,
    parent: root,
    checkpoint: slugCheckpoint(title),
    autonomy: "propose",
    drafter: DETERMINISTIC_DRAFTER,
  };
}

/** A Discord link to one message. */
export function messageUrl(guildId: string | null, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

/** The maps intake reads, grouped by thread: a Discord thread and not `walk: none` (D17). */
export function intakeThreads(maps: readonly RangerMapConfig[]): Map<string, RangerMapConfig[]> {
  const threads = new Map<string, RangerMapConfig[]>();
  for (const map of maps) {
    if (map.discord === undefined || map.walk === "none") continue;
    const serving = threads.get(map.discord.channelId) ?? [];
    serving.push(map);
    threads.set(map.discord.channelId, serving);
  }
  return threads;
}

export interface IntakeContext {
  config: RangerConfig;
  journal: Journal;
  /** Where each map's bot token is read (default: the process env). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The thread client for a map (tests inject one; default: the map's Discord surface). */
  clientFor?: (map: RangerMapConfig) => EscalationDiscord;
  /** The forge port the gate's marker lookup reads (default: the map's lane port). */
  portFor?: (repo: string) => Pick<ForgeReadPort, "issuesWithLabel">;
}

/** The intake pass of one walk tick. Never throws: failures land in the result. */
export async function intakePass(ctx: IntakeContext): Promise<IntakeResult> {
  const principalId = ctx.config.principal.discordId;
  if (principalId === undefined || principalId.length === 0) {
    return { threads: [], skipped: "principal.discordId is unset — no message can qualify" };
  }
  const threads = intakeThreads(ctx.config.maps);
  if (threads.size === 0) return { threads: [] };
  try {
    return await withOwnedLease(
      join(dirname(ctx.journal.path), ".intake.lock"),
      {
        timeoutMs: INTAKE_LOCK_TIMEOUT_MS,
        contended: () => new EscalateError("another intake run holds the lock — skipped this tick"),
        lost: (why) => new EscalateError(`intake lease lost: ${why}`),
      },
      (owned) => readThreads(ctx, principalId, threads, owned),
    );
  } catch (error) {
    return { threads: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function readThreads(
  ctx: IntakeContext,
  principalId: string,
  threads: Map<string, RangerMapConfig[]>,
  owned: OwnedCheck,
): Promise<IntakeResult> {
  const deadline = Date.now() + INTAKE_PASS_MS;
  const clientFor =
    ctx.clientFor ?? ((map: RangerMapConfig) => EscalationDiscord.fromMap(map, undefined, ctx.env ?? process.env));
  // The bot's own id, read once per tick per token (D11).
  const botIds = new Map<string, Promise<string>>();
  const results: IntakeThreadResult[] = [];
  for (const [channelId, maps] of threads) {
    const result: IntakeThreadResult = {
      channelId,
      maps: maps.map(mapKey),
      read: 0,
      drafted: [],
      alreadyDrafted: [],
      cursor: null,
    };
    results.push(result);
    if (maps.length > 1) {
      // A draft's parent is its map's root, and the rulings (D17) assume one
      // thread per map: a shared thread names no one map. Which map a shared
      // thread's observation belongs to is the principal's call, not ranger's.
      result.skipped = `thread serves ${maps.length} maps (${result.maps.join(", ")}) — intake needs one map per thread; not read`;
      continue;
    }
    const map = maps[0]!;
    try {
      const client = clientFor(map);
      const tokenEnv = map.discord!.tokenEnv;
      if (!botIds.has(tokenEnv)) botIds.set(tokenEnv, client.currentUserId(deadline));
      const botUserId = await botIds.get(tokenEnv)!;
      await readThread({ ...ctx, map, client, botUserId, principalId, deadline, owned, result });
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.cursor = ctx.journal.intakeCursor(channelId);
    // The gate reads its own cards: a failed thread read does not stop it.
    // A card posted this tick has no reaction yet; it is read next tick.
    const open = ctx.journal
      .listOpenIntakeDrafts(channelId)
      .filter((row) => row.repo === map.repo && row.root === map.root && !result.drafted.includes(row.messageId));
    if (open.length > 0) {
      const gate: IntakeGateResult = { read: [], filed: [], discarded: [], refused: [], deferred: [], errors: [] };
      result.gate = gate;
      try {
        await gateDrafts({ ...ctx, map, client: clientFor(map), principalId, deadline, owned, rows: open, gate });
      } catch (error) {
        gate.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { threads: results };
}

/**
 * Read one thread after its cursor, oldest first, and draft each qualifying
 * message. Throws on the first failure; the cursor stays before that message.
 */
async function readThread(args: IntakeContext & {
  map: RangerMapConfig;
  client: EscalationDiscord;
  botUserId: string;
  principalId: string;
  deadline: number;
  owned: OwnedCheck;
  result: IntakeThreadResult;
}): Promise<void> {
  const { journal, map, client, botUserId, principalId, deadline, owned, result } = args;
  const now = () => args.now?.() ?? new Date();
  const channelId = client.channel;
  let cursor = journal.intakeCursor(channelId);
  if (cursor === null) {
    // First read of this thread: start from now. A mention posted before
    // intake was on is history, not a new observation.
    owned();
    journal.setIntakeCursor(channelId, snowflakeAt(now()), now());
    result.seeded = true;
    return;
  }
  let guildId: string | null | undefined;
  for (let page = 0; page < MAX_PAGES_PER_THREAD; page++) {
    const messages = await client.messagesAfter(cursor, THREAD_PAGE_SIZE, deadline);
    for (const message of messages) {
      result.read++;
      if (message.authorId === principalId && qualifies(message, botUserId)) {
        if (journal.getIntakeDraft(message.id) !== null) {
          result.alreadyDrafted.push(message.id);
        } else {
          if (guildId === undefined) guildId = await client.guildId(deadline);
          await postDraft({ journal, map, client, message, botUserId, guildId, deadline, owned, now: now() });
          result.drafted.push(message.id);
        }
      }
      owned();
      journal.setIntakeCursor(channelId, message.id, now());
      cursor = message.id;
    }
    if (messages.length < THREAD_PAGE_SIZE) return;
  }
}

/**
 * Does this principal message count? Only an explicit @-mention of the bot
 * does (D11). A mention whose content Discord withheld throws: without the
 * text there is nothing to draft, and the cursor must not pass it.
 */
function qualifies(message: ThreadMessage, botUserId: string): boolean {
  if (mentionsUser(message.content, botUserId)) return true;
  // A reply pings its author without an @-mention in the text: not an observation.
  if (message.content.trim() === "" && message.mentionIds.includes(botUserId) && !message.isReply) {
    throw new EscalateError(
      `message ${message.id} mentions the bot but Discord returned no content — ` +
        "the bot cannot read mention content in this thread; escalate before intake can run",
    );
  }
  return false;
}

async function postDraft(args: {
  journal: Journal;
  map: RangerMapConfig;
  client: EscalationDiscord;
  message: ThreadMessage;
  botUserId: string;
  guildId: string | null;
  deadline: number;
  owned: OwnedCheck;
  now: Date;
}): Promise<void> {
  const { journal, map, client, message, botUserId, guildId, deadline, owned, now } = args;
  const spec = deterministicDraft(message.content, botUserId, map.root);
  const url = messageUrl(guildId, client.channel, message.id);
  const specHash = intakeSpecHash(map, { ...spec, body: message.content, messageUrl: url });
  const content = draftCardContent(map, { ...spec, body: message.content, messageUrl: url, specHash });
  owned();
  const cardMessageId = await client.post(content, deadline);
  // No await between the post and its record: a crash can only leave the
  // cursor behind, and the re-read finds this draft.
  journal.recordIntakeDraft({
    messageId: message.id,
    channelId: client.channel,
    repo: map.repo,
    root: map.root,
    authorId: message.authorId,
    title: spec.title,
    checkpoint: spec.checkpoint,
    body: message.content,
    messageUrl: url,
    drafter: spec.drafter,
    cardMessageId,
    createdAt: now.toISOString(),
    specHash,
  });
  journal.recordEvent("intake-draft", {
    repo: map.repo,
    detail: `draft card ${cardMessageId} for message ${message.id} (${spec.drafter})`,
  });
}

// ---- the gate: the principal's 👍 files a draft, ❌ discards it (node #251) ----

/**
 * The hash of a draft's spec (ruling D13): every field the card shows and
 * the add writes. The card carries it; the 👍 binds to it. A journaled spec
 * that no longer hashes to it was not the spec the principal saw.
 */
export function intakeSpecHash(
  map: { repo: string; root: number },
  draft: { title: string; parent: number; checkpoint: string; autonomy: string; drafter: string; body: string; messageUrl: string },
): string {
  const fields = [
    "ranger-intake-spec/1",
    map.repo,
    map.root,
    draft.parent,
    draft.title,
    draft.checkpoint,
    draft.autonomy,
    draft.drafter,
    draft.body,
    draft.messageUrl,
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** A journaled draft as the card showed it: parent the map root, autonomy `propose` (D12). */
function cardDraft(row: IntakeDraftRow): IntakeCardDraft {
  return {
    title: row.title,
    parent: row.root,
    checkpoint: row.checkpoint,
    autonomy: "propose",
    drafter: row.drafter,
    body: row.body,
    messageUrl: row.messageUrl,
    specHash: row.specHash,
  };
}

/** The body of the filed node: the principal's words verbatim, the link back, the marker (D5, D14). */
export function intakeNodeBody(row: Pick<IntakeDraftRow, "body" | "messageUrl" | "messageId">): string {
  return [
    row.body.trim(),
    "",
    "---",
    `Filed by ranger on the principal's 👍, from their Discord message: ${row.messageUrl}`,
    "",
    intakeMarker(row.messageId),
  ].join("\n");
}

/** The node already carrying this draft's marker, or null; two such nodes are refused, not guessed between. */
export function markedNode(issues: readonly LabeledIssue[], messageId: string): string | null {
  const marker = intakeMarker(messageId);
  const hits = [...new Set(issues.filter((issue) => issue.body.includes(marker)).map((issue) => issue.number))];
  if (hits.length > 1) {
    throw new EscalateError(`nodes ${hits.map((n) => `#${n}`).join(", ")} all carry ${marker} — one draft filed twice; nothing more is filed`);
  }
  return hits.length === 0 ? null : String(hits[0]);
}

/** Does the principal's reaction stand on the card? Any failed page throws. */
async function principalReacted(client: EscalationDiscord, row: IntakeDraftRow, emoji: string, principalId: string, deadline: number): Promise<boolean> {
  return (await client.reactionUserIds(row.cardMessageId, emoji, deadline)).includes(principalId);
}

type GateArgs = IntakeContext & {
  map: RangerMapConfig;
  client: EscalationDiscord;
  principalId: string;
  deadline: number;
  owned: OwnedCheck;
  gate: IntakeGateResult;
};

/**
 * Gate one thread's open drafts, the least recently read first, at most
 * `GATE_READS_PER_THREAD` per tick. One draft's failure is its own: the
 * next draft is still read.
 */
async function gateDrafts(args: GateArgs & { rows: IntakeDraftRow[] }): Promise<void> {
  const { rows, gate, deadline } = args;
  for (const [i, row] of rows.entries()) {
    if (i >= GATE_READS_PER_THREAD || Date.now() > deadline) {
      gate.deferred.push(row.messageId);
      continue;
    }
    try {
      await gateDraft(args, row);
    } catch (error) {
      gate.errors.push(`draft ${row.messageId}: ${error instanceof Error ? error.message : String(error)} — nothing filed; read again next tick`);
    }
  }
}

async function gateDraft(args: GateArgs, row: IntakeDraftRow): Promise<void> {
  const { journal, map, client, principalId, deadline, owned, gate } = args;
  const now = () => args.now?.() ?? new Date();
  // A `filing` row was 👍'd and the tick died around its add: the marker,
  // not the reactions, says whether the node exists (D1).
  if (row.status === "filing") {
    const write = await writeGate(args);
    const node = markedNode(await write.issues(), row.messageId);
    if (node !== null) return finishFiled(args, row, node, false);
    // The add never landed: the draft is a draft again, and its reactions decide.
    owned();
    journal.updateIntakeDraft(row.messageId, { status: "draft" });
    row = { ...row, status: "draft" };
  }

  gate.read.push(row.messageId);
  let discard: boolean;
  let file: boolean;
  try {
    // ❌ wins: a card the principal both 👍'd and ❌'d files nothing.
    discard = await principalReacted(client, row, DISCARD_EMOJI, principalId, deadline);
    file = !discard && (await principalReacted(client, row, FILE_EMOJI, principalId, deadline));
  } catch (error) {
    // The card is gone: no reaction on it can ever file the draft.
    if (!(error instanceof DiscordMessageGoneError)) throw error;
    owned();
    journal.updateIntakeDraft(row.messageId, { status: "discarded", gateReadAt: now().toISOString() });
    journal.recordEvent("intake-discarded", { repo: map.repo, detail: `draft ${row.messageId}: card ${row.cardMessageId} is gone — nothing filed` });
    gate.discarded.push(row.messageId);
    return;
  }
  owned();
  journal.updateIntakeDraft(row.messageId, { gateReadAt: now().toISOString() });

  if (discard) {
    owned();
    await editCard(client, row, discardedCardContent(map, cardDraft(row)), deadline);
    owned();
    journal.updateIntakeDraft(row.messageId, { status: "discarded" });
    journal.recordEvent("intake-discarded", { repo: map.repo, detail: `draft ${row.messageId}: the principal's ${DISCARD_EMOJI} on card ${row.cardMessageId} — nothing filed` });
    gate.discarded.push(row.messageId);
    return;
  }
  if (!file) return;

  // The 👍 binds to the spec the card showed (D13).
  if (row.specHash === null) {
    gate.refused.push({ messageId: row.messageId, reason: "the card carries no spec hash (drafted before node #251) — nothing to bind the 👍 to; mention the bot again to redraft" });
    return;
  }
  if (intakeSpecHash(map, cardDraft(row)) !== row.specHash) {
    gate.refused.push({ messageId: row.messageId, reason: `the journaled spec no longer hashes to ${row.specHash.slice(0, 12)}, the spec the card showed — nothing filed` });
    return;
  }

  // The write runs only after the identity-pinned read succeeds (D4), and
  // only when no node carries the marker yet (D14).
  const write = await writeGate(args);
  const existing = markedNode(await write.issues(), row.messageId);
  if (existing !== null) return finishFiled(args, row, existing, false);

  // Written before the add: a tick that dies past here leaves `filing`, and
  // the next one asks the marker before anything else.
  owned();
  journal.updateIntakeDraft(row.messageId, { status: "filing" });
  let node: string;
  try {
    owned();
    node = (await graphAdd(map.repo, String(map.root), {
      title: row.title,
      autonomy: "propose",
      checkpoint: row.checkpoint,
      labels: [PRINCIPAL_INTAKE_LABEL],
      body: intakeNodeBody(row),
    }, write.token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS, env: args.env ?? process.env })).node;
  } catch (error) {
    if (!(error instanceof GraphAddUnattached)) throw error;
    // The node exists below no parent: attach it rather than add a second.
    owned();
    await graphLink(map.repo, error.node, String(map.root), write.token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS, env: args.env ?? process.env });
    node = error.node;
  }
  return finishFiled(args, row, node, true);
}

/** Resolve the write identity (D4) once per draft, and the marker lookup under it. */
async function writeGate(args: GateArgs): Promise<{ token: string; issues: () => Promise<LabeledIssue[]> }> {
  const { config, map } = args;
  const { token, botIdentity } = await assertWriteIdentity(config, map.repo, args.env ?? process.env);
  assertNotPrincipal(config, botIdentity, map.repo);
  const port = (args.portFor ?? ((repo: string) => lanePort(config, repo)))(map.repo);
  if (port.issuesWithLabel === undefined) {
    throw new EscalateError(`the forge port for ${mapKey(map)} cannot list labelled issues — the intake marker cannot be checked, so nothing is filed`);
  }
  const list = port.issuesWithLabel.bind(port);
  return { token, issues: () => list(map.repo, PRINCIPAL_INTAKE_LABEL, token) };
}

/**
 * The card says "filed as #N", then the journal records it. A tick that
 * dies between the two re-finds the node by its marker and edits again.
 */
async function finishFiled(args: GateArgs, row: IntakeDraftRow, node: string, added: boolean): Promise<void> {
  const { journal, map, client, deadline, owned, gate } = args;
  owned();
  await editCard(client, row, filedCardContent(map, cardDraft(row), node), deadline);
  owned();
  journal.updateIntakeDraft(row.messageId, { status: "filed", filedNode: node });
  journal.recordEvent("intake-filed", {
    repo: map.repo,
    nodeId: node,
    detail: `draft ${row.messageId}: ${added ? "filed" : "found already filed (intake marker)"} as #${node} on the principal's ${FILE_EMOJI}`,
  });
  gate.filed.push({ messageId: row.messageId, node, added });
}

/** Edit the card; one deleted since leaves nothing to edit, and the record still moves. */
async function editCard(client: EscalationDiscord, row: IntakeDraftRow, content: string, deadline: number): Promise<void> {
  try {
    await client.edit(row.cardMessageId, content, deadline);
  } catch (error) {
    if (!(error instanceof DiscordMessageGoneError)) throw error;
  }
}

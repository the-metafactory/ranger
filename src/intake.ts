import { dirname, join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { draftCardContent } from "./card-sync.ts";
import { oneLine } from "./card-render.ts";
import {
  EscalateError,
  EscalationDiscord,
  snowflakeAt,
  THREAD_PAGE_SIZE,
  type ThreadMessage,
} from "./discord.ts";
import type { Journal } from "./journal.ts";
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
 * card in its thread, written by the deterministic drafter. Nothing is filed:
 * filing on 👍 and discarding on ❌ are node #251's.
 *
 * Per thread the journal holds a cursor (the newest message id read) and one
 * draft per message id. The cursor moves past each message once it is
 * handled; a message read twice (a crash before the cursor write) finds its
 * draft and posts no second card. A failed read moves nothing.
 */

/** The drafter of this slice (D12's fallback); the LLM drafter is node #252's. */
export const DETERMINISTIC_DRAFTER = "deterministic";

/** Thread pages read per tick: the rest wait for the next tick. */
const MAX_PAGES_PER_THREAD = 5;

/** The whole pass's wall-clock bound, so intake never holds the tick. */
const INTAKE_PASS_MS = 60_000;

/** How long a second intake run waits for the first before it skips. */
const INTAKE_LOCK_TIMEOUT_MS = 30_000;

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
  const content = draftCardContent(map, { ...spec, body: message.content, messageUrl: url });
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
  });
  journal.recordEvent("intake-draft", {
    repo: map.repo,
    detail: `draft card ${cardMessageId} for message ${message.id} (${spec.drafter})`,
  });
}

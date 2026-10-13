import type { RangerMapConfig } from "./config.ts";
/**
 * Shared Discord API-base resolution (escalation desk + walker announcer).
 *
 * `RANGER_DISCORD_API_BASE` may only target discord.com over https, or a
 * loopback listener when the test seam is explicitly opted in
 * (`RANGER_DISCORD_ALLOW_TEST_OVERRIDE=1`). An injected override can
 * otherwise redirect a bot token to an attacker host. Absent/empty → the
 * fixed Discord origin.
 */
export function resolveDiscordApiBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.RANGER_DISCORD_API_BASE;
  if (override === undefined || override.length === 0) {
    return "https://discord.com/api/v10";
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(
      "RANGER_DISCORD_API_BASE is not a valid URL; refusing to use it",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host === "discord.com") {
    if (url.protocol !== "https:") {
      throw new Error(
        "RANGER_DISCORD_API_BASE discord.com override must be https",
      );
    }
    return override;
  }
  // Loopback is only a test seam, and only when explicitly opted in — an
  // injected override otherwise redirects the bot token to a local listener.
  if (
    (host === "localhost" || host === "127.0.0.1") &&
    env.RANGER_DISCORD_ALLOW_TEST_OVERRIDE === "1"
  ) {
    return override;
  }
  throw new Error(
    `RANGER_DISCORD_API_BASE host ${host} is not allowed — ` +
      "discord.com (https) or an explicit localhost test override only",
  );
}

// ---- Escalation desk transport (moved from escalate.ts, round-28) ----

/**
 * Rate-limit policy for one Discord 429: parse Retry-After, classify global
 * vs local, and decide the (uncapped) wait + whether to fail fast (a hot
 * card's long first cooldown — retrying into it just extends it, so the card
 * is deferred to next tick instead of hammering). Pure and small so the
 * transport loop (`request`) stays focused on issuing attempts (round-31
 * suggestion).
 */
function rateLimitWait(
  headers: Headers,
  attempt: number,
): {
  waitMs: number;
  global: boolean;
  failFast: boolean;
  firstRetryAfterSec: number;
} {
  const retryAfter = Number(headers.get("retry-after"));
  const firstRetryAfterSec = Number.isFinite(retryAfter) ? retryAfter : 0;
  const global = headers.get("x-ratelimit-global") !== null;
  const waitMs =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** (attempt - 1);
  return {
    waitMs,
    global,
    failFast: attempt === 1 && firstRetryAfterSec > 30,
    firstRetryAfterSec,
  };
}

export class EscalateError extends Error {
  override name = "EscalateError";
}

/** A PATCH targeted a message that is not in the current channel — the
 *  destination moved (or the card was deleted); the caller reposts. */
export class DiscordMessageGoneError extends EscalateError {
  override readonly name = "DiscordMessageGoneError";
}

// ---- Discord card client (POST announce / PATCH edit) ----

/** Shared global-429 pause state, held BY REFERENCE across all clients a map
 *  derives (the primary + every `forChannel` destination client), so a global
 *  429 pauses them ALL at once (round-34 review). */
interface CooldownState {
  until: number;
}

/**
 * Cap on any client-wide Discord cooldown (a global 429's Retry-After): a
 * long retry must not hold the tick — and hence the walk lane — indefinitely
 * (round-26 review). After the cap the client resumes and retries, and the
 * attempt budget defers the card rather than sleeping the whole cooldown.
 */
const MAX_COOLDOWN_MS = 30_000;

/** A Discord HTTP result with the body already buffered inside the abort
 *  scope — a server that sends headers then stalls its body is still bounded
 *  (round-38 blocker; the body read must not run unbounded past the timer). */
interface DiscordHttpResult {
  status: number;
  headers: Headers;
  bodyText: string;
}

export const DISCORD_MAX_FILES = 10;
// Ranger caps files at 10 MiB and reserves room for multipart metadata.
// https://docs.discord.com/developers/resources/message#create-message (25 MiB request cap)
export const DISCORD_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DISCORD_MAX_FILES_BYTES = 24 * 1024 * 1024;
export interface DiscordFile {
  name: string;
  data: Blob;
  description?: string;
}

export function validateDiscordFiles(files: readonly DiscordFile[]): void {
  if (files.length > DISCORD_MAX_FILES) throw new EscalateError("too many Discord attachments");
  if (files.some(f => f.data.size > DISCORD_MAX_FILE_BYTES)) throw new EscalateError("Discord attachment too large");
  if (files.reduce((sum, f) => sum + f.data.size, 0) > DISCORD_MAX_FILES_BYTES) {
    throw new EscalateError("Discord attachments exceed the request budget");
  }
}

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
   *  and extend the cooldown (observed live). SHARED BY REFERENCE across the
   *  clients `forChannel` derives, so a global 429 pauses EVERY destination-
   *  channel client too, not just the one that received it (round-34). */
  private readonly cooldown: CooldownState;

  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly apiBase: string = resolveDiscordApiBase(),
    private readonly principalDiscordId?: string,
    cooldown: CooldownState = { until: 0 },
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.cooldown = cooldown;
  }

  /** The configured Discord channel this client posts/edits in. */
  get channel(): string {
    return this.channelId;
  }

  /** A client for a DIFFERENT channel, sharing token/base/principal config
   *  AND the same global cooldown state — used to reconcile a card that
   *  lives in a channel the map moved away from (patch its queue-exit note
   *  where it actually is). Sharing the cooldown means a global 429 pauses
   *  every destination-channel client at once (round-34 review). */
  forChannel(channelId: string): EscalationDiscord {
    return new EscalationDiscord(
      this.token,
      channelId,
      this.apiBase,
      this.principalDiscordId,
      this.cooldown,
      this.fetchFn,
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

  /** Wait out any client-wide cooldown (a global 429) before sending — but
   *  never past the pass deadline (round-29 review). */
  private async waitForCooldown(deadline?: number): Promise<void> {
    while (this.cooldown.until > Date.now()) {
      if (deadline !== undefined && Date.now() > deadline) {
        throw new EscalateError("discord deferred: pass deadline reached");
      }
      await sleep(
        Math.min(
          250,
          this.cooldown.until - Date.now(),
          deadline === undefined
            ? Infinity
            : Math.max(0, deadline - Date.now()),
        ),
      );
    }
    this.cooldown.until = 0;
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
      body?: string | FormData;
    },
    deadline?: number,
  ): Promise<DiscordHttpResult> {
    await this.waitForCooldown(deadline);
    await this.throttle(deadline);
    // A global 429 may have been set by another pooled request WHILE we
    // queued behind the throttle slot — re-wait so a cooldown set mid-queue
    // isn't bypassed (round-34 review).
    await this.waitForCooldown(deadline);
    // Recheck the pass deadline AFTER the queued cooldown + throttle waits —
    // a request queued behind a 30s cooldown must not then spend its own 30s
    // fetch timeout past the pass bound (round-29 review).
    if (deadline !== undefined && Date.now() > deadline) {
      throw new EscalateError(
        `discord ${init.method} ${path} deferred: pass deadline reached`,
      );
    }
    const controller = new AbortController();
    // The abort timeout is the smaller of 30s and the remaining deadline — a
    // request begun just before the pass cutoff must not spend a full 30s
    // fetch timeout past the bound (round-30 review). The controller stays
    // alive through the BODY read too (round-38 blocker): the timer is
    // cleared only after response.text() resolves, so a server that sends
    // headers then stalls its body is still aborted — a bare
    // `await response.json()` after the fetch would be unbounded.
    const abortMs =
      deadline === undefined
        ? 30_000
        : Math.max(1, Math.min(30_000, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), abortMs);
    try {
      const response = await this.fetchFn(`${this.apiBase}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(init.headers ?? {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      // Buffer the body INSIDE the abort scope: the headers arriving without
      // the body is a real stalled-response case that must not run unbounded.
      const bodyText = await response.text();
      return { status: response.status, headers: response.headers, bodyText };
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    method: "POST" | "PATCH",
    path: string,
    content: string,
    deadline?: number,
    files: readonly DiscordFile[] = [],
    embeds: readonly { description: string }[] = [],
    retryServerErrors = true,
    replyTo?: string,
  ): Promise<DiscordHttpResult> {
    validateDiscordFiles(files);
    // Every call times out — a run can never stall indefinitely holding the
    // announce-once lock. Calls are spaced ≥1s apart. On a rate limit (429),
    // a GLOBAL cooldown must be waited out in full — retrying into it just
    // resets the bucket and extends the throttle (observed live) — so a global
    // 429 waits max(Retry-After, 30s) capped at MAX_COOLDOWN_MS; a local 429
    // waits Retry-After.
    const maxAttempts = 4;
    let lastStatus = 0;
    let firstRetryAfterSec = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // The pass deadline bounds RETRIES too, not just starts: a request
      // begun just before the deadline must not hold the tick through four
      // 30s-cooldown attempts past it (round-27 review — "never blocks
      // walking").
      if (deadline !== undefined && Date.now() > deadline) {
        throw new EscalateError(
          `discord ${method} ${path} deferred: pass deadline reached`,
        );
      }
      let response: DiscordHttpResult;
      try {
        const payload = {
          content,
          allowed_mentions: {
            parse: [],
            users: this.principalDiscordId ? [this.principalDiscordId] : [],
            // A reply never pings the author it answers.
            ...(replyTo === undefined ? {} : { replied_user: false }),
          },
          // A reply to a message that is gone posts as a plain message.
          ...(replyTo === undefined ? {} : { message_reference: { message_id: replyTo, fail_if_not_exists: false } }),
          ...(embeds.length === 0 ? {} : { embeds }),
          ...(files.length === 0 ? {} : {
            attachments: files.map((f, id) => ({ id, filename: f.name, description: f.description })),
          }),
        };
        let body: string | FormData = JSON.stringify(payload);
        if (files.length > 0) {
          const form = new FormData();
          form.append("payload_json", body);
          files.forEach((f, id) => form.append(`files[${id}]`, f.data, f.name));
          body = form;
        }
        response = await this.fetchOnce(
          path,
          {
            method,
            headers: files.length === 0 ? { "Content-Type": "application/json" } : {},
            // parse: [] suppresses untrusted @everyone/@here/role mentions in
            // graph-derived content; only the principal's id (when configured)
            // is allowed to ping.
            body,
          },
          deadline,
        );
      } catch (error) {
        throw new EscalateError(
          `discord ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (response.status !== 429 && response.status < 500) {
        return response;
      }
      // A 429 created nothing and is always safe to resend. A 5xx may arrive
      // after Discord already created the message, so a caller that must not
      // double-post (the claim announce) takes it as the answer instead.
      if (response.status !== 429 && !retryServerErrors) {
        return response;
      }
      lastStatus = response.status;
      const policy = rateLimitWait(response.headers, attempt);
      if (attempt === 1) firstRetryAfterSec = policy.firstRetryAfterSec;
      if (policy.global) {
        // Advance the client-wide deadline so every pooled request waits
        // this out too, not just this one. CAPPED at MAX_COOLDOWN_MS: an
        // arbitrary Retry-After (Discord can return minutes-to-an-hour) must
        // not hold the tick — and hence the walk lane — for that long
        // (round-26 review: "escalation never blocks walking"). After the
        // cap the request resumes, likely 429s again, and the attempt budget
        // eventually defers the card rather than sleeping the whole cooldown.
        const cooldownMs = Math.max(policy.waitMs, 30_000);
        this.cooldown.until = Math.min(
          Math.max(this.cooldown.until, Date.now() + cooldownMs),
          Date.now() + MAX_COOLDOWN_MS,
        );
      }
      if (policy.failFast) {
        break; // hot card — defer to next tick instead of hammering
      }
      // The per-attempt sleep is CAPPED like the cooldown deadline — a large
      // Retry-After must not hold this attempt (and hence the tick) for the
      // full value — and also capped at the pass deadline (round-29 review).
      const cappedWait = policy.global
        ? Math.min(Math.max(policy.waitMs, 30_000), MAX_COOLDOWN_MS)
        : Math.min(policy.waitMs, 30_000);
      await sleep(
        deadline === undefined
          ? cappedWait
          : Math.min(cappedWait, Math.max(0, deadline - Date.now())),
      );
    }
    throw new EscalateError(
      `discord ${method} ${path} failed after ${lastStatus === 0 ? "setup" : maxAttempts} attempts (last HTTP ${lastStatus}${firstRetryAfterSec > 0 ? `, retry-after ${firstRetryAfterSec}s` : ""})`,
    );
  }

  /** Space calls from this client apart so a pooled pass stays rate-limit-safe.
   *  The slot is reserved synchronously BEFORE any await, so concurrent
   *  callers line up at 1s offsets instead of sleeping the same delay and
   *  waking together (a burst that re-triggers the 429s). */
  private async throttle(deadline?: number): Promise<void> {
    const now = Date.now();
    const target = Math.max(this.lastRequestAt + this.minIntervalMs, now);
    this.lastRequestAt = target; // reserve — atomic within the event loop
    const wait = target - now;
    // The throttle sleep is CAPPED by the remaining pass deadline (round-38
    // review): a RANGER_DISCORD_MIN_INTERVAL_MS larger than the 120s pass
    // bound must not hold the walk lane past it. The slot is still reserved
    // (a deferred request resumes next tick), so the spacing guarantee holds.
    const boundedWait =
      deadline === undefined
        ? wait
        : Math.min(wait, Math.max(0, deadline - Date.now()));
    if (boundedWait > 0) {
      await sleep(boundedWait);
    }
  }

  /**
   * Post a new card; returns the Discord message id (announce-once). With
   * `replyTo`, the card is a reply to that message (`message_reference`):
   * an intake draft card answers the principal's @-mention (node #249).
   */
  async post(
    content: string,
    deadline?: number,
    files: readonly DiscordFile[] = [],
    embeds: readonly { description: string }[] = [],
    opts: { retryServerErrors?: boolean; replyTo?: string } = {},
  ): Promise<string> {
    const response = await this.request(
      "POST",
      `/channels/${this.channelId}/messages`,
      content,
      deadline,
      files,
      embeds,
      opts.retryServerErrors ?? true,
      opts.replyTo,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new EscalateError(`discord post returned HTTP ${response.status}`);
    }
    let body: { id?: string };
    try {
      body = JSON.parse(response.bodyText) as { id?: string };
    } catch {
      throw new EscalateError(
        `discord post returned an unparseable body (HTTP ${response.status})`,
      );
    }
    if (typeof body.id !== "string" || body.id.length === 0) {
      throw new EscalateError("discord post returned no message id");
    }
    return body.id;
  }

  /** Edit an existing card in place (edit-not-repost). */
  async edit(
    messageId: string,
    content: string,
    deadline?: number,
  ): Promise<void> {
    const response = await this.request(
      "PATCH",
      `/channels/${this.channelId}/messages/${messageId}`,
      content,
      deadline,
    );
    // 404 = the message is not in THIS channel — the destination moved (or
    // the card was deleted). Surface it distinctly so the caller can repost
    // fresh instead of retrying a doomed edit every tick.
    if (response.status === 404) {
      throw new DiscordMessageGoneError(
        `discord message ${messageId} is not in channel ${this.channelId} — destination moved; repost needed`,
      );
    }
    if (!(response.status >= 200 && response.status < 300)) {
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
  async messageExists(messageId: string, deadline?: number): Promise<boolean> {
    const path = `/channels/${this.channelId}/messages/${messageId}`;
    let response: DiscordHttpResult;
    try {
      response = await this.fetchOnce(path, { method: "GET" }, deadline);
    } catch {
      return true; // transient read failure — do not repost on a guess
    }
    if (response.status === 404) return false;
    // A 5xx is transient — retry a couple of times before falling back to
    // "assume it exists" (a repost must never be based on an unreliable
    // read; a persistent 5xx is an outage, not a deletion).
    if (response.status >= 500) {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Bound the retry by the pass deadline (round-27 review).
        if (deadline !== undefined && Date.now() > deadline) return true;
        await sleep(500 * (attempt + 1));
        try {
          response = await this.fetchOnce(path, { method: "GET" }, deadline);
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

  // ---- thread reads (human-observation intake, node #247) ----

  /**
   * One GET, parsed; any non-2xx, network error or bad body throws. With
   * `gone`, a 404 throws `DiscordMessageGoneError`: the message is not in
   * this channel.
   */
  private async getJson(path: string, label: string, deadline?: number, gone = false): Promise<unknown> {
    let response: DiscordHttpResult;
    try {
      response = await this.fetchOnce(path, { method: "GET" }, deadline);
    } catch (error) {
      throw new EscalateError(
        `discord ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (gone && response.status === 404) {
      throw new DiscordMessageGoneError(`discord ${label} returned HTTP 404 — the message is not in channel ${this.channelId}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new EscalateError(`discord ${label} returned HTTP ${response.status}`);
    }
    try {
      return JSON.parse(response.bodyText);
    } catch {
      throw new EscalateError(`discord ${label} returned an unparseable body`);
    }
  }

  /** The bot's own user id (`GET /users/@me`): the id an @-mention names. */
  async currentUserId(deadline?: number): Promise<string> {
    const body = (await this.getJson("/users/@me", "read of the bot user", deadline)) as { id?: unknown } | null;
    if (typeof body?.id !== "string" || body.id.length === 0) {
      throw new EscalateError("discord read of the bot user returned no id");
    }
    return body.id;
  }

  /** The guild this channel belongs to, for a message link; null outside a guild. */
  async guildId(deadline?: number): Promise<string | null> {
    const body = (await this.getJson(`/channels/${this.channelId}`, `read of channel ${this.channelId}`, deadline)) as
      | { guild_id?: unknown }
      | null;
    return typeof body?.guild_id === "string" && body.guild_id.length > 0 ? body.guild_id : null;
  }

  /**
   * Up to `limit` messages after `after` in this channel, oldest first. Over
   * REST a bot gets the content of a message that mentions it, and of its own
   * messages, without the privileged Message Content intent; other messages
   * may come back empty. `after` = `THREAD_START` reads from the oldest
   * message still in the channel, one page at a time.
   */
  async messagesAfter(after: string, limit = THREAD_PAGE_SIZE, deadline?: number): Promise<ThreadMessage[]> {
    const label = `read of channel ${this.channelId} messages`;
    const body = await this.getJson(
      `/channels/${this.channelId}/messages?after=${encodeURIComponent(after)}&limit=${limit}`,
      label,
      deadline,
    );
    if (!Array.isArray(body)) throw new EscalateError(`discord ${label} returned no message list`);
    const messages = body.map((raw): ThreadMessage => {
      const m = raw as {
        id?: unknown;
        content?: unknown;
        author?: { id?: unknown };
        mentions?: { id?: unknown }[];
        message_reference?: { message_id?: unknown; type?: unknown } | null;
      };
      if (typeof m?.id !== "string" || !SNOWFLAKE.test(m.id)) {
        throw new EscalateError(`discord ${label} returned a message without an id`);
      }
      return {
        id: m.id,
        content: typeof m.content === "string" ? m.content : "",
        authorId: typeof m.author?.id === "string" ? m.author.id : "",
        mentionIds: Array.isArray(m.mentions)
          ? m.mentions.flatMap((u) => (typeof u?.id === "string" ? [u.id] : []))
          : [],
        isReply: m.message_reference !== undefined && m.message_reference !== null,
        replyTo: replyTarget(m.message_reference),
      };
    });
    // Discord lists newest first; intake walks oldest first.
    return messages.sort((a, b) => compareSnowflakes(a.id, b.id));
  }

  /**
   * The ids of every user who reacted `emoji` on a message in this channel,
   * every page (the intake gate, node #251). Any failed page throws, so a
   * caller never decides on part of the answer.
   */
  async reactionUserIds(messageId: string, emoji: string, deadline?: number): Promise<string[]> {
    const label = `read of ${emoji} reactions on message ${messageId}`;
    const base = `/channels/${this.channelId}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`;
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_REACTION_PAGES; page++) {
      const query = `?limit=${REACTION_PAGE_SIZE}${after === null ? "" : `&after=${after}`}`;
      const body = await this.getJson(`${base}${query}`, label, deadline, true);
      if (!Array.isArray(body)) throw new EscalateError(`discord ${label} returned no user list`);
      const users = body.map((raw) => {
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || !SNOWFLAKE.test(id)) throw new EscalateError(`discord ${label} returned a user without an id`);
        return id;
      });
      ids.push(...users);
      if (users.length < REACTION_PAGE_SIZE) return ids;
      after = users.reduce((a, b) => (compareSnowflakes(a, b) >= 0 ? a : b));
    }
    throw new EscalateError(`discord ${label}: more than ${MAX_REACTION_PAGES} pages`);
  }
}

/** Discord's maximum page of reacting users. */
const REACTION_PAGE_SIZE = 100;
const MAX_REACTION_PAGES = 10;

/** The page size of a thread read: Discord's maximum. */
export const THREAD_PAGE_SIZE = 100;

const SNOWFLAKE = /^\d{1,20}$/;

/** One message read from a map thread: only the fields intake reads. */
export interface ThreadMessage {
  id: string;
  /** Empty when Discord withheld it (no mention, no Message Content intent). */
  content: string;
  authorId: string;
  /** Users the message mentions, by id. */
  mentionIds: string[];
  /** A reply: Discord lists the replied-to author as mentioned when it pings. */
  isReply: boolean;
  /** The message this one replies to; null for a non-reply or a forward. */
  replyTo: string | null;
}

/** The cursor before every message: a read after it starts at the channel's oldest message. */
export const THREAD_START = "0";

/** The id a reply's `message_reference` points at. A forward (type 1) answers nothing. */
function replyTarget(reference: { message_id?: unknown; type?: unknown } | null | undefined): string | null {
  if (reference === undefined || reference === null) return null;
  if (reference.type !== undefined && reference.type !== 0) return null;
  return typeof reference.message_id === "string" && SNOWFLAKE.test(reference.message_id) ? reference.message_id : null;
}

/** Order two Discord snowflakes (ids grow with time). */
export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Discord's epoch (2015-01-01T00:00:00Z) in ms. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** The smallest snowflake Discord could mint at `at`: messages after it are newer. */
export function snowflakeAt(at: Date): string {
  const ms = BigInt(Math.max(0, at.getTime())) - DISCORD_EPOCH_MS;
  return (ms < 0n ? 0n : ms << 22n).toString();
}

/** The cursor just before `id`: a read after it starts with that message. */
export function snowflakeBefore(id: string): string {
  const before = BigInt(id) - 1n;
  return (before < 0n ? 0n : before).toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

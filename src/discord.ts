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
  response: Response,
  attempt: number,
): {
  waitMs: number;
  global: boolean;
  failFast: boolean;
  firstRetryAfterSec: number;
} {
  const retryAfter = Number(response.headers.get("retry-after"));
  const firstRetryAfterSec = Number.isFinite(retryAfter) ? retryAfter : 0;
  const global = response.headers.get("x-ratelimit-global") !== null;
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

  /** Wait out any client-wide cooldown (a global 429) before sending — but
   *  never past the pass deadline (round-29 review). */
  private async waitForCooldown(deadline?: number): Promise<void> {
    while (this.cooldownUntil > Date.now()) {
      if (deadline !== undefined && Date.now() > deadline) {
        throw new EscalateError("discord deferred: pass deadline reached");
      }
      await sleep(
        Math.min(
          250,
          this.cooldownUntil - Date.now(),
          deadline === undefined
            ? Infinity
            : Math.max(0, deadline - Date.now()),
        ),
      );
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
    deadline?: number,
  ): Promise<Response> {
    await this.waitForCooldown(deadline);
    await this.throttle();
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
    // fetch timeout past the bound (round-30 review).
    const abortMs =
      deadline === undefined
        ? 30_000
        : Math.max(1, Math.min(30_000, deadline - Date.now()));
    const timer = setTimeout(() => controller.abort(), abortMs);
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
    deadline?: number,
  ): Promise<Response> {
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
      let response: Response;
      try {
        response = await this.fetchOnce(
          path,
          {
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
      lastStatus = response.status;
      const policy = rateLimitWait(response, attempt);
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
        this.cooldownUntil = Math.min(
          Math.max(this.cooldownUntil, Date.now() + cooldownMs),
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
  async post(content: string, deadline?: number): Promise<string> {
    const response = await this.request(
      "POST",
      `/channels/${this.channelId}/messages`,
      content,
      deadline,
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
  async messageExists(messageId: string, deadline?: number): Promise<boolean> {
    const path = `/channels/${this.channelId}/messages/${messageId}`;
    let response: Response;
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
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

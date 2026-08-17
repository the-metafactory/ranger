import type { RangerMapConfig } from "./config.ts";
import { resolveDiscordApiBase } from "./discord.ts";

/**
 * Claim-announce, fail-closed (design §5, node #7).
 *
 * Window-based vetoes were replaced by blocking-vs-non-blocking: claims proceed
 * automatically with NO veto window — but announce fail-closed still gates them
 * (no confirmed Discord message id → no claim). Node #13's body still says
 * "60s veto"; that wording predates node #7 and is deliberately NOT
 * implemented. This module posts the announce and throws on any failure so the
 * caller refuses to claim.
 */

export class AnnounceError extends Error {
 override readonly name = "AnnounceError";
}

export interface AnnounceResult {
 /** Discord message id — the confirmed-announce token that unblocks the claim. */
 messageId: string;
}

export interface AnnounceContext {
 repo: string;
 nodeId: string;
 nodeTitle: string;
 mapTitle?: string;
}

export interface Announcer {
 /**
  * Post the claim-announce card. Must resolve with a message id or throw —
  * there is no third state, and a throwing announcer blocks the claim.
  */
 announce(ctx: AnnounceContext): Promise<AnnounceResult>;
}

/**
 * Real Discord announcer. API base is overridable via RANGER_DISCORD_API_BASE
 * (the tests point it at a local server). Reads the token from the map's
 * `discord.tokenEnv` env var name; unset token → fail-closed throw.
 */
export class DiscordAnnouncer implements Announcer {
 constructor(
  private readonly token: string,
  private readonly channelId: string,
  private readonly apiBase: string = resolveDiscordApiBase(),
 ) {}

 static fromMap(
  map: RangerMapConfig,
  env: NodeJS.ProcessEnv = process.env,
 ): DiscordAnnouncer {
  if (map.discord === undefined) {
   throw new AnnounceError(
    `map ${map.repo} has no discord surface — cannot announce; a claim is refused. ` +
     `Add a discord.tokenEnv + channelId to the map (node #7).`,
   );
  }
  const token = env[map.discord.tokenEnv];
  if (token === undefined || token.length === 0) {
   throw new AnnounceError(
    `discord token env ${map.discord.tokenEnv} is unset — announce fail-closed, no claim. ` +
     `Set ${map.discord.tokenEnv} to the bot token for map ${map.repo}.`,
   );
  }
  return new DiscordAnnouncer(token, map.discord.channelId);
 }

 async announce(ctx: AnnounceContext): Promise<AnnounceResult> {
  const content = [
    `:ranger: **claim** #${ctx.nodeId} — ${ctx.nodeTitle}`,
    `map: ${ctx.repo}${ctx.mapTitle === undefined ? "" : ` (${ctx.mapTitle})`}`,
  ].join("\n");
  let response: Response;
  try {
    response = await fetch(
      `${this.apiBase}/channels/${this.channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      },
    );
  } catch (error) {
    throw new AnnounceError(
      `announce failed for #${ctx.nodeId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new AnnounceError(
      `announce for #${ctx.nodeId} returned HTTP ${response.status} — fail-closed, no claim.`,
    );
  }
  const body = (await response.json()) as { id?: string };
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new AnnounceError(
      `announce for #${ctx.nodeId} returned no message id — fail-closed, no claim.`,
    );
  }
  return { messageId: body.id };
 }
}

/** In-memory announcer for tests: records posts, optionally fails. */
export class RecordingAnnouncer implements Announcer {
 posts: { ctx: AnnounceContext; messageId: string }[] = [];
 private readonly fail: boolean;

 constructor(opts: { fail?: boolean } = {}) {
  this.fail = opts.fail ?? false;
 }

 async announce(ctx: AnnounceContext): Promise<AnnounceResult> {
  if (this.fail) {
   throw new AnnounceError(`recording announcer told to fail for #${ctx.nodeId}`);
  }
  const messageId = `msg-${ctx.nodeId}-${this.posts.length}`;
  this.posts.push({ ctx, messageId });
  return { messageId };
 }
}

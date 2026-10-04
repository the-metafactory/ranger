import { mapKey } from "./maps.ts";
import type { RangerMapConfig } from "./config.ts";
import { EscalationDiscord, resolveDiscordApiBase, type DiscordFile } from "./discord.ts";

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
 root: number;
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
 private readonly discord: EscalationDiscord;
 constructor(
  token: string,
  channelId: string,
  apiBase: string = resolveDiscordApiBase(),
  fetchFn: typeof fetch = fetch,
 ) {
  this.discord = new EscalationDiscord(token, channelId, apiBase, undefined, undefined, fetchFn);
 }

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
   `map: ${mapKey(ctx)}${ctx.mapTitle === undefined ? "" : ` (${ctx.mapTitle})`}`,
  ].join("\n");
  return { messageId: await this.post(content, `claim announce for #${ctx.nodeId}`) };
 }

 /**
  * Post one message to the map's channel and return its id, or throw. The
  * claim announce and the implement lane's merge cards (#23) share it.
  */
 async post(content: string, label: string, files: readonly DiscordFile[] = [], embeds: readonly { description: string }[] = []): Promise<string> {
  try {
   // Bounded at 30 s through the body read (round-35/38), and fail-closed:
   // a 429 is resent, but a 5xx is not, since Discord may already have
   // created the message and a resend would announce the claim twice.
   return await this.discord.post(content, Date.now() + 30_000, files, embeds, {
    retryServerErrors: false,
   });
  } catch (error) {
   throw new AnnounceError(
    `${label} failed: ${error instanceof Error ? error.message : String(error)} — fail-closed.`,
   );
  }
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
   throw new AnnounceError(
    `recording announcer told to fail for #${ctx.nodeId}`,
   );
  }
  const messageId = `msg-${ctx.nodeId}-${this.posts.length}`;
  this.posts.push({ ctx, messageId });
  return { messageId };
 }
}

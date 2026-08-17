import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

export const fixturesBin = join(import.meta.dir, "fixtures", "bin");
export const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
export const bun = process.execPath;

/**
 * The ranger.yaml skeleton shared by every e2e suite. Suites inject their
 * section-specific lines via `opts`, so schema or invocation changes land in
 * one place. Sections: `map` (inside the map stanza after `walk`), `auth`
 * (after readOnlyTokens), `beforeState` (between bot and state, e.g.
 * principal), `state` (after journalPath), `workers` (after spawnCapPerDay).
 */
export function baseConfigLines(
 dir: string,
 opts: {
  map?: string[];
  auth?: string[];
  beforeState?: string[];
  state?: string[];
  workers?: string[];
 } = {},
): string[] {
 return [
  "version: 1",
  "maps:",
  "  - repo: acme/widgets",
  "    root: 1",
  "    walk: research-only",
  ...(opts.map ?? []),
  "    discord:",
  "      tokenEnv: RANGER_DISCORD_TOKEN",
  '      channelId: "1234567890"',
  "auth:",
  "  readOnlyTokens:",
  '    "acme/*": RANGER_RO_TEST',
  ...(opts.auth ?? []),
  "bot:",
  "  identity: ivy-bot",
  ...(opts.beforeState ?? []),
  "state:",
  `  journalPath: ${join(dir, "state.sqlite")}`,
  ...(opts.state ?? []),
  "workers:",
  "  spawnCapPerDay: 10",
  ...(opts.workers ?? []),
 ];
}

/** Run the ranger CLI in-process; returns {stdout, stderr, exitCode}. */
export async function runCli(
 args: string[],
 env: NodeJS.ProcessEnv,
 cwd = join(import.meta.dir, ".."),
) {
 return runCmd(bun, [cliPath, ...args], { env, cwd });
}

/**
 * Fake Discord API: POST /channels/:id → post, PATCH /channels/:id/messages/:m
 * → edit. Message ids carry a `discord-msg-` prefix so callers can tell a
 * posted id from a fake one.
 */
export function fakeDiscord() {
 const posts: { url: string; messageId: string; content: string }[] = [];
 const edits: { messageId: string; content: string }[] = [];
 const server = Bun.serve({
  port: 0,
  async fetch(req) {
   const url = new URL(req.url);
   if (req.method === "POST" && url.pathname.startsWith("/channels/")) {
    const parsed = (await req.json()) as { content?: string };
    const messageId = `discord-msg-${posts.length + 1}`;
    posts.push({ url: req.url, messageId, content: parsed?.content ?? "" });
    return Response.json({ id: messageId });
   }
   const editMatch = url.pathname.match(
    /^\/channels\/[^/]+\/messages\/([^/]+)$/,
   );
   if (req.method === "PATCH" && editMatch) {
    const messageId = editMatch[1];
    const parsed = (await req.json()) as { content?: string };
    edits.push({ messageId, content: parsed?.content ?? "" });
    return Response.json({ id: messageId });
   }
   return new Response("not found", { status: 404 });
  },
 });
 return {
  port: server.port as number,
  posts,
  edits,
  stop: () => server.stop(true),
 };
}

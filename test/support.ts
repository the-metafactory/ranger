import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

export const fixturesBin = join(import.meta.dir, "fixtures", "bin");
export const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
export const bun = process.execPath;

export const GIT_ENV = {
 GIT_AUTHOR_NAME: "ranger-test",
 GIT_AUTHOR_EMAIL: "ranger-test@example.com",
 GIT_COMMITTER_NAME: "ranger-test",
 GIT_COMMITTER_EMAIL: "ranger-test@example.com",
};

/**
 * Seed a real git origin (with a main branch) and a canonical clone, the
 * fixture shared by every run-node/worktree test. Returns the origin and
 * canonical paths.
 */
export async function createCanonicalRepo(
 dir: string,
): Promise<{ origin: string; canonical: string }> {
 const seed = join(dir, "seed");
 mkdirSync(seed, { recursive: true });
 writeFileSync(join(seed, "README.md"), "# acme/widgets\n");
 const git = (args: string[], cwd: string) =>
  runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV } });
 await git(["init", "-b", "main"], seed);
 await git(["add", "-A"], seed);
 await git(["commit", "-m", "initial"], seed);
 const origin = join(dir, "origin.git");
 await git(["clone", "--bare", seed, origin], dir);
 const canonical = join(dir, "canonical");
 await git(["clone", origin, canonical], dir);
 return { origin, canonical };
}

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
  channelId?: string;
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
  `      channelId: "${opts.channelId ?? "1234567890"}"`,
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
 const deleted = new Set<string>(); // messages removed — GET returns 404
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
   if (req.method === "GET" && editMatch) {
    const messageId = editMatch[1];
    if (deleted.has(messageId)) {
     return new Response("not found", { status: 404 });
    }
    const exists = posts.some((p) => p.messageId === messageId);
    return exists
     ? Response.json({ id: messageId })
     : new Response("not found", { status: 404 });
   }
   return new Response("not found", { status: 404 });
  },
 });
 return {
  port: server.port as number,
  posts,
  edits,
  deleteMessage: (id: string) => deleted.add(id),
  stop: () => server.stop(true),
 };
}

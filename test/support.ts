import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { runCmd } from "../src/exec.ts";

export const fixturesBin = join(import.meta.dir, "fixtures", "bin");
export const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
export const bun = process.execPath;

/**
 * A spawned CLI stays in test mode (node #66): RANGER_UNDER_TEST=1 keeps the
 * live journal directory refused and an unset state.journalPath a temp file,
 * even when the test hands the child a minimal env.
 */
export function testCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
 return { ...env, RANGER_UNDER_TEST: "1" };
}

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
 * Add a node worktree the way ranger did before node #81: a `node/<N>-<slug>`
 * branch that tracks origin/<base>, so the shared config gains its remote +
 * merge lines. Branches from older builds and an operator's own
 * `git worktree add -b` still write them; `bootstrapWorktree` no longer does.
 */
export async function addTrackedWorktree(
 canonical: string,
 nodeId: string,
 slug: string,
 base = "main",
): Promise<void> {
 const result = await runCmd(
  "git",
  ["worktree", "add", "--track", join(canonical, ".worktrees", `node-${nodeId}`), "-b", `node/${nodeId}-${slug}`, `origin/${base}`],
  { cwd: canonical, env: { ...process.env, ...GIT_ENV } },
 );
 if (result.code !== 0) throw new Error(`git worktree add: ${result.stderr}`);
}

/**
 * The ranger.yaml skeleton shared by every e2e suite. Suites inject their
 * section-specific lines via `opts`, so schema or invocation changes land in
 * one place. Sections: `map` (inside the map stanza after `walk`), `auth`
 * (after readOnlyTokens), `beforeState` (between bot and state, e.g.
 * principal), `state` (after journalPath), `workers` (after spawnCapPerDay).
 * Every config it builds carries a temp `state.journalPath` under `dir`, never
 * the live default (node #66).
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
  // Fixture workers run at the test's own priority: niced, they starve under
  // host load and trip the suite's timeouts (the priority tests set it).
  "  niceness: 0",
  ...(opts.workers ?? []),
 ];
}

/** Run the ranger CLI in-process; returns {stdout, stderr, exitCode}. */
export async function runCli(
 args: string[],
 env: NodeJS.ProcessEnv,
 cwd = join(import.meta.dir, ".."),
) {
 return runCmd(bun, [cliPath, ...args], { env: testCliEnv(env), cwd });
}

/**
 * Spawn the CLI WITHOUT waiting for it — the test gets the ChildProcess so it
 * can observe mid-run state (e.g. the announce-once lock while a run holds
 * it) and a `result` promise resolving to {code, stdout, stderr} on exit.
 */
export function runCliSpawn(
 args: string[],
 env: NodeJS.ProcessEnv,
 cwd = join(import.meta.dir, ".."),
): {
 child: ChildProcess;
 result: Promise<{ code: number; stdout: string; stderr: string }>;
} {
 const child = spawn(bun, [cliPath, ...args], {
  env: testCliEnv(env),
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
 });
 let stdout = "";
 let stderr = "";
 child.stdout.on("data", (c) => (stdout += c.toString()));
 child.stderr.on("data", (c) => (stderr += c.toString()));
 const result = new Promise<{ code: number; stdout: string; stderr: string }>(
  (resolve) =>
   child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr })),
 );
 return { child, result };
}

/** The fake Discord's own bot user id and guild (intake, node #247). */
export const FAKE_BOT_ID = "900000000000000001";
export const FAKE_GUILD_ID = "700000000000000007";

/** A thread message as Discord's REST API returns it (intake, node #247). */
export interface FakeThreadMessage {
 id: string;
 content: string;
 author: { id: string; bot?: boolean };
 mentions: { id: string }[];
 message_reference?: { message_id: string };
}

/**
 * Fake Discord API: POST /channels/:id → post, PATCH /channels/:id/messages/:m
 * → edit. Message ids carry a `discord-msg-` prefix so callers can tell a
 * posted id from a fake one. Thread reads (GET /users/@me, /channels/:id and
 * /channels/:id/messages) serve the messages `say` added (intake, node #247).
 */
export function fakeDiscord() {
 const posts: { url: string; messageId: string; content: string }[] = [];
 const edits: { messageId: string; content: string }[] = [];
 const deleted = new Set<string>(); // messages removed — GET returns 404
 // Thread messages per channel, and every thread read (`after` cursor).
 const threads = new Map<string, FakeThreadMessage[]>();
 const threadReads: { channelId: string; after: string | null }[] = [];
 const meReads: number[] = [];
 let threadReadStatus = 200;
 // Reactions per `messageId|emoji`, every reaction read, and the status the
 // reaction reads and edits answer (intake gate, node #251).
 const reactions = new Map<string, string[]>();
 const reactionReads: { messageId: string; emoji: string; after: string | null }[] = [];
 let reactionReadStatus = 200;
 let editStatus = 200;
 const server = Bun.serve({
  port: 0,
  async fetch(req) {
   const url = new URL(req.url);
   if (req.method === "GET" && url.pathname === "/users/@me") {
    meReads.push(Date.now());
    return Response.json({ id: FAKE_BOT_ID, bot: true });
   }
   const listMatch = url.pathname.match(/^\/channels\/([^/]+)\/messages$/);
   if (req.method === "GET" && listMatch) {
    const channelId = listMatch[1]!;
    const after = url.searchParams.get("after");
    threadReads.push({ channelId, after });
    if (threadReadStatus !== 200) return new Response("refused", { status: threadReadStatus });
    const limit = Number(url.searchParams.get("limit") ?? 50);
    // Like Discord: the messages nearest after the cursor, newest first.
    const newer = (threads.get(channelId) ?? [])
     .filter((m) => after === null || BigInt(m.id) > BigInt(after))
     .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
     .slice(0, limit)
     .reverse();
    return Response.json(newer);
   }
   const reactionMatch = url.pathname.match(/^\/channels\/[^/]+\/messages\/([^/]+)\/reactions\/([^/]+)$/);
   if (req.method === "GET" && reactionMatch) {
    const messageId = decodeURIComponent(reactionMatch[1]!);
    const emoji = decodeURIComponent(reactionMatch[2]!);
    const after = url.searchParams.get("after");
    reactionReads.push({ messageId, emoji, after });
    if (reactionReadStatus !== 200) return new Response("refused", { status: reactionReadStatus });
    if (deleted.has(messageId)) return new Response("unknown message", { status: 404 });
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const users = (reactions.get(`${messageId}|${emoji}`) ?? [])
     .filter((id) => after === null || BigInt(id) > BigInt(after))
     .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
     .slice(0, limit);
    return Response.json(users.map((id) => ({ id })));
   }
   const channelMatch = url.pathname.match(/^\/channels\/([^/]+)$/);
   if (req.method === "GET" && channelMatch) {
    return Response.json({ id: channelMatch[1], guild_id: FAKE_GUILD_ID });
   }
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
    if (editStatus !== 200) return new Response("refused", { status: editStatus });
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
  /** Add a message to a thread (ids must grow with time, as snowflakes do). */
  say: (channelId: string, message: FakeThreadMessage) => {
   threads.set(channelId, [...(threads.get(channelId) ?? []), message]);
  },
  threadReads,
  meReads,
  /** Answer every thread read with this HTTP status (200 = serve normally). */
  failThreadReads: (status: number) => { threadReadStatus = status; },
  /** A user reacts `emoji` on a message (intake gate, node #251). */
  react: (messageId: string, emoji: string, userId: string) => {
   const key = `${messageId}|${emoji}`;
   reactions.set(key, [...(reactions.get(key) ?? []), userId]);
  },
  reactionReads,
  /** Answer every reaction read with this HTTP status (200 = serve normally). */
  failReactionReads: (status: number) => { reactionReadStatus = status; },
  /** Answer every edit with this HTTP status (200 = edit normally). */
  failEdits: (status: number) => { editStatus = status; },
  stop: () => server.stop(true),
 };
}

/**
 * Whether the temp filesystem takes a file name that is not UTF-8. APFS
 * refuses one (EILSEQ); any other error is a broken probe, never a skip.
 */
export function takesRawByteNames(): boolean {
 const probe = mkdtempSync(join(tmpdir(), "ranger-raw-name-"));
 try {
  writeFileSync(Buffer.concat([Buffer.from(`${probe}/x`), Buffer.from([0xff])]), "");
  return true;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EILSEQ") return false;
  throw error;
 } finally {
  rmSync(probe, { recursive: true, force: true });
 }
}

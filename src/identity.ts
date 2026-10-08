import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerAuthConfig, RangerConfig } from "./config.ts";
import { principalLoginForRepo } from "./config.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import { parseForgeRef, qualifiedRepo } from "./forge-ref.ts";
import { glabConfigEnv } from "./glab-config-dir.ts";
import { workerEnvPasses } from "./untrusted-env.ts";

/**
 * The write-credential gate (design §2 identity model, node #11).
 *
 * Graph-mutating ranger components (the walker's claim/close/decisions) run
 * under the machine account's write PAT — never the principal's credential —
 * and refuse to run when the resolved identity equals the principal's login.
 * GitHub pins `GH_TOKEN` and isolates `GH_CONFIG_DIR`. GitLab writes a single
 * host's credential into a per-call `GLAB_CONFIG_DIR`, shared with the read
 * gate's config helper. Neither CLI consults the principal's configuration.
 * Unlike the read-only gate, it does NOT set `SOMA_GRAPH_READONLY`, but
 * preserves an inherited operator restriction.
 */

export class WriteGateError extends Error {
 override readonly name = "WriteGateError";
 /**
  * True when the gate could not be evaluated (the forge's identity read failed
  * or timed out), as opposed to a definitive refusal (unmapped token, the
  * principal's identity, a bot.identity mismatch). A queued resume defers on a
  * transient gate without counting a failed start (node #158).
  */
 constructor(message: string, readonly transient = false) {
  super(message);
 }
}

export interface WriteCredential {
 token: string;
 /** Where the token came from — the env var name, for error/digest messages. */
 source: string;
}

/**
 * Resolve the machine-account write token for a repo. Same longest-prefix
 * semantics as the read-only mapping. Throws WriteGateError when unmapped or
 * unset — a walker that cannot prove its write credential does not run.
 */
export function resolveWriteToken(
 config: RangerConfig,
 repo: string,
 env: NodeJS.ProcessEnv = process.env,
): WriteCredential {
 const tokenEnv = matchWriteTokenEnv(config.auth, repo);
 if (tokenEnv === undefined) {
  throw new WriteGateError(
   `no write-token mapping for ${repo} — add an entry to auth.writeTokens (or auth.defaultWriteTokenEnv). ` +
    `Graph-mutating ticks refuse to run without the machine account's credential (node #11).`,
  );
 }
 // Config load already refuses these; a config built without the schema must too.
 if (workerEnvPasses(tokenEnv)) {
  throw new WriteGateError(
   `write-token env ${tokenEnv} would be inherited by worker sessions — refusing to use it; use a RANGER_* name.`,
  );
 }
 const token = env[tokenEnv];
 if (token === undefined || token.trim().length === 0) {
  throw new WriteGateError(
   `write-token env ${tokenEnv} is unset — refusing to run without the machine account's credential (node #11). ` +
    `Set ${tokenEnv} to the machine account's write credential.`,
  );
 }
 return { token, source: tokenEnv };
}

/**
 * Longest-prefix match over `auth.writeTokens`, else the default. Qualified and
 * bare GitHub keys rank by the repo path they cover, not their raw length, so
 * `acme/widgets` beats `github:github.com/acme/`; on a tie the qualified key wins.
 */
export function matchWriteTokenEnv(
 auth: RangerAuthConfig,
 repo: string,
): string | undefined {
 const ref = parseForgeRef(repo);
 const forgeHost = `${ref.forge}:${ref.host}/`;
 let best: { env: string | undefined; specificity: number; qualified: boolean } | undefined;
 for (const [prefix, env] of Object.entries(auth.writeTokens)) {
  const qualified = prefix.includes(":");
  if (!qualified && ref.forge !== "github") continue;
  const target = qualified ? qualifiedRepo(ref) : ref.path;
  const path = prefix.replace(/\*$/, "");
  const matches = qualified
   ? target === path || target.startsWith(path.endsWith("/") ? path : `${path}/`)
   : prefix === "*" || target.startsWith(path);
  if (!matches) continue;
  const specificity = qualified ? Math.max(0, path.length - forgeHost.length) : path.length;
  if (best === undefined || specificity > best.specificity ||
   (specificity === best.specificity && qualified && !best.qualified)) {
   best = { env, specificity, qualified };
  }
 }
 if (best !== undefined) return best.env;
 return ref.forge === "github" ? auth.defaultWriteTokenEnv : undefined;
}

/**
 * Isolated env for graph-mutating subprocesses: `GH_TOKEN` pinned to the
 * machine-account token, `GH_CONFIG_DIR` pointed at a throwaway empty dir so
 * gh never touches the real keyring. Does NOT set `SOMA_GRAPH_READONLY` — this
 * credential is allowed to mutate the graph.
 */
export function writeEnv(
 token: string,
 extra: NodeJS.ProcessEnv = {},
 base: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; cleanup: () => void } {
 const dir = mkdtempSync(join(tmpdir(), "ranger-write-"));
 const env: NodeJS.ProcessEnv = { ...base, ...extra, GH_TOKEN: token, GITHUB_TOKEN: token, GH_CONFIG_DIR: dir };
 return {
  env,
  cleanup: () => {
   try {
    rmSync(dir, { recursive: true, force: true });
   } catch {
    /* best-effort */
   }
  },
 };
}

/** Per-call credential isolation shared by soma writes and forge API writes. */
export function writeEnvForRepo(
 repo: string,
 token: string,
 base: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; cleanup: () => void } {
 if (token.trim().length === 0) throw new WriteGateError("empty write credential — refusing to write");
 const ref = parseForgeRef(repo);
 if (ref.forge === "github") return writeEnv(token, {}, base);
 const gated = glabConfigEnv(ref.host, token, base);
 // Remove only the read helper's forced policy; an operator's policy survives.
 if (base.SOMA_GRAPH_READONLY === undefined) delete gated.env.SOMA_GRAPH_READONLY;
 else gated.env.SOMA_GRAPH_READONLY = base.SOMA_GRAPH_READONLY;
 return gated;
}

/** Intended entry point for the GitLab implement lane's MR/API writes. */
export async function gitlabApiWrite(
 repo: string,
 token: string,
 args: string[],
 runner: typeof runCmd = runCmd,
 opts: RunOptions = {},
) {
 const ref = parseForgeRef(repo);
 if (ref.forge !== "gitlab") throw new WriteGateError("GitLab API write requires a GitLab repo");
 const endpoint = args[0] ?? "";
 if (!/^\/?[a-zA-Z0-9_]/.test(endpoint) || endpoint.includes(":") || endpoint.includes("#") ||
  args.some(arg => arg === "--hostname" || arg.startsWith("--hostname="))) {
  throw new WriteGateError("invalid GitLab write endpoint or host override");
 }
 const gated = writeEnvForRepo(repo, token, opts.env);
 try {
  // glab itself does not enforce soma's graph policy.
  if (gated.env.SOMA_GRAPH_READONLY === "1") {
   throw new WriteGateError("read-only restriction forbids GitLab API writes");
  }
  return await runner("glab", ["api", ...args, "--hostname", ref.host], {
   ...opts, timeoutMs: opts.timeoutMs ?? 60_000, env: gated.env,
  });
 } finally { gated.cleanup(); }
}

/** Resolve GET /user's login (GitHub) or username (GitLab) under the pinned token. */
export async function loginForToken(
 token: string,
 repo: string,
 opts: RunOptions = {},
 runner: typeof runCmd = runCmd,
): Promise<string> {
 const ref = parseForgeRef(repo);
 if (ref.forge === "gitlab") return gitlabLogin(await gitlabGet(token, repo, "/user", runner, opts));
 const gated = writeEnvForRepo(repo, token, opts.env);
 try {
  const result = await runner("gh", ["api", "/user", "--jq", ".login"], {
   ...opts,
   timeoutMs: opts.timeoutMs ?? 60_000,
   env: gated.env,
  });
  if (result.code !== 0) {
   throw new WriteGateError(
    `cannot resolve the identity behind the write token (${ref.forge} api user, exit ${result.code})`, true,
   );
  }
  const login = result.stdout.trim();
  if (!isCleanIdentifier(login)) {
   throw new WriteGateError("cannot resolve write identity: missing login in /user response");
  }
  return login;
 } catch (error) {
  if (error instanceof WriteGateError) throw error;
  throw new WriteGateError(`cannot resolve the identity behind the write token (${ref.forge} api user failed)`, true);
 } finally {
  gated.cleanup();
 }
}

/**
 * The bot identity ranger labels graph operations with: the login resolved
 * from the write token. `bot.identity` pins GitHub only. Never a static
 * guess — the label must match the credential actually driving the write, so
 * the token's real login is always resolved and a configured `bot.identity`
 * that does not match it is refused (a mismatched label would let mutations
 * run under a credential they claim not to be, e.g. the principal's PAT
 * labeled as the machine account).
 */
export async function resolveBotIdentity(
 config: RangerConfig,
 token: string,
 repo: string,
 runner: typeof runCmd = runCmd,
 env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
 const ref = parseForgeRef(repo);
 if (ref.forge === "gitlab") {
  // One /user read yields both the username and GitLab's own bot flag.
  const user = await gitlabGet(token, repo, "/user", runner, { env });
  const resolved = gitlabLogin(user);
  assertNotPrincipal(config, resolved, repo);
  await assertProjectBot(token, repo, user, runner, env);
  return resolved;
 }
 const resolved = await loginForToken(token, repo, { env }, runner);
 if (config.bot.identity !== undefined && config.bot.identity.length > 0) {
  if (resolved !== config.bot.identity) {
   throw new WriteGateError(
    `configured bot.identity '${config.bot.identity}' does not match the ` +
     `write token's login '${resolved}' — the mutation would run under a ` +
     `credential it claims not to be (design §2, node #11). ` +
     `Fix bot.identity or the write-token mapping.`,
   );
  }
 }
 assertNotPrincipal(config, resolved, repo);
 return resolved;
}

function gitlabLogin(user: Record<string, unknown> | null): string {
 const login = user?.username;
 if (!isCleanIdentifier(login)) {
  throw new WriteGateError("cannot resolve write identity: missing login in /user response");
 }
 return login;
}

/**
 * A username alone does not prove a project access-token bot: a human may pick
 * `project_123_bot_…`. Require GitLab's server-reported `bot: true` for the
 * token's user, and require the project id GitLab encodes in a project bot's
 * username to be this repo's project id, so the token belongs to this project.
 */
async function assertProjectBot(
 token: string,
 repo: string,
 user: Record<string, unknown> | null,
 runner: typeof runCmd,
 env: NodeJS.ProcessEnv,
): Promise<void> {
 const refuse = (why: string) =>
  new WriteGateError(`GitLab write identity is not this project's access-token bot (${why}) — refusing to write (node #123)`);
 const projectId = /^project_(\d+)_bot_[a-f0-9]+$/.exec(String(user?.username))?.[1];
 if (projectId === undefined) throw refuse("username is not a project bot's");
 if (user?.bot !== true) throw refuse("GitLab does not report the user as a bot");
 const ref = parseForgeRef(repo);
 const project = await gitlabGet(token, repo, `/projects/${encodeURIComponent(ref.path)}`, runner, { env });
 if (typeof project?.id !== "number" || String(project.id) !== projectId) {
  throw refuse(`the bot belongs to project ${projectId}, not ${ref.path}`);
 }
}

/** One read-only GET under the write credential's isolated config; parsed JSON or a refusal. */
async function gitlabGet(
 token: string,
 repo: string,
 endpoint: string,
 runner: typeof runCmd,
 opts: RunOptions,
): Promise<Record<string, unknown> | null> {
 const ref = parseForgeRef(repo);
 const gated = writeEnvForRepo(repo, token, opts.env);
 try {
  const result = await runner("glab", ["api", endpoint, "--hostname", ref.host, "--method", "GET"], {
   ...opts, timeoutMs: opts.timeoutMs ?? 60_000, env: gated.env,
  });
  if (result.code !== 0) throw new WriteGateError(`cannot verify the GitLab write identity (GET ${endpoint}, exit ${result.code})`, true);
  const body: unknown = JSON.parse(result.stdout);
  return typeof body === "object" && body !== null ? body as Record<string, unknown> : null;
 } catch (error) {
  if (error instanceof WriteGateError) throw error;
  throw new WriteGateError(`cannot verify the GitLab write identity (GET ${endpoint} failed)`, true);
 } finally {
  gated.cleanup();
 }
}

/**
 * The design §2 mechanical invariant: no autonomous graph-mutation under the
 * principal's credentials. The resolved identity is compared to the principal's
 * login and the tick is refused. Read-only components are exempt (node #8).
 */
export function assertNotPrincipal(
 config: RangerConfig,
 identity: string,
 repo: string,
): void {
 const principal = writePrincipal(config, repo);
 if (identity.trim().length === 0) throw new WriteGateError("empty write identity — refusing to write");
 if (identity.toLowerCase() === principal.toLowerCase()) {
  throw new WriteGateError(
   `refusing a graph-mutating tick under the principal's identity '${identity}' — ` +
    `autonomous graph-mutation never runs under the principal's credentials (design §2, node #11). ` +
    `The tick must run under the machine account (auth.writeTokens / bot.identity).`,
  );
 }
}

function writePrincipal(config: RangerConfig, repo: string): string {
 const principal = principalLoginForRepo(config, repo);
 if (!isCleanIdentifier(principal)) {
  const ref = parseForgeRef(repo);
  throw new WriteGateError(`no principal login configured for ${ref.forge}:${ref.host} — refusing to write`);
 }
 return principal;
}

function isCleanIdentifier(value: unknown): value is string {
 return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

/** Resolve and verify before a tick enters any graph or forge mutation lane. */
export async function assertWriteIdentity(
 config: RangerConfig,
 repo: string,
 env: NodeJS.ProcessEnv = process.env,
 runner: typeof runCmd = runCmd,
): Promise<{ token: string; botIdentity: string }> {
 // Missing host policy refuses even before attempting an identity read.
 writePrincipal(config, repo);
 const credential = resolveWriteToken(config, repo, env);
 const botIdentity = await resolveBotIdentity(config, credential.token, repo, runner, env);
 return { token: credential.token, botIdentity };
}

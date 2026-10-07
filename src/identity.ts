import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerAuthConfig, RangerConfig } from "./config.ts";
import { principalLoginForRepo } from "./config.ts";
import { runCmd, type RunOptions } from "./exec.ts";
import { parseForgeRef, qualifiedRepo } from "./forge-ref.ts";
import { glabConfigEnv } from "./glab-config-dir.ts";

const GITHUB_REPO = "github:github.com/ranger/identity";

/**
 * The write-credential gate (design §2 identity model, node #11).
 *
 * Graph-mutating ranger components (the walker's claim/close/decisions) run
 * under the machine account's write PAT — never the principal's credential —
 * and refuse to run when the resolved identity equals the principal's login.
 * GitHub pins `GH_TOKEN` and isolates `GH_CONFIG_DIR`. GitLab writes a single
 * host's credential into a per-call `GLAB_CONFIG_DIR`, shared with the read
 * gate's config helper. Neither CLI consults the principal's configuration.
 * Unlike the read-only gate, it does NOT set `SOMA_GRAPH_READONLY`: this path
 * is permitted to mutate the graph.
 */

export class WriteGateError extends Error {
 override readonly name = "WriteGateError";
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
 const token = env[tokenEnv];
 if (token === undefined || token.trim().length === 0) {
  throw new WriteGateError(
   `write-token env ${tokenEnv} is unset — refusing to run without the machine account's credential (node #11). ` +
    `Set ${tokenEnv} to the machine account's write credential.`,
  );
 }
 return { token, source: tokenEnv };
}

/** Longest-prefix match over `auth.writeTokens`, else the default. */
export function matchWriteTokenEnv(
 auth: RangerAuthConfig,
 repo: string,
): string | undefined {
 const ref = parseForgeRef(repo);
 const prefixes = Object.keys(auth.writeTokens).sort(
  (a, b) => b.length - a.length,
 );
 for (const prefix of prefixes) {
  const qualified = prefix.includes(":");
  if (!qualified && ref.forge !== "github") continue;
  const target = qualified ? qualifiedRepo(ref) : ref.path;
  if (prefix === "*" || target.startsWith(prefix.replace(/\*$/, ""))) {
   return auth.writeTokens[prefix];
  }
 }
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
 delete gated.env.SOMA_GRAPH_READONLY;
 return gated;
}

/** GitLab MR/API writes use the same isolated credential boundary as graph writes. */
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
  return await runner("glab", ["api", ...args, "--hostname", ref.host], {
   ...opts, timeoutMs: opts.timeoutMs ?? 60_000, env: gated.env,
  });
 } finally { gated.cleanup(); }
}

/** Resolve GET /user's login (GitHub) or username (GitLab) under the pinned token. */
export async function loginForToken(
 token: string,
 opts: RunOptions = {},
 repo: string = GITHUB_REPO,
 runner: typeof runCmd = runCmd,
): Promise<string> {
 const ref = parseForgeRef(repo);
 const gated = writeEnvForRepo(repo, token, opts.env);
 try {
  const result = await runner(ref.forge === "github" ? "gh" : "glab",
   ref.forge === "github" ? ["api", "/user", "--jq", ".login"]
    : ["api", "/user", "--hostname", ref.host, "--method", "GET"], {
   ...opts,
   timeoutMs: opts.timeoutMs ?? 60_000,
   env: gated.env,
  });
  if (result.code !== 0) {
   throw new WriteGateError(
    `cannot resolve the identity behind the write token (${ref.forge} api user, exit ${result.code})`,
   );
  }
  let login: unknown = result.stdout.trim();
  if (ref.forge === "gitlab") {
   try { login = JSON.parse(result.stdout).username; }
   catch { throw new WriteGateError("cannot resolve GitLab write identity: invalid /user response"); }
  }
  if (typeof login !== "string" || login.trim().length === 0 || login !== login.trim()) {
   throw new WriteGateError("cannot resolve write identity: missing login in /user response");
  }
  return login;
 } catch (error) {
  if (error instanceof WriteGateError) throw error;
  throw new WriteGateError(`cannot resolve the identity behind the write token (${ref.forge} api user failed)`);
 } finally {
  gated.cleanup();
 }
}

/**
 * The bot identity ranger labels graph operations with: `bot.identity` if
 * configured, else the login resolved from the write token. Never a static
 * guess — the label must match the credential actually driving the write, so
 * the token's real login is always resolved and a configured `bot.identity`
 * that does not match it is refused (a mismatched label would let mutations
 * run under a credential they claim not to be, e.g. the principal's PAT
 * labeled as the machine account).
 */
export async function resolveBotIdentity(
 config: RangerConfig,
 token: string,
 repo: string = GITHUB_REPO,
 runner: typeof runCmd = runCmd,
 env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
 const resolved = await loginForToken(token, { env }, repo, runner);
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
 if (parseForgeRef(repo).forge === "gitlab" && !/^project_\d+_bot_[a-f0-9]+$/.test(resolved)) {
  throw new WriteGateError("GitLab write identity is not a project access-token bot — refusing to write (node #123)");
 }
 return resolved;
}

/**
 * The design §2 mechanical invariant: no autonomous graph-mutation under the
 * principal's credentials. The resolved identity is compared to the principal's
 * login and the tick is refused. Read-only components are exempt (node #8).
 */
export function assertNotPrincipal(
 config: RangerConfig,
 identity: string,
 repo: string = GITHUB_REPO,
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
 if (principal === undefined || principal.trim().length === 0 || principal !== principal.trim()) {
  const ref = parseForgeRef(repo);
  throw new WriteGateError(`no principal login configured for ${ref.forge}:${ref.host} — refusing to write`);
 }
 return principal;
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

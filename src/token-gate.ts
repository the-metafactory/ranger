import { createHash } from "node:crypto";
import { OperationFailure } from "./operation-outcome.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerAuthConfig, RangerConfig } from "./config.ts";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import { parseForgeRef, qualifiedRepo, repoIdentity, type ForgeRef } from "./forge-ref.ts";
import { meteredGh } from "./github-usage.ts";
import { glabConfigEnvAsync } from "./glab-config-dir.ts";
import { parseGlabResponse } from "./glab-transport.ts";
import { isTransientGitHubError } from "./transient.ts";

/**
 * The read-only credential gate (node #8 ruling).
 *
 * Scout runs under an explicit read-only credential and refuses to run
 * without one. Three mechanical guarantees:
 *
 * 1. **No keyring fallback.** Every graph/gh subprocess is spawned with
 *    `GH_TOKEN` set to the resolved read-only token, and `GH_CONFIG_DIR` pointed
 *    at an isolated empty temp dir — gh never touches the (write-capable)
 *    keyring credential. If no explicit token resolves for a map, scout aborts
 *    for that map.
 * 2. **Abort on write scopes.** A classic token is introspected via
 *    `X-OAuth-Scopes`; if it carries any scope that is not read-only
 *    (`read:*`), scout refuses to run. Fine-grained PATs (no scopes header)
 *    are read-only by construction — the principal provisions them that way.
 * 3. **Per-repo read check.** The token must be able to read the map's repo
 *    (`GET /repos/{owner}/{repo}`); a 403/404 aborts that map.
 */

export interface ResolvedToken {
  token: string;
  /** Where the token came from — the env var name, for error/digest messages. */
  source: string;
}

export type TokenIntrospection = {
  forge: "github";
  /** Classic PAT scopes (`X-OAuth-Scopes`), empty for fine-grained / no-scope tokens. */
  scopes: string[];
  tokenType: "classic" | "fine-grained";
  login: string;
} | { forge: "gitlab"; scopes: string[]; tokenType: "gitlab_pat" };

export class GateError extends OperationFailure {
  override readonly name = "GateError";
  /**
   * True when the gate could not be evaluated (no response, a timeout, a 429 or
   * a 5xx from the forge), as opposed to a definitive refusal (no mapping, an
   * unset env, write scopes, no project access). A queued resume defers on a
   * transient gate without counting a failed start, as with `WriteGateError`.
   */
  constructor(message: string, readonly transient = false) {
    super({ kind: transient ? "infrastructure" : "human", operation: "token-gate", evidence: message, action: "restore authorized forge access and retry" });
  }
}

/** Scopes a classic PAT may carry while still being read-only. Everything else is write-capable. */
const READ_ONLY_SCOPE = /^read:/;

/**
 * Resolve the read-only token for a repo from config + environment.
 * Qualified prefixes match forge and host; bare prefixes match GitHub only.
 */
export function resolveReadOnlyToken(
  config: RangerConfig,
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedToken {
  const tokenEnv = matchTokenEnv(config.auth, repo);
  if (tokenEnv === undefined) {
    throw new GateError(
      `no read-only token mapping for ${repo} — add an entry to auth.readOnlyTokens (or auth.defaultTokenEnv) in ${"ranger.yaml"}`,
    );
  }
  const token = env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new GateError(
      `read-only token env ${tokenEnv} is unset — refusing to fall back to the ${parseForgeRef(repo).forge === "gitlab" ? "glab" : "gh"} keyring (which is write-capable). ` +
        `Set ${tokenEnv} to the ${repo} read-only PAT.`,
    );
  }
  return { token, source: tokenEnv };
}

/** Longest-prefix match: `the-metafactory/*` beats `*`, `jcfischer/seekolous` beats `jcfischer/*`. */
export function matchTokenEnv(
  auth: RangerAuthConfig,
  repo: string,
): string | undefined {
  const ref = parseForgeRef(repo);
  const prefixes = Object.keys(auth.readOnlyTokens).sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of prefixes) {
    const qualified = prefix.includes(":");
    if (!qualified && ref.forge !== "github") continue;
    const target = qualified ? qualifiedRepo(ref) : ref.path;
    if (prefix === "*" || target.startsWith(prefix.replace(/\*$/, ""))) {
      return auth.readOnlyTokens[prefix];
    }
  }
  return ref.forge === "github" ? auth.defaultTokenEnv : undefined;
}

/**
 * Isolated environment for gh/soma subprocesses: `GH_TOKEN` pinned to the
 * read-only token, `GH_CONFIG_DIR` pointed at a throwaway empty dir so gh
 * never consults — or writes to — the real config/hosts/keyring. The caller's
 * environment is preserved (PATH, etc.); only the token/config vars are
 * overridden.
 */
export function gatedEnv(
  token: string,
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ranger-gh-"));
  return {
    env: {
      ...base,
      ...extra,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GH_CONFIG_DIR: dir,
      SOMA_GRAPH_READONLY: "1",
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

export const TOKEN_GATE_CACHE_MS = 15 * 60_000;

type GitHubIntrospection = Extract<TokenIntrospection, { forge: "github" }>;

interface CachedToken {
  info?: { value: GitHubIntrospection; until: number };
  repos: Map<string, number>;
  blockedUntil: number;
  pending?: Promise<GitHubIntrospection>;
}

/** Process-local successful checks; a restart requires fresh authorization. */
export class ReadOnlyTokenCache {
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly now: () => number = Date.now) {}

  async check(resolved: ResolvedToken, repo: string, runner: typeof runCmd): Promise<GitHubIntrospection> {
    const now = this.now();
    for (const [key, cached] of this.tokens) {
      for (const [path, until] of cached.repos) {
        if (until <= now) cached.repos.delete(path);
      }
      if (cached.pending === undefined && cached.blockedUntil <= now && (cached.info?.until ?? 0) <= now && cached.repos.size === 0) {
        this.tokens.delete(key);
      }
    }
    const key = createHash("sha256").update(resolved.token).digest("hex");
    let cached = this.tokens.get(key);
    if (cached === undefined) {
      cached = { repos: new Map(), blockedUntil: 0 };
      this.tokens.set(key, cached);
    }
    const state = cached;
    const run = () => this.validate(resolved, repo, state, runner);
    const pending = state.pending === undefined ? run() : state.pending.then(run, run);
    state.pending = pending;
    try {
      return structuredClone(await pending);
    } finally {
      if (state.pending === pending) state.pending = undefined;
    }
  }

  private assertAvailable(resolved: ResolvedToken, state: CachedToken): void {
    if (state.blockedUntil > this.now()) {
      throw new GateError(`${resolved.source}: token gate deferred until ${new Date(state.blockedUntil).toISOString()} (GitHub core allowance spent)`, true);
    }
  }

  private async request(resolved: ResolvedToken, endpoint: string, state: CachedToken, runner: typeof runCmd): Promise<RunResult> {
    this.assertAvailable(resolved, state);
    const gated = gatedEnv(resolved.token);
    try {
      const result = await meteredGh({ component: "token-gate", source: resolved.source }, runner)(
        "gh", ["api", endpoint, "-i"], { env: gated.env },
      );
      const { remaining, reset, resource } = parseGhHeaders(result.stdout);
      if (remaining === 0 && (resource === undefined || resource === "core") && reset !== undefined && reset * 1000 > this.now()) {
        state.blockedUntil = reset * 1000;
      }
      if (result.code !== 0) {
        this.assertAvailable(resolved, state);
        const said = result.stderr.trim() || result.stdout.trim();
        throw new GateError(`${resolved.source}: token gate failed (gh api ${endpoint}, exit ${result.code}): ${said}`, isTransientGitHubError(said));
      }
      return result;
    } finally {
      gated.cleanup();
    }
  }

  private async validate(resolved: ResolvedToken, repo: string, state: CachedToken, runner: typeof runCmd): Promise<GitHubIntrospection> {
    this.assertAvailable(resolved, state);
    try {
      let info = state.info;
      if (info === undefined || info.until <= this.now()) {
        const checkedAt = this.now();
        const result = await this.request(resolved, "/user", state, runner);
        const { scopes, login } = parseGhHeaders(result.stdout);
        const writeScopes = scopes.filter(scope => !READ_ONLY_SCOPE.test(scope));
        if (writeScopes.length > 0) {
          throw new GateError(`refusing to run scout with a write-capable token: ${resolved.source} carries scope(s) ${writeScopes.join(", ")}. Scout runs read-only — provision a fine-grained PAT with only read permissions (node #8).`);
        }
        info = { value: { forge: "github", scopes, tokenType: scopes.length > 0 ? "classic" : "fine-grained", login }, until: checkedAt + TOKEN_GATE_CACHE_MS };
      }
      if ((state.repos.get(repo) ?? 0) <= this.now()) {
        const checkedAt = this.now();
        await this.request(resolved, `repos/${repo}`, state, runner);
        state.repos.set(repo, checkedAt + TOKEN_GATE_CACHE_MS);
      }
      state.info = info;
      return info.value;
    } catch (error) {
      state.info = undefined;
      state.repos.clear();
      throw error;
    }
  }
}

const readOnlyTokenCache = new ReadOnlyTokenCache();

/** Resolve explicit credentials and validate scopes and repo access, with bounded GitHub reuse. */
export async function assertReadOnlyToken(
  config: RangerConfig,
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: typeof runCmd = runCmd,
  cache: ReadOnlyTokenCache = readOnlyTokenCache,
): Promise<{ token: ResolvedToken; info: TokenIntrospection }> {
  const resolved = resolveReadOnlyToken(config, repo, env);
  const ref = parseForgeRef(repo);
  if (ref.forge === "gitlab") return assertGitLabReadOnlyToken(repo, resolved, env, runner);
  const info = await cache.check(resolved, ref.path.toLowerCase(), runner);
  return { token: resolved, info };
}

// Only the gate can authorize a GitLab token object. A copied/unvalidated token
// or a token handed to another host/project cannot enter the read boundary.
const gitlabReadGrants = new WeakMap<ResolvedToken, string>();
const GITLAB_READ_SCOPES = new Set(["read_api", "read_repository"]);

export function assertGitLabReadGrant(repo: string, token: ResolvedToken): void {
  if (gitlabReadGrants.get(token) !== repoIdentity(parseForgeRef(repo))) {
    throw new GateError(`${token.source}: GitLab read credential has not passed the scope and project gate for ${repo}`);
  }
}

/** Internal bootstrap GET; never invoked without the private config env. */
async function isolatedGitLabGet(
  ref: ForgeRef,
  token: ResolvedToken,
  endpoint: string,
  runner: typeof runCmd,
  opts: RunOptions = {},
): Promise<RunResult> {
  if (ref.forge !== "gitlab" || !/^\/?[a-zA-Z0-9_]/.test(endpoint) || endpoint.includes(":") || endpoint.includes("#")) {
    throw new GateError(`${token.source}: invalid GitLab read endpoint`);
  }
  const gated = await glabConfigEnvAsync(ref.host, token.token, opts.env);
  try {
    return await runner("glab", ["api", endpoint, "--hostname", ref.host, "--method", "GET", "--include"], {
      ...opts, timeoutMs: opts.timeoutMs ?? 15_000, env: gated.env,
    });
  } finally {
    await gated.cleanup();
  }
}

function expectGlabOk(result: RunResult, message: string): unknown {
  const { status, body } = parseGlabResponse(result);
  if (result.code !== 0 || status !== 200) {
    const unreachable = status === 0 || status === 429 || status >= 500;
    throw new GateError(`${message} (HTTP ${status || "unknown"}, exit ${result.code})`, unreachable);
  }
  return body;
}

async function assertGitLabReadOnlyToken(
  repo: string,
  token: ResolvedToken,
  env: NodeJS.ProcessEnv,
  runner: typeof runCmd,
): Promise<{ token: ResolvedToken; info: TokenIntrospection }> {
  const ref = parseForgeRef(repo);
  try {
    const self = await isolatedGitLabGet(ref, token, "/personal_access_tokens/self", runner, { env });
    const body = expectGlabOk(self, `${token.source}: GitLab PAT introspection refused`);
    const scopes = body !== null && typeof body === "object" ? (body as Record<string, unknown>).scopes : undefined;
    if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== "string" || !GITLAB_READ_SCOPES.has(scope))) {
      throw new GateError(`${token.source}: GitLab PAT scopes must be present and limited to read_api/read_repository`);
    }
    const project = await isolatedGitLabGet(ref, token, `/projects/${encodeURIComponent(ref.path)}`, runner, { env });
    expectGlabOk(project, `${token.source}: token cannot read ${repo}`);
    Object.freeze(token);
    gitlabReadGrants.set(token, repoIdentity(ref));
    return { token, info: { forge: "gitlab", scopes, tokenType: "gitlab_pat" } };
  } catch (error) {
    if (error instanceof GateError) throw error;
    // Do not echo subprocess output: errors may include credential material.
    throw new GateError(`${token.source}: GitLab read gate failed before map reads`, true);
  }
}

/** Ranger's own API reads use the same checked token and per-call confinement. */
export async function gitlabApiRead(
  repo: string,
  token: ResolvedToken,
  endpoint: string,
  runner: typeof runCmd = runCmd,
  opts: RunOptions = {},
): Promise<RunResult> {
  assertGitLabReadGrant(repo, token);
  return isolatedGitLabGet(parseForgeRef(repo), token, endpoint, runner, opts);
}

/** Parse `gh api -i` output: the header block (up to the first blank line) → scope list + login. */
export function parseGhHeaders(output: string): {
  scopes: string[];
  login: string;
  remaining?: number;
  reset?: number;
  resource?: string;
} {
  const [head] = output.split(/\r?\n\r?\n/);
  if (!head) return { scopes: [], login: "" };
  const headers = new Map(head.split(/\r?\n/).flatMap(line => {
    const colon = line.indexOf(":");
    return colon > 0 ? [[line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as const] : [];
  }));
  const scopes = (headers.get("x-oauth-scopes") ?? "").split(",").map(scope => scope.trim()).filter(Boolean);
  const number = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  return { scopes, login: extractLogin(output), remaining: number("x-ratelimit-remaining"), reset: number("x-ratelimit-reset"), resource: headers.get("x-ratelimit-resource") };
}

function extractLogin(output: string): string {
  try {
    const body = output
      .split(/\r?\n\r?\n/)
      .slice(1)
      .join("\n");
    const parsed = JSON.parse(body.trim());
    return typeof parsed.login === "string" ? parsed.login : "";
  } catch {
    return "";
  }
}

/** A repo's read-only token, gated once per batch of reads. */
export type TokenBatch = (repo: string) => Promise<ResolvedToken>;

/**
 * Run the gate once per repo and hand the validated token to every read in
 * one batch; a refusal is shared the same way. Make a new batch per refresh
 * or live read, never a long-lived one: GitHub successes expire after
 * TOKEN_GATE_CACHE_MS and refusals must be retried by the next batch.
 */
export function tokenBatch(
  config: RangerConfig,
  gate: (config: RangerConfig, repo: string) => Promise<{ token: ResolvedToken }> = assertReadOnlyToken,
): TokenBatch {
  const gated = new Map<string, Promise<ResolvedToken>>();
  return (repo) => {
    let token = gated.get(repo);
    if (token === undefined) {
      token = gate(config, repo).then((r) => r.token);
      gated.set(repo, token);
    }
    return token;
  };
}

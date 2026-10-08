import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerAuthConfig, RangerConfig } from "./config.ts";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import { parseForgeRef, qualifiedRepo, repoIdentity, type ForgeRef } from "./forge-ref.ts";
import { glabConfigEnvAsync } from "./glab-config-dir.ts";

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

export class GateError extends Error {
  override readonly name = "GateError";
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

/**
 * Introspect the token via `gh api /user -i` and classify it.
 * Throws GateError on any failure to reach GitHub or unparseable output.
 */
async function introspectToken(
  token: string,
  runOpts: RunOptions = {},
): Promise<TokenIntrospection> {
  const gated = gatedEnv(token);
  try {
    const result = await runCmd("gh", ["api", "/user", "-i"], {
      ...runOpts,
      env: gated.env,
    });
    if (result.code !== 0) {
      throw new GateError(
        `token introspection failed (gh api /user, exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const { scopes } = parseGhHeaders(result.stdout);
    const login = extractLogin(result.stdout);
    return {
      forge: "github",
      scopes,
      tokenType: scopes.length > 0 ? "classic" : "fine-grained",
      login,
    };
  } finally {
    gated.cleanup();
  }
}

/**
 * The full gate: resolve → introspect → abort-on-write-scopes → per-repo read.
 * GitLab introspects PAT scopes and proves project access under per-call
 * GLAB_CONFIG_DIR; its returned token object is authorized for that project.
 * Returns the resolved token plus introspection. Throws GateError.
 */
export async function assertReadOnlyToken(
  config: RangerConfig,
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: typeof runCmd = runCmd,
): Promise<{ token: ResolvedToken; info: TokenIntrospection }> {
  const resolved = resolveReadOnlyToken(config, repo, env);
  if (parseForgeRef(repo).forge === "gitlab") return assertGitLabReadOnlyToken(repo, resolved, env, runner);
  const info = await introspectToken(resolved.token);

  const writeScopes = info.scopes.filter(
    (scope) => !READ_ONLY_SCOPE.test(scope),
  );
  if (writeScopes.length > 0) {
    throw new GateError(
      `refusing to run scout with a write-capable token: ${resolved.source} carries scope(s) ${writeScopes.join(", ")}. ` +
        `Scout runs read-only — provision a fine-grained PAT with only read permissions (node #8).`,
    );
  }

  await assertRepoReadable(resolved.token, repo);
  return { token: resolved, info };
}

/** `GET /repos/{owner}/{repo}` must succeed with this token — proves it can read the map's repo. */
async function assertRepoReadable(token: string, repo: string): Promise<void> {
  const gated = gatedEnv(token);
  try {
    const result = await runCmd(
      "gh",
      ["api", `repos/${repo}`, "--jq", ".full_name"],
      { env: gated.env },
    );
    if (result.code !== 0) {
      throw new GateError(
        `token cannot read ${repo} (gh api repos/${repo}, exit ${result.code}): ${result.stderr.trim() || "access denied"}`,
      );
    }
  } finally {
    gated.cleanup();
  }
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

/** glab --include prints the HTTP status, headers, then a JSON body. */
export function parseGlabResponse(result: RunResult): { status: number; body: unknown; headers: Record<string, string> } {
  const match = /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n/.exec(result.stdout);
  const status = match === null ? 0 : Number(match[1]);
  const boundary = result.stdout.search(/\r?\n\r?\n/);
  const headers: Record<string, string> = Object.create(null);
  let body: unknown;
  if (boundary >= 0) {
    for (const line of result.stdout.slice(0, boundary).split(/\r?\n/).slice(1)) {
      const separator = line.indexOf(":");
      if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    try { body = JSON.parse(result.stdout.slice(boundary).trim()); } catch { /* caller fails closed */ }
  }
  return { status, body, headers };
}

function expectGlabOk(result: RunResult, message: string): unknown {
  const { status, body } = parseGlabResponse(result);
  if (result.code !== 0 || status !== 200) {
    throw new GateError(`${message} (HTTP ${status || "unknown"}, exit ${result.code})`);
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
    throw new GateError(`${token.source}: GitLab read gate failed before map reads`);
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
} {
  const [head] = output.split(/\r?\n\r?\n/);
  if (!head) return { scopes: [], login: "" };
  let scopes: string[] = [];
  for (const line of head.split(/\r?\n/)) {
    const lower = line.toLowerCase();
    if (lower.startsWith("x-oauth-scopes:")) {
      const value = line.slice(line.indexOf(":") + 1).trim();
      scopes =
        value.length > 0
          ? value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
    }
  }
  return { scopes, login: extractLogin(output) };
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
 * or live read, never a long-lived one: the gate must see a token revoked
 * or re-scoped since.
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

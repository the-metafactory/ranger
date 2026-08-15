import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerAuthConfig, RangerConfig } from "./config.ts";
import { runCmd, type RunOptions } from "./exec.ts";

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

export interface TokenIntrospection {
  /** Classic PAT scopes (`X-OAuth-Scopes`), empty for fine-grained / no-scope tokens. */
  scopes: string[];
  tokenType: "classic" | "fine-grained";
  login: string;
}

export class GateError extends Error {
  override readonly name = "GateError";
}

/** Scopes a classic PAT may carry while still being read-only. Everything else is write-capable. */
const READ_ONLY_SCOPE = /^read:/;

/**
 * Resolve the read-only token for a repo from config + environment.
 * Prefixes match longest-first against `map.repo`.
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
      `read-only token env ${tokenEnv} is unset — refusing to fall back to the gh keyring (which is write-capable). ` +
        `Set ${tokenEnv} to the ${repo} read-only fine-grained PAT.`,
    );
  }
  return { token, source: tokenEnv };
}

/** Longest-prefix match: `the-metafactory/*` beats `*`, `jcfischer/seekolous` beats `jcfischer/*`. */
export function matchTokenEnv(
  auth: RangerAuthConfig,
  repo: string,
): string | undefined {
  const prefixes = Object.keys(auth.readOnlyTokens).sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of prefixes) {
    if (prefix === "*" || repo.startsWith(prefix.replace(/\*$/, ""))) {
      return auth.readOnlyTokens[prefix];
    }
  }
  return auth.defaultTokenEnv;
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
 * Returns the resolved token plus introspection. Throws GateError.
 */
export async function assertReadOnlyToken(
  config: RangerConfig,
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: ResolvedToken; info: TokenIntrospection }> {
  const resolved = resolveReadOnlyToken(config, repo, env);
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

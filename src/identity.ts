import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerAuthConfig, RangerConfig } from "./config.ts";
import { runCmd, type RunOptions } from "./exec.ts";

/**
 * The write-credential gate (design §2 identity model, node #11).
 *
 * Graph-mutating ranger components (the walker's claim/close/decisions) run
 * under the machine account's write PAT — never the principal's credential —
 * and refuse to run when the resolved identity equals the principal's login.
 * The write env pins `GH_TOKEN` to the machine-account token and isolates
 * `GH_CONFIG_DIR` so gh never consults — or writes to — the real keyring.
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
 if (token === undefined || token.length === 0) {
  throw new WriteGateError(
   `write-token env ${tokenEnv} is unset — refusing to run without the machine account's credential (node #11). ` +
    `Set ${tokenEnv} to the machine account's classic repo-scoped PAT.`,
  );
 }
 return { token, source: tokenEnv };
}

/** Longest-prefix match over `auth.writeTokens`, else the default. */
export function matchWriteTokenEnv(
 auth: RangerAuthConfig,
 repo: string,
): string | undefined {
 const prefixes = Object.keys(auth.writeTokens).sort(
  (a, b) => b.length - a.length,
 );
 for (const prefix of prefixes) {
  if (prefix === "*" || repo.startsWith(prefix.replace(/\*$/, ""))) {
   return auth.writeTokens[prefix];
  }
 }
 return auth.defaultWriteTokenEnv;
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
 return {
  env: {
   ...base,
   ...extra,
   GH_TOKEN: token,
   GITHUB_TOKEN: token,
   GH_CONFIG_DIR: dir,
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

/** Resolve the login behind a token via `gh api /user --jq .login`. */
export async function loginForToken(
 token: string,
 opts: RunOptions = {},
): Promise<string> {
 const gated = writeEnv(token);
 try {
  const result = await runCmd("gh", ["api", "/user", "--jq", ".login"], {
   ...opts,
   env: gated.env,
  });
  if (result.code !== 0) {
   throw new WriteGateError(
    `cannot resolve the identity behind the write token (gh api user, exit ${result.code}): ${result.stderr.trim()}`,
   );
  }
  return result.stdout.trim();
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
): Promise<string> {
 const resolved = await loginForToken(token);
 if (config.bot.identity !== undefined && config.bot.identity.length > 0) {
  if (resolved !== config.bot.identity) {
   throw new WriteGateError(
    `configured bot.identity '${config.bot.identity}' does not match the ` +
     `write token's login '${resolved}' — the mutation would run under a ` +
     `credential it claims not to be (design §2, node #11). ` +
     `Fix bot.identity or the write-token mapping.`,
   );
  }
  return config.bot.identity;
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
): void {
 if (identity === config.principal.login) {
  throw new WriteGateError(
   `refusing a graph-mutating tick under the principal's identity '${identity}' — ` +
    `autonomous graph-mutation never runs under the principal's credentials (design §2, node #11). ` +
    `The tick must run under the machine account (auth.writeTokens / bot.identity).`,
  );
 }
}

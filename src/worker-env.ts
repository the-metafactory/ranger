import { principalLoginForRepo } from "./config.ts";
import { somaRepo } from "./graph.ts";
import type { RangerConfig } from "./config.ts";
import { JOURNAL_PATH_ENV } from "./journal-guard.ts";
import { MACHINE_FORGE_KEYS } from "./forge-env.ts";
import { workerEnvPasses } from "./untrusted-env.ts";

/**
 * The environments for code ranger runs but does not trust: the headless
 * worker session, and (implement lane, #23) the install/test commands and the
 * sage review that execute or read worker-written code.
 */

/** The minimal host env a headless worker needs to run claude/git/soma:
 *  PATH/HOME/locale, git-identity + config passthrough, and LLM-credential +
 *  soma/pi variables. Deliberately EXCLUDES the RANGER_* secrets (the Discord
 *  bot token, write tokens, keychain vars) and anything unknown: a graph-
 *  authored prompt injection in the worker must not be able to read the bot
 *  token (round-32 security blocker). Git auth (GIT_CONFIG_VALUE_0) is
 *  injected by gitAuthEnv AFTER this spread, so it overrides any passthrough.
 */
export function workerHostEnv(
 source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = {};
 for (const [key, value] of Object.entries(source)) {
  if (value === undefined) continue;
  if (workerEnvPasses(key)) env[key] = value;
 }
 // A forge token in the host env must never reach untrusted code, whatever
 // prefix rule it slipped through. The fixed forge keys are stripped here;
 // config-named credentials (auth.*Tokens) that would pass the allowlist are
 // refused when the config loads (credentialEnvName in config.ts).
 for (const key of MACHINE_FORGE_KEYS) delete env[key];
 return env;
}

/** Worker env: repo context + an ALLOW-LISTED host env — and CRUCIALLY NO
 *  write PAT (round-38 security blocker): the worker COMMITS locally but the
 *  SUPERVISOR performs the vetted push, so a malicious node can never have
 *  the worker read/decode a machine credential from its env.
 *  `sessionJournal` (node #66) becomes RANGER_JOURNAL_PATH: any ranger code
 *  the session runs (its own CLI, its tests) opens that per-session temp
 *  journal, never the live one. */
export function workerEnv(
 config: RangerConfig,
 repo: string,
 sessionJournal: string,
): NodeJS.ProcessEnv {
 const identity = config.bot.identity;
 const principal = principalLoginForRepo(config, repo);
 return {
  ...workerHostEnv(),
  SOMA_GRAPH_REPO: somaRepo(repo),
  SAGE_STACK: "default",
  ...(principal === undefined ? {} : { PILOT_PRINCIPAL: principal }),
  [JOURNAL_PATH_ENV]: sessionJournal,
  // The host's global git hooks are the principal's, not the walk's: they
  // can leave build caches in the worktree (a dirty tree the implement lane
  // refuses) and nothing about them is part of ranger's gate. Disabled for
  // every git call in the worker session and the repo commands (#23).
  GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/dev/null'",
  // The machine account authors the work (design §2), not whoever the host's
  // global git identity is.
  ...(identity === undefined
   ? {}
   : {
      GIT_AUTHOR_NAME: identity,
      GIT_AUTHOR_EMAIL: `${identity}@users.noreply.github.com`,
      GIT_COMMITTER_NAME: identity,
      GIT_COMMITTER_EMAIL: `${identity}@users.noreply.github.com`,
     }),
 };
}

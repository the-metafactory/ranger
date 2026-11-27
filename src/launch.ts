/**
 * What `ranger serve` hands a child process (#37, node #54): the environment
 * allowlist and the Rex launch, shared by the grilling button and the
 * "Needs you" actions.
 */

/** Environment keys a launched session may inherit — an allowlist, never a denylist. */
import { SUBSTRATE_NAMES, type SubstrateName } from "./store/schema.ts";

const CHILD_ENV_KEYS = [
 "PATH",
 "HOME",
 "USER",
 "LOGNAME",
 "SHELL",
 "LANG",
 "LC_ALL",
 "LC_CTYPE",
 "TMPDIR",
] as const;

export function childEnv(
 env: Record<string, string | undefined>,
): Record<string, string> {
 const out: Record<string, string> = {};
 for (const key of CHILD_ENV_KEYS) {
  const value = env[key];
  if (value !== undefined) out[key] = value;
 }
 return out;
}

/** POSIX single-quote a string for a shell. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export function sessionSubstrate(value: unknown): SubstrateName | null {
 return value === undefined ? "claude" : SUBSTRATE_NAMES.find((name) => name === value) ?? null;
}

export function sessionCommand(prompt: string, substrate: SubstrateName = "claude"): string {
 if (sessionSubstrate(substrate) === null) throw new Error("invalid session substrate");
 return `${substrate} ${shellQuote(prompt)}`;
}

/**
 * The Rex CLI inside the app bundle. An absolute path, because the PATH that
 * launchd hands `ranger serve` does not include `~/bin`.
 */
export const REX_BIN = "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex";

/** A Rex session label: lowercase words joined by hyphens. */
export function sessionLabel(repo: string, nodeId: string): string {
 const name = repo.split("/").pop() ?? repo;
 return `${name}-${nodeId}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * `rex new` argv that opens a Rex session labelled `label` and runs
 * `shellCommand` in it. Rex starts the command with the principal's login
 * and interactive shell environment (`--interactive` reads ~/.zshrc, as the
 * iTerm2 window it replaces did), not this process's. When the command exits,
 * the pane drops into a login shell instead of closing, so the session can be
 * resumed by hand.
 */
export function rexArgv(shellCommand: string, label: string): string[] {
 return [REX_BIN, "new", label, "--interactive", "--", "sh", "-c", shellCommand + '; exec "${SHELL:-/bin/zsh}" -l'];
}

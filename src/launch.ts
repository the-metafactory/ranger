/**
 * What `ranger serve` hands a child process (#37, node #54): the environment
 * allowlist and the iTerm2 launch, shared by the grilling button and the
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

/** Escape a string for an AppleScript string literal. */
const appleQuote = (s: string): string =>
 `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** `osascript` argv that opens a new iTerm2 window and types `shellCommand` into it. */
export function itermArgv(shellCommand: string): string[] {
 const script = [
  'tell application "iTerm2"',
  " set w to (create window with default profile)",
  ` tell current session of w to write text ${appleQuote(shellCommand)}`,
  " activate",
  "end tell",
 ].join("\n");
 return ["osascript", "-e", script];
}

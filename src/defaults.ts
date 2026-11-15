import { safeGit } from "./git-ops.ts";

const DEFAULT_LINE = /^\s*(?:[-*]\s*)?Default:\s*(\S.*)$/i;
const DEFAULTS_HEADING = "## Defaults taken";
const MAX_DEFAULTS = 20;
const MAX_DEFAULT_CHARS = 300;

function clipped(line: string): string {
 const trimmed = line.trim().replaceAll("`", "'");
 return trimmed.length > MAX_DEFAULT_CHARS ? `${trimmed.slice(0, MAX_DEFAULT_CHARS - 1)}…` : trimmed;
}

/** The `Default:` lines in commit messages, first seen first, each once. */
export function defaultsFromMessages(messages: string): string[] {
 const seen = new Set<string>();
 for (const line of messages.split(/\r?\n/)) {
  const m = DEFAULT_LINE.exec(line);
  if (m !== null) seen.add(clipped(m[1]));
 }
 return [...seen].slice(0, MAX_DEFAULTS);
}

/** The defaults the branch's commits since `origin/<base>` record; none when git cannot say. */
export async function branchDefaults(worktree: string, base: string): Promise<string[]> {
 const log = await safeGit(["--no-replace-objects", "log", "--format=%B", `origin/${base}..HEAD`], { cwd: worktree, timeoutMs: 30_000 });
 return log.code === 0 ? defaultsFromMessages(log.stdout) : [];
}

/** The PR body section listing the defaults, or nothing when there are none. */
export function defaultsSection(defaults: readonly string[]): string[] {
 if (defaults.length === 0) return [];
 return [
  "",
  DEFAULTS_HEADING,
  "",
  "The worker settled these open choices with the simplest reversible option. Overturn one with a comment or a revert.",
  "",
  ...defaults.map((d) => `- ${d}`),
 ];
}

/** The defaults a PR body's section lists, read back for the close receipt. */
export function defaultsFromBody(body: string | undefined): string[] {
 const lines = (body ?? "").split(/\r?\n/);
 const at = lines.findIndex((l) => l.trim() === DEFAULTS_HEADING);
 if (at === -1) return [];
 const out: string[] = [];
 for (const line of lines.slice(at + 1)) {
  if (/^#{1,6}\s/.test(line)) break;
  const m = /^\s*-\s+(\S.*)$/.exec(line);
  if (m !== null) out.push(clipped(m[1]));
 }
 return out.slice(0, MAX_DEFAULTS);
}

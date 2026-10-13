/**
 * A worker that cannot do its node says so (cortex#2557, 2026-10-13: the node
 * needed a Myelin export no release carried yet). Two ways in:
 *
 * - **The report file.** The worker writes `.ranger-blocked.md` at the
 *   worktree root, commits nothing, and exits 0. The supervisor reads it and
 *   parks the row with the reason and the resume condition; nothing is pushed
 *   and no PR is opened.
 * - **The note-only branch.** A worker that commits its blocker note instead
 *   (the #2557 worker committed `docs/node-2557-dependency-blocker.md`, sage
 *   read it clean and the PR reached the merge desk) is caught before the
 *   push: a branch whose only change is new markdown files named like a
 *   blocker note, or the report file itself, parks the same way.
 *
 * Both are worker-written text: it is read without following links, capped,
 * and folded to one line before it reaches the journal or a card.
 */

import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { safeGit } from "./git-ops.ts";

/** Where the worker writes its blocked report, relative to the worktree root. */
export const BLOCKED_REPORT_FILE = ".ranger-blocked.md";

/** Bytes of a report or note read; the rest is never read. */
const MAX_REPORT_BYTES = 16_384;
/** Characters each part keeps in the outcome. */
const MAX_PART_CHARS = 300;

export interface BlockedReport {
 reason: string;
 /** What must hold before a resume can succeed; empty when the worker named none. */
 resume: string;
}

const RESUME_LINE = /^\s*(#{1,6}\s*)?(?:\*\*)?resume[ -]condition(?:\*\*)?\s*:?(?:\*\*)?\s*(.*)$/i;
const HEADING = /^\s*#{1,6}\s/;

function fold(lines: string[]): string {
 const text = lines
  .map((l) => l.replace(/^\s*#{1,6}\s*/, "").trim())
  .filter((l) => l.length > 0)
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
 return text.length > MAX_PART_CHARS ? `${text.slice(0, MAX_PART_CHARS - 1)}…` : text;
}

/**
 * The reason and the resume condition of a report: everything before the
 * first `Resume condition:` line (or `## Resume condition` heading) is the
 * reason; the line's rest and what follows it, up to the next heading, is
 * the condition.
 */
export function parseBlockedReport(text: string): BlockedReport {
 const lines = text.split(/\r?\n/);
 const at = lines.findIndex((l) => RESUME_LINE.test(l));
 if (at === -1) return { reason: fold(lines), resume: "" };
 const m = RESUME_LINE.exec(lines[at]) as RegExpExecArray;
 const rest: string[] = [m[2]];
 for (const line of lines.slice(at + 1)) {
  if (HEADING.test(line)) break;
  rest.push(line);
 }
 return { reason: fold(lines.slice(0, at)), resume: fold(rest) };
}

/** A regular file's first bytes, or null: a link, a directory or a missing file is no report. */
function readRegularFile(path: string): string | null {
 let fd: number;
 try {
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 } catch {
  return null;
 }
 try {
  if (!fstatSync(fd).isFile()) return null;
  const buf = Buffer.alloc(MAX_REPORT_BYTES);
  const n = readSync(fd, buf, 0, MAX_REPORT_BYTES, 0);
  return buf.subarray(0, n).toString("utf8");
 } finally {
  closeSync(fd);
 }
}

/** The worker's blocked report in `worktree`, or null when it wrote none. */
export function readBlockedReport(worktree: string): BlockedReport | null {
 const text = readRegularFile(join(worktree, BLOCKED_REPORT_FILE));
 if (text === null) return null;
 const report = parseBlockedReport(text);
 return report.reason.length > 0 ? report : { ...report, reason: "the worker gave no reason" };
}

/**
 * Drop a report an earlier session left, so only this session's report
 * counts. Untracked by design: a committed one is the note-only check's.
 */
export function discardBlockedReport(worktree: string): void {
 rmSync(join(worktree, BLOCKED_REPORT_FILE), { force: true });
}

/** A file name that says it is a blocker note: `node-2557-dependency-blocker.md`, `BLOCKED.md`. */
const NOTE_NAME = /block(?:er|ed)/i;

/**
 * Whether a branch's changes against its base are only a blocker note: every
 * change adds a markdown file named like one, or it is the report file. Any
 * modified or deleted file, or any other added file, is work.
 */
export function blockerNoteOnly(changes: { status: string; path: string }[]): string[] | null {
 if (changes.length === 0) return null;
 const note = (c: { status: string; path: string }) =>
  basename(c.path) === BLOCKED_REPORT_FILE || (c.status === "A" && /\.md$/i.test(c.path) && NOTE_NAME.test(basename(c.path)));
 return changes.every(note) ? changes.map((c) => c.path) : null;
}

/**
 * The blocked report a note-only branch amounts to, or null when the branch
 * holds work. Its reason and condition come from the note itself when it has
 * a resume condition, else they name the note.
 */
export async function blockerNoteBranch(worktree: string, base: string): Promise<BlockedReport | null> {
 const diff = await safeGit(
  ["--no-replace-objects", "diff", "--name-status", "--no-renames", "-z", `origin/${base}...HEAD`],
  { cwd: worktree, timeoutMs: 30_000 },
 );
 if (diff.code !== 0) return null;
 const fields = diff.stdout.split("\0").filter((f) => f.length > 0);
 const changes: { status: string; path: string }[] = [];
 for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
 const notes = blockerNoteOnly(changes);
 if (notes === null) return null;
 const named = notes.join(", ");
 const shown = await safeGit(["--no-replace-objects", "show", `HEAD:${notes[0]}`], { cwd: worktree, timeoutMs: 10_000 });
 const parsed = shown.code === 0 ? parseBlockedReport(shown.stdout.slice(0, MAX_REPORT_BYTES)) : { reason: "", resume: "" };
 return {
  reason: `the branch only adds a blocker note (${named}), not an implementation${parsed.reason.length > 0 ? `: ${parsed.reason}` : ""}`,
  resume: parsed.resume,
 };
}

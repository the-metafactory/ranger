import { GitSafetyError, gitStateChanges, readGitState, readGitStateSettled, type GitState } from "./git-ops.ts";
import type { Journal } from "./journal.ts";

/**
 * The known-good git state (node #81). A run's tamper check compares against
 * a snapshot taken when that run starts, and the supervisor's tests run
 * worker-written code: a failed test run that set `http.sslVerify=false`
 * stopped before any further check, and the next run took the changed state
 * as its trusted starting point. So the supervisor records the state each
 * time it has seen it clean (a fresh clone, a worktree it created, a passing
 * pass, a vetted push) in the journal, and every run-node compares against
 * that record before its first credentialed git call. A mismatch parks;
 * the new state is never adopted on its own. Only the operator's `ranger
 * trust-git` adopts it.
 *
 * One record per canonical checkout, whatever map or base runs in it: a
 * record per base let a base the checkout had not run before take the
 * current state on first sight, past the record another base had left. The
 * state is read the same for every base (`configRecords`, node #63). The
 * record holds digests only, never a config value.
 */

interface KnownGood extends GitState {
 /** When the supervisor last saw this state clean, and how. */
 at: string;
 source: string;
}

export function knownGoodKey(canonical: string): string {
 return `git.known-good.${canonical}`;
}

function readKnownGood(journal: Journal, canonical: string): KnownGood | "unreadable" | null {
 const raw = journal.getHealth(knownGoodKey(canonical));
 if (raw === null) return null;
 try {
  const parsed = JSON.parse(raw) as KnownGood;
  if (typeof parsed.hash !== "string" || typeof parsed.entries !== "object" || parsed.entries === null) {
   return "unreadable";
  }
  return parsed;
 } catch {
  return "unreadable";
 }
}

/** Record `state` as known-good. Callers pass a state they verified, never a fresh read. */
export function recordKnownGood(
 journal: Journal,
 canonical: string,
 state: GitState,
 source: string,
): void {
 const record: KnownGood = { hash: state.hash, entries: state.entries, at: new Date().toISOString(), source };
 journal.setHealth(knownGoodKey(canonical), JSON.stringify(record));
}

export type TrustCheck =
 | { kind: "match"; state: GitState }
 /** No record yet (a first run, or a journal from before node #81): the state read is now the record. */
 | { kind: "first"; state: GitState }
 | { kind: "mismatch"; state: GitState; changed: string[]; since: string };

/**
 * Compare the current git state with the known-good record. With no record,
 * the current state becomes it and the journal says so: today's trust level
 * for a repo ranger has not seen before.
 */
export function checkKnownGood(
 journal: Journal,
 canonical: string,
 at: { repo: string; nodeId?: string },
): TrustCheck {
 const known = readKnownGood(journal, canonical);
 const state =
  known === null || known === "unreadable" ? readGitState(canonical) : readGitStateSettled(canonical, known.hash);
 if (known === null) {
  recordKnownGood(journal, canonical, state, "first sight");
  journal.recordEvent("git-trust", {
   ...at,
   detail: `no known-good git state recorded for ${canonical}: the current one is now the record`,
  });
  return { kind: "first", state };
 }
 if (known === "unreadable") {
  return { kind: "mismatch", state, changed: ["(the known-good record is unreadable)"], since: "unknown" };
 }
 if (known.hash === state.hash) return { kind: "match", state };
 const changed = gitStateChanges(known.entries, state.entries);
 return {
  kind: "mismatch",
  state,
  changed: changed.length > 0 ? changed : ["(config record order)"],
  since: `${known.at}, ${known.source}`,
 };
}

/** The park outcome for a mismatch: the changed names first (outcomes are cut at 400 chars). */
export function tamperOutcome(check: Extract<TrustCheck, { kind: "mismatch" }>, canonical: string, mapSelector: string): string {
 const names = check.changed.join(", ");
 const shown = names.length > 160 ? `${names.slice(0, 157)}…` : names;
 return `git state changed since it was last seen clean: ${shown} — in ${canonical} (known-good ${check.since}). Not adopted; once vetted, \`ranger trust-git --map ${mapSelector}\` records the current state, then resume the node.`;
}

/**
 * The trusted pre-worker snapshot: the current state's hash, provided it
 * matches the known-good record (`GitSafetyError` naming the change if not).
 */
export function trustedSnapshot(
 journal: Journal,
 canonical: string,
 at: { repo: string; nodeId?: string },
 mapSelector: string,
): string {
 const check = checkKnownGood(journal, canonical, at);
 if (check.kind === "mismatch") throw new GitSafetyError(tamperOutcome(check, canonical, mapSelector));
 return check.state.hash;
}

/**
 * Operator verb: adopt the current git state as known-good after vetting it.
 * Journals what changed against the previous record.
 */
export function trustCurrentGitState(
 journal: Journal,
 canonical: string,
 repo: string,
): { changed: string[]; previous: string | null } {
 const state = readGitState(canonical);
 const known = readKnownGood(journal, canonical);
 const changed =
  known === null
   ? []
   : known === "unreadable"
    ? ["(the known-good record was unreadable)"]
    : gitStateChanges(known.entries, state.entries);
 const previous = known === null ? null : known === "unreadable" ? "unreadable" : `${known.at}, ${known.source}`;
 recordKnownGood(journal, canonical, state, "trusted by the operator");
 journal.recordEvent("git-trust", {
  repo,
  detail: `operator trusted the git state of ${canonical}${changed.length > 0 ? `; changed: ${changed.join(", ")}` : ""}`.slice(0, 400),
 });
 return { changed, previous };
}

/**
 * Refresh the record after a supervisor step that should leave the state as
 * it was (a worktree add writes only what the state leaves out: node-branch
 * tracking, git's copy of the main `config.worktree`): recorded only when the state still hashes to the one the
 * supervisor verified, so a change in between is never adopted.
 */
export function recordIfUnchanged(
 journal: Journal,
 canonical: string,
 verified: GitState,
 source: string,
): void {
 const now = readGitState(canonical);
 if (now.hash === verified.hash) recordKnownGood(journal, canonical, now, source);
}

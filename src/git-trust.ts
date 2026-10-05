import {
 GitSafetyError,
 gitStateChanges,
 includeRefusal,
 readGitState,
 readGitStateSettled,
 type GitState,
} from "./git-ops.ts";
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
 * trust-git --hash` adopts it, and only the state its preview listed.
 *
 * One record per canonical checkout, whatever map or base runs in it: a
 * record per base let a base the checkout had not run before take the
 * current state on first sight, past the record another base had left. The
 * state is read the same for every base (`configRecords`, node #63). The
 * record holds digests only, never a config value. A state with an include
 * key is never recorded, adopted or run against (`includeKeys`).
 */

interface KnownGood {
 hash: string;
 entries: GitState["entries"];
 /** When the supervisor last saw this state clean, and how. */
 at: string;
 source: string;
}

type Known = KnownGood | "unreadable" | null;

function readKnownGood(journal: Journal, canonical: string): Known {
 const raw = journal.knownGoodGitState(canonical);
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

/** What a record says about `state`: the changes since it, and when it was seen clean (null: no record). */
function againstKnown(known: Known, state: GitState): { changed: string[]; since: string | null } {
 switch (known) {
  case null:
   return { changed: [], since: null };
  case "unreadable":
   return { changed: ["(the known-good record is unreadable)"], since: "unknown" };
  default: {
   const changed = gitStateChanges(known.entries, state.entries);
   const reordered = known.hash !== state.hash && changed.length === 0;
   return { changed: reordered ? ["(config record order)"] : changed, since: `${known.at}, ${known.source}` };
  }
 }
}

/** The current state, read again while another node's worktree add may be midway (`readGitStateSettled`). */
function readAgainst(canonical: string, expected: string | null): Promise<GitState> | GitState {
 return expected === null ? readGitState(canonical) : readGitStateSettled(canonical, expected);
}

/**
 * Record `state` as known-good. Callers pass a state they verified, never a
 * fresh read; a state with an include key is refused.
 */
export function recordKnownGood(
 journal: Journal,
 canonical: string,
 state: GitState,
 source: string,
): void {
 if (state.includes.length > 0) throw new GitSafetyError(includeRefusal(state.includes));
 const record: KnownGood = { hash: state.hash, entries: state.entries, at: new Date().toISOString(), source };
 journal.setKnownGoodGitState(canonical, JSON.stringify(record));
}

export type TrustCheck =
 | { kind: "match"; state: GitState }
 /** No record yet (a first run, or a journal from before node #81): the state read is now the record. */
 | { kind: "first"; state: GitState }
 | { kind: "mismatch"; state: GitState; changed: string[]; since: string }
 /** The state holds include keys: refused whatever the record says. */
 | { kind: "includes"; state: GitState };

export type TrustRefusal = Extract<TrustCheck, { kind: "mismatch" | "includes" }>;

export const isRefusal = (check: TrustCheck): check is TrustRefusal =>
 check.kind === "mismatch" || check.kind === "includes";

/**
 * Compare the current git state with the known-good record. With no record,
 * the current state becomes it and the journal says so: today's trust level
 * for a repo ranger has not seen before. A state with an include key is
 * refused before any of that, and so never becomes a record.
 */
export async function checkKnownGood(
 journal: Journal,
 canonical: string,
 at: { repo: string; nodeId?: string },
): Promise<TrustCheck> {
 const known = readKnownGood(journal, canonical);
 const state = await readAgainst(canonical, known === null || known === "unreadable" ? null : known.hash);
 if (state.includes.length > 0) return { kind: "includes", state };
 if (known !== null && known !== "unreadable" && known.hash === state.hash) return { kind: "match", state };
 const { changed, since } = againstKnown(known, state);
 if (since === null) {
  recordKnownGood(journal, canonical, state, "first sight");
  journal.recordEvent("git-trust", {
   ...at,
   detail: `no known-good git state recorded for ${canonical}: the current one is now the record`,
  });
  return { kind: "first", state };
 }
 return { kind: "mismatch", state, changed, since };
}

/**
 * The check for a checkout this run just cloned: git's own fresh state
 * becomes the record, unless it holds an include key.
 */
export function trustFreshClone(journal: Journal, canonical: string): TrustCheck {
 const state = readGitState(canonical);
 if (state.includes.length > 0) return { kind: "includes", state };
 recordKnownGood(journal, canonical, state, "fresh clone");
 return { kind: "match", state };
}

/**
 * The park outcome for a refusal: the changed names first (outcomes are cut
 * at 400 chars). `trust-git` without `--hash` lists every change.
 */
export function tamperOutcome(check: TrustRefusal, canonical: string, mapSelector: string): string {
 if (check.kind === "includes") return `${includeRefusal(check.state.includes)} (in ${canonical})`;
 const names = check.changed.join(", ");
 const shown = names.length > 160 ? `${names.slice(0, 157)}…` : names;
 return `git state changed since it was last seen clean: ${shown} — in ${canonical} (known-good ${check.since}). Not adopted; \`ranger trust-git --map ${mapSelector}\` lists every change, then adopt it with --hash and resume the node.`;
}

/**
 * The trusted pre-worker snapshot: the current state's hash, provided it
 * matches the known-good record (`GitSafetyError` naming the change if not).
 */
export async function trustedSnapshot(
 journal: Journal,
 canonical: string,
 at: { repo: string; nodeId?: string },
 mapSelector: string,
): Promise<string> {
 const check = await checkKnownGood(journal, canonical, at);
 if (isRefusal(check)) throw new GitSafetyError(tamperOutcome(check, canonical, mapSelector));
 return check.state.hash;
}

export interface TrustGitResult {
 /** False for a preview: nothing was recorded. */
 recorded: boolean;
 /** The current state's hash: pass it as `--hash` to adopt exactly this state. */
 hash: string;
 /** Every change against the previous record, untruncated. */
 changed: string[];
 /** When the previous record was seen clean, and how (null: none). */
 previous: string | null;
}

/**
 * Operator verb: adopt the current git state as known-good after vetting it.
 * Without `confirm` it only lists what changed and the state's hash. With
 * `confirm` (that hash) it records the state only while it still hashes to
 * it, so a change made after the preview, or one the operator never saw, is
 * never adopted. A state with an include key is refused: remove it first.
 */
export async function trustCurrentGitState(
 journal: Journal,
 canonical: string,
 repo: string,
 confirm?: string,
): Promise<TrustGitResult> {
 const known = readKnownGood(journal, canonical);
 const expected = confirm ?? (known === null || known === "unreadable" ? null : known.hash);
 const state = await readAgainst(canonical, expected);
 if (state.includes.length > 0) throw new GitSafetyError(includeRefusal(state.includes));
 const { changed, since } = againstKnown(known, state);
 const result = { hash: state.hash, changed, previous: since };
 if (confirm === undefined) return { recorded: false, ...result };
 if (state.hash !== confirm) {
  throw new GitSafetyError(
   `the git state of ${canonical} no longer hashes to ${confirm} (now ${state.hash}): run trust-git without --hash again and vet the new changes`,
  );
 }
 recordKnownGood(journal, canonical, state, "trusted by the operator");
 journal.recordEvent("git-trust", {
  repo,
  detail: `operator trusted the git state of ${canonical}${changed.length > 0 ? `; changed: ${changed.join(", ")}` : ""}`.slice(0, 400),
 });
 return { recorded: true, ...result };
}

/**
 * Refresh the record after a supervisor step that should leave the state as
 * it was (a worktree add writes only what the state leaves out: node-branch
 * tracking, git's copy of the main `config.worktree`): recorded only when
 * the state still hashes to the one the supervisor verified, so a change in
 * between is never adopted.
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

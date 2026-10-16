import { principalLoginForRepo } from "./config.ts";
import { fileStemFor, parseForgeRef } from "./forge-ref.ts";
import { lanePort } from "./forge-lanes.ts";
import type { ResolvedToken } from "./token-gate.ts";
import { changeRequestLabel, changeRequestNoun, changeRequestUrl, ciRunNoun, ciRunText, forgeName } from "./forge-text.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DiscordAnnouncer } from "./announce.ts";
import { code, renderCard } from "./card-render.ts";
import { mapKey } from "./maps.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { runCmd, type RunOptions, type RunResult } from "./exec.ts";
import {
 assertGitUntouched,
 assertNoClosingKeywords,
 baseOnlyMergePatchId,
 closingKeywordRefusal,
 commitsAhead,
 dirtyFiles,
 commitsBehind,
 fastForwardCanonical,
 fetchBranch,
 findClosingKeyword,
 gitCredential,
 GitSafetyError,
 headSha,
 isAncestor,
 safeGit,
 vettedPush,
} from "./git-ops.ts";
import { recordKnownGood, trustedSnapshot } from "./git-trust.ts";
import * as gh from "./github.ts";
import type { IssueComment, ChangeRequest, ForgePort, CiFailedRun, CiVerdict } from "./forge.ts";
import { HostLoadPark, ParkSignal } from "./signals.ts";
import { busyLoadFor, describeLoad, isQuiet, realHostLoad, type BusyReading, type HostLoad, type HostLoadReading } from "./host-load.ts";
import { implementLane } from "./lanes.ts";
import { isTransientGitHubError } from "./transient.ts";
import {
 PROBE_FILE,
 unfinishedProbes,
 parseFailedChecks,
 type FailedProbeRun,
 parseFailedProbes,
 probeFailureSummary,
 probeFailureClass,
 branchFixableProbes,
 baseConflictOutcome,
 blockedOutcome,
 policyBlockedOutcome,
 probesFailedOutcome,
 gitlabReviewHoldOutcome,
 hostLoadOutcome,
 reviewCapHeadMovedOutcome,
 reviewCapOutcome,
 substrateCappedOutcome,
} from "./outcomes.ts";
import { GRAPH_CALL_TIMEOUT_MS, graphNode, somaRepo, type NodeResult } from "./graph.ts";
import { finishClosedElsewhere } from "./closed-elsewhere.ts";
import { budgetedRead, budgetPolicy } from "./budget.ts";
import { GraphAddUnattached, graphAdd, graphClose, graphDecisions, graphLink, type AddSpec, type CloseResult } from "./graph-write.ts";
import { FixNodeLockBusy, withFixNodeLock } from "./fix-node-lock.ts";
import { assertFilable, codeCommentSpec, foundByProbeSpec, landminesInDiff, scribeFile, splitOutOfReviewSpec, type Provenance, type ScribeGraph } from "./scribe.ts";
import { FencedError, type ImplementPhase, type Journal } from "./journal.ts";
import { assembleImplementPrompt } from "./prompt.ts";
import { BLOCKED_REPORT_FILE, blockerNoteBranch, discardBlockedReport, readBlockedReport, type BlockedReport } from "./blocked-report.ts";
import { ReviewError, sageReview, type ReviewVerdict } from "./review.ts";
import {
 confirmCap,
 hookStopReason,
 selectSubstrate,
 workerOutputFor,
 type CapSignal,
 type SubstrateName,
 type SubstrateReaders,
} from "./substrate.ts";
import { isPiReviewTurn, selectForReview } from "./substrate-policy.ts";
import { failedSessionOutcome, recordSession } from "./substrate-usage.ts";
import { workerEnv } from "./worker-env.ts";
import type { CommitAuthor } from "./identity.ts";
import { tryWorkerLog, workerLogFile } from "./worker-log.ts";
import { captureViews, redactViewsReason, saveViewsRecord, viewsComment, viewsDirectory, type ViewsDependencies, type ViewsRecord } from "./views.ts";
import { NEEDS_EYE_LABEL } from "./labels.ts";
import { createShadowTestBackend, runShadowMeasured } from "./remote-test/shadow.ts";
import { assertTestEvidence, assertTestSource, createSshTestBackend, localTestBackend, runTestBackend, testCorrelationId, type TestBackend, type TestRequest, type TestResult } from "./remote-test/supervisor-backend.ts";

/**
 * The implement lane (design §4 task/build SOP, build-path step 4, node #23).
 *
 * The worker session only implements and commits — it never holds a
 * credential. The supervisor drives everything outward as a phase machine:
 *
 *   implement → (install, worker, tests, vetted push, draft PR)
 *   review    → (offline sage review at the pushed head; fix pass; cap)
 *   awaiting-merge → (PR ready; the tick's merge desk posts the one-tap card)
 *   close     → (after the principal's merge: fast-forward canonical, gated
 *                close citing CI, decisions --write)
 *
 * Phases are resumable (#23 amendment F2, the OpenRig restore-packet
 * pattern): on every run-node start GitHub wins — the PR found by head branch
 * and the bot-authored review markers on it say where to pick up, so a crash
 * mid-review neither restarts the work nor resets the round cap. Every
 * outward action is fenced by the occupant generation (F1).
 */

export type { ForgePort } from "./forge.ts";
export { ParkSignal } from "./signals.ts";

export const realGitHub: ForgePort = gh;

export type Reviewer = (
 repo: string,
 prNumber: number,
 readOnlyToken: string,
 opts?: { substrate?: SubstrateName; nice?: number; reviewAuthor?: string },
) => Promise<ReviewVerdict>;

export type WorkerRun = (prompt: string, opts: RunOptions) => Promise<RunResult>;

/** Runs a repo command (install/test/probe) as `/bin/sh -c`; tests inject it. */
export type ShellRun = (command: string, opts: RunOptions) => Promise<RunResult>;

export interface ImplementContext {
 config: RangerConfig;
 map: RangerMapConfig;
 token: string;
 /** The map's read-only token — the reviewer reads the PR under it (node #8). */
 readOnlyToken: string;
 /** The credential graph reads run under (`graphReadToken`); the write token when unset, GitHub's path. */
 graphToken?: ResolvedToken;
 botIdentity: string;
 /** A GitLab map's commit identity (node #127); `workerEnv` refuses a GitLab map without one. */
 commitAuthor?: CommitAuthor;
 journal: Journal;
 node: NodeResult;
 rootNode: NodeResult;
 canonical: string;
 worktree: string;
 branch: string;
 generation: number;
 /** auto: probes + CI close the node. merge: the principal's merge ratifies it (#23 ruling). */
 ratify: "auto" | "merge";
 workerRun: WorkerRun;
 /**
  * The session's temp journal (node #66): RANGER_JOURNAL_PATH for the worker
  * and every repo command, so branch code never opens the live journal.
  */
 sessionJournal: string;
 /** Repo-command runner (default `/bin/sh -c`); tests inject it. */
 shellRun?: ShellRun;
 /** Supervisor-owned test boundary; never passed to the coding worker. */
 testBackend?: TestBackend;
 github?: ForgePort;
 reviewer?: Reviewer;
 /** How long to wait for GitHub to show a pushed head (default 2 min; tests shorten it). */
 headPollMs?: number;
 /** The substrate the worker runs on (node #45). */
 substrate?: SubstrateName;
 /** The model the worker command pins (node #60); unset when ranger did not build the command. */
 model?: string;
 /** Quota readers for review selection and cap confirmation (tests inject them). */
 substrateReaders?: SubstrateReaders;
 /** Substrates capped earlier in this run: review selection leaves them out. */
 excludedSubstrates?: ReadonlySet<SubstrateName>;
 /** Capture shell/server injection; tests launch no browser. */
 viewsDependencies?: ViewsDependencies;
 /** The host load the probe tier waits on (tests inject a quiet or busy host). */
 hostLoad?: HostLoad;
 /** How often and how long the probe tier waits for a quiet host. */
 quietHost?: { pollMs: number; maxMs: number };
 /** How often and how many times to ask GitHub for a PR's mergeability (tests shorten it). */
 mergeablePoll?: { pollMs: number; attempts: number };
 /** Posts to the map's channel (the base-red notice); tests capture it. */
 announce?: (text: string) => Promise<unknown>;
 /** Files and reads fix-the-base nodes (node #152); default is `soma graph` under the machine token. */
 fixNode?: FixNodeGraph;
 /** The Scribe's graph port (design §6, node #24); default is `soma graph` under the machine token. */
 scribe?: ScribeGraph;
}

/** The graph port the fix-the-base filer writes and reads through (node #152). */
export interface FixNodeGraph {
 /** Throws `GraphAddUnattached` when the node was created but not attached. */
 add(parent: string, spec: AddSpec): Promise<{ node: string }>;
 /** Attach an existing node below `parent` (the repair for an unattached add). */
 link(node: string, parent: string): Promise<void>;
 /** The node's status ("open", "closed"). */
 status(id: string): Promise<string>;
}

export interface ImplementOutcome {
 status: "success" | "released" | "failed" | "refused" | "parked" | "awaiting-merge";
 detail: string;
 workerExit: number | null;
 close?: CloseResult;
 prNumber?: number;
 /** The closure reconciler has already finalized the worker and liveness state. */
 graphClosureReconciled?: true;
 /** When the failure was caused by a substrate rate limit (node #45). */
 substrateCapped?: CapSignal;
}

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** The map's supervisor test wall clock (`commands.testTimeoutMin`), in ms. */
const testTimeoutMs = (ctx: ImplementContext): number => ctx.map.commands.testTimeoutMin * 60_000;

const backends = new WeakMap<ImplementContext, TestBackend>();
const remotePasses = new WeakMap<ImplementContext, TestResult & { request: TestRequest }>();
function testBackendFor(ctx: ImplementContext): TestBackend {
 let backend = backends.get(ctx);
 if (!backend) {
  backend = ctx.testBackend ?? (ctx.map.testBackend?.kind === "shadow" ? createShadowTestBackend(ctx.map.testBackend) : ctx.map.testBackend ? createSshTestBackend(ctx.map.testBackend) : localTestBackend);
  if (ctx.map.testBackend?.kind === "ssh" && backend.kind !== "ssh") throw new GitSafetyError("SSH map cannot use a local test backend");
  if (ctx.map.testBackend?.kind === "shadow" && backend.kind !== "local") throw new GitSafetyError("Shadow map requires a local-authoritative backend");
  backends.set(ctx, backend);
 }
 return backend;
}
function remoteTests(ctx: ImplementContext): boolean { return testBackendFor(ctx).kind === "ssh"; }
function testRequest(ctx: ImplementContext, sha: string): TestRequest {
 return { worktree: ctx.worktree, head: sha, repositoryId: somaRepo(ctx.map.repo), generation: ctx.generation, correlationId: testCorrelationId(ctx.map.repo, ctx.map.root, ctx.node.ref.id) };
}
async function backendTests(ctx: ImplementContext, sha: string, local: () => Promise<RunResult>): Promise<RunResult> {
 const backend = testBackendFor(ctx), request = testRequest(ctx, sha);
 const snapshot = ctx.map.testBackend || backend.kind === "ssh" ? await trustedSnapshot(ctx.journal, ctx.canonical, { repo: ctx.map.repo, nodeId: ctx.node.ref.id }, mapKey(ctx.map)) : undefined;
 ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, "run supervisor tests");
 const tested = await runTestBackend(backend, request, local);
 if (snapshot !== undefined) await assertGitUntouched(ctx.canonical, snapshot);
 ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, "accept supervisor tests");
 if (ctx.map.testBackend?.kind === "shadow") {
  logRun(ctx, "shadow comparison (local gate authoritative)", tested.result);
  const s = tested.shadow;
  ctx.journal.recordEvent("reviewed", { nodeId: ctx.node.ref.id, repo: ctx.map.repo, detail: `shadow supervisor tests: local ${tested.result.code}; remote ${s?.state ?? "unavailable"}; outcome ${s?.parity ?? "pending"}; coverage ${s?.coverageParity ?? "pending"}; report ${s?.reportStored ? "saved" : "unavailable"}` });
 }
 if (backend.kind === "ssh") {
  remotePasses.delete(ctx);
  if (tested.evidence) ctx.journal.recordEvent("reviewed", { nodeId: ctx.node.ref.id, repo: ctx.map.repo, detail: `remote supervisor tests: ${tested.evidence.receipt.status}; receipt ${tested.evidence.path}` });
  if (tested.result.code === 0) remotePasses.set(ctx, { ...tested, request });
 }
 return tested.result;
}
async function assertRemotePush(ctx: ImplementContext, sha: string): Promise<void> {
 if (!remoteTests(ctx)) return;
 const passed = remotePasses.get(ctx);
 if (!passed?.evidence || passed.request.head !== sha || passed.request.generation !== ctx.generation) throw new GitSafetyError("No current remote supervisor receipt for push");
 try {
  await assertTestSource(testRequest(ctx, sha));
  await assertTestEvidence(passed.evidence, testRequest(ctx, sha));
 } catch { throw new GitSafetyError("Remote supervisor source or receipt is no longer current; refusing push"); }
 ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, "push remotely tested commit");
}

/** The review-round marker ranger writes into each review comment it posts. */
export function reviewMarker(round: number, v: Pick<ReviewVerdict, "commitId" | "blockers" | "majors" | "nits">, substrate?: string, carried?: string): string {
 const base = `<!-- ranger:review round=${round} sha=${v.commitId} blockers=${v.blockers} majors=${v.majors} nits=${v.nits}`;
 return `${base}${carried === undefined ? "" : ` carried=${carried}`}${substrate === undefined ? "" : ` substrate=${substrate}`} -->`;
}

export interface RecordedReview {
 round: number;
 sha: string;
 blockers: number;
 majors: number;
 nits: number;
 /** The substrate the review ran on (node #45); undefined for old markers. */
 substrate?: string;
 carried?: string;
 /** The review text, without the marker — the fix pass's input on a resume. */
 body: string;
}

const MARKER = /^<!-- ranger:review round=(\d+) sha=([0-9a-f]{7,64}) blockers=(\d+) majors=(\d+) nits=(\d+)((?:\s+[\w-]+=[^\s<>]+)*) -->/;

/**
 * The durable review record on the PR: markers in comments the MACHINE
 * ACCOUNT wrote. A marker in anyone else's comment is ignored — otherwise a
 * third party could forge a clean verdict or reset the round cap. The marker
 * counts only at the start of the comment, where reviewComment writes it, so
 * a marker quoted inside review text never reads as a round.
 */
export function recordedReviews(
 comments: IssueComment[],
 botIdentity: string,
): RecordedReview[] {
 const out: RecordedReview[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(MARKER);
  if (m === null) continue;
  const fields = new Map(m[6].trim().split(/\s+/).filter(Boolean).map(field => {
   const equals = field.indexOf("=");
   return [field.slice(0, equals), field.slice(equals + 1)];
  }));
  const carried = fields.get("carried");
  const substrate = fields.get("substrate");
  if (carried !== undefined && !/^[0-9a-f]{7,64}$/.test(carried)) continue;
  if (substrate !== undefined && !/^\w+$/.test(substrate)) continue;
  out.push({
   round: Number(m[1]),
   sha: m[2],
   blockers: Number(m[3]),
   majors: Number(m[4]),
   nits: Number(m[5]),
   carried,
   substrate,
   body: c.body.replace(MARKER, "").trim(),
  });
 }
 return out.sort((a, b) => a.round - b.round);
}

function reviewRounds(reviews: RecordedReview[]): number {
 return reviews.reduce((round, review) => Math.max(round, review.round), 0);
}

/** The hidden markers ranger and sage write into their own PR comments. */
const TOOL_MARKER = /<!--\s*(?:ranger|sage):/;

/** How many principal rulings a fix pass carries, newest kept, and how long each may be. */
export const MAX_RULINGS = 20;
export const MAX_RULING_CHARS = 4000;

/**
 * The principal's comments on the change request, oldest first: rulings the
 * fix pass takes as binding, ahead of the sage review (ranger issue #230).
 * A ruling is a plain PR comment, so the author is the only proof: the
 * principal's login for the repo's forge, never a marker anyone could type.
 * No configured login, no rulings.
 *
 * A comment carrying a tool's marker is not a ruling, whoever posted it: a
 * `sage review --post` the principal runs by hand lands under the
 * principal's login, and it quotes untrusted diff and PR text (sage round 1
 * on PR #233).
 */
export function principalRulings(comments: IssueComment[], principal: string | undefined): string[] {
 if (principal === undefined || principal === "") return [];
 return comments
  .filter((c) => c.author === principal && !TOOL_MARKER.test(c.body))
  .map((c) => c.body.trim())
  .filter((body) => body !== "")
  .slice(-MAX_RULINGS)
  .map((body) => (body.length > MAX_RULING_CHARS ? `${body.slice(0, MAX_RULING_CHARS)}\n[… cut at ${MAX_RULING_CHARS} characters]` : body));
}

/**
 * The review that stands at `sha`: the one with the highest round among the
 * reviews of that head (a tied round falls to the later one in the input),
 * whatever the earlier rounds there found, a genuine major included (node
 * #106). Once a newer round is posted at a head, an errored round there no
 * longer pins it. Nothing in the implement loop posts that round: the loop
 * reviews only a head with no review, so the newer round is a rerun posted
 * under the machine account; a same-head retry belongs to the review-budget
 * node.
 *
 * The risk this accepts: an LLM reviewer can flag a real major in one round
 * and miss it in the next, and the newer, clean round then stands. The
 * marker carries no error or completeness field, so this cannot tell an
 * errored lens from a real finding. `supersededAtHead` names every major a
 * clean round set aside; the journal carries it, and the merge desk holds
 * auto-merge on such a head and posts the manual merge card naming it, so
 * the principal checks the set-aside major before the PR can merge.
 *
 * Only the machine account's markers are recorded (recordedReviews), so a
 * third party cannot post the round that clears a head. Older reviews stay
 * in the record untouched.
 */
export function reviewAtHead<R extends { round: number; sha: string }>(reviews: R[], sha: string): R | undefined {
 let standing: R | undefined;
 for (const r of reviews) {
  if (r.sha === sha && (standing === undefined || r.round >= standing.round)) standing = r;
 }
 return standing;
}

/** The fields that decide whether a review gates its head. */
type GatedReview = { round: number; sha: string; blockers: number; majors: number };

/** The review standing at `sha` and the older gating ones a clean standing review sets aside, oldest first. */
function setAsideAtHead<R extends GatedReview>(reviews: R[], sha: string): { standing: R | undefined; older: R[] } {
 const standing = reviewAtHead(reviews, sha);
 if (standing === undefined || gatingFindings(standing) > 0) return { standing, older: [] };
 const older = reviews
  .filter((r) => r !== standing && r.sha === sha && gatingFindings(r) > 0)
  .sort((a, b) => a.round - b.round);
 return { standing, older };
}

/**
 * The older reviews at `sha` whose blockers or majors the clean review
 * standing there sets aside, oldest first. Empty when the standing review
 * gates itself, or when no older round at the head had a gating finding.
 */
export function supersededAtHead<R extends GatedReview>(reviews: R[], sha: string): R[] {
 return setAsideAtHead(reviews, sha).older;
}

/** One line naming the gating findings a clean same-head round set aside; null when none. */
export function supersededNote<R extends GatedReview>(reviews: R[], sha: string): string | null {
 const { standing, older } = setAsideAtHead(reviews, sha);
 if (older.length === 0 || standing === undefined) return null;
 const rounds = older.map((r) => `round ${r.round} (${r.blockers} blocker(s), ${r.majors} major(s))`).join(", ");
 return `sage ${rounds} at ${sha.slice(0, 8)} superseded by the clean round ${standing.round} at the same head (no code change between them)`;
}

export { parseFailedProbes };
export { NEEDS_EYE_LABEL } from "./labels.ts";

/** The findings that gate a PR: blockers and majors (principal, 2026-10-03). */
export function gatingFindings(r: { blockers: number; majors: number }): number {
 return r.blockers + r.majors;
}

export interface RecordedProbe {
 sha: string;
 passed: boolean;
 /** Probes the selector chose ("?" when the output did not say). */
 selected: string;
 mode: string;
 /**
  * Probes that failed twice at this head and fail at its merge base too:
  * the base is red on them, so they do not gate this branch. Undefined when
  * every probe passed.
  */
 baseRed?: string[];
 /** Base results reused from twice-confirmed assertion failures. */
 baseRedCache?: { sha: string; probes: string[] };
 /** Probes whose second base run did not confirm the first run's assertions. */
 baseRedUnconfirmed?: { sha: string; probes: string[]; exit: number };
}

const PROBE_MARKER =
 /<!-- ranger:probes sha=([0-9a-f]{7,64}) result=(pass|fail) selected=(\d+|\?) mode=([\w-]+)(?: base-red=([\w.,-]+))?(?: base-red-cache-sha=([0-9a-f]{40}) base-red-cache=([\w.,-]+))?(?: base-red-unconfirmed-sha=([0-9a-f]{40}) base-red-unconfirmed-exit=(-?\d+) base-red-unconfirmed=([\w.,-]+))? -->/;

export function probeMarker(p: RecordedProbe): string {
 const baseRed = p.baseRed !== undefined && p.baseRed.length > 0 ? ` base-red=${p.baseRed.join(",")}` : "";
 const cache = p.baseRedCache;
 const cached = cache !== undefined && cache.probes.length > 0 ? ` base-red-cache-sha=${cache.sha} base-red-cache=${cache.probes.join(",")}` : "";
 const confirmation = p.baseRedUnconfirmed;
 const unconfirmed = confirmation !== undefined && confirmation.probes.length > 0
  ? ` base-red-unconfirmed-sha=${confirmation.sha} base-red-unconfirmed-exit=${confirmation.exit} base-red-unconfirmed=${confirmation.probes.join(",")}` : "";
 return `<!-- ranger:probes sha=${p.sha} result=${p.passed ? "pass" : "fail"} selected=${p.selected} mode=${p.mode}${baseRed}${cached}${unconfirmed} -->`;
}

/** Probe runs recorded on the PR by the MACHINE ACCOUNT (anyone else's markers are ignored). */
export function recordedProbes(
 comments: IssueComment[],
 botIdentity: string,
): RecordedProbe[] {
 const out: RecordedProbe[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(PROBE_MARKER);
  if (m === null) continue;
  const baseRed = m[5]?.split(",").filter((n) => PROBE_FILE.test(n));
  const cached = m[7]?.split(",").filter((n) => PROBE_FILE.test(n));
  const unconfirmed = m[10]?.split(",").filter((n) => PROBE_FILE.test(n));
  out.push({
   sha: m[1],
   passed: m[2] === "pass",
   selected: m[3],
   mode: m[4],
   ...(baseRed !== undefined && baseRed.length > 0 ? { baseRed } : {}),
   ...(cached !== undefined && cached.length > 0 ? { baseRedCache: { sha: m[6], probes: cached } } : {}),
   ...(unconfirmed !== undefined && unconfirmed.length > 0 ? { baseRedUnconfirmed: { sha: m[8], probes: unconfirmed, exit: Number(m[9]) } } : {}),
  });
 }
 return out;
}

export function probeRetryCommandFor(template: string, nodeId: string, failed: string[]): string {
 if (failed.length === 0 || !failed.every((n) => PROBE_FILE.test(n))) {
  throw new ParkSignal("refusing to template probe names that are not plain probe file names");
 }
 return probeCommandFor(template, nodeId).replaceAll("{failed}", failed.join(","));
}

/** The selector's own summary lines (`probe selection: <mode>`, `selected: <n>`). */
export function parseProbeSummary(stdout: string): { selected: string; mode: string } {
 const mode = stdout.match(/^probe selection: ([\w-]+)/m)?.[1] ?? "unknown";
 const selected = stdout.match(/^selected: (\d+)/m)?.[1] ?? "?";
 return { selected, mode };
}

/** `commands.probe` with `{node}` replaced — the node id is digits, so nothing else gets in. */
export function probeCommandFor(template: string, nodeId: string): string {
 if (!/^\d+$/.test(nodeId)) {
  throw new ParkSignal(`node id ${nodeId} is not numeric — refusing to template the probe command`);
 }
 return template.replaceAll("{node}", nodeId);
}

interface ProbeTierFailure {
 parkOutcome: string;
 branchFixable: string[];
 failureSummary: string[];
}

/**
 * The probe tier (#23 follow-up, principal's choice 2026-10-03): run the
 * map's probe command ONCE on the final, sage-clean head — exactly the head
 * the merge card certifies. A failure is retried once (design §7's flaky-probe
 * rule), then comes back as a failure: the caller gives the branch's own
 * assertion failures one probe fix pass, and parks on anything else. Every
 * run is recorded on the PR as a bot marker; a passing record at the same
 * head is reused on resume.
 */
async function probeFinalHead(
 ctx: ImplementContext,
 github: ForgePort,
 prNumber: number,
): Promise<{ record: RecordedProbe; failure?: ProbeTierFailure }> {
 const { map, journal, node, token, botIdentity, worktree } = ctx;
 const repo = map.repo;
 const nodeId = node.ref.id;
 const live = await github.getPr(repo, prNumber, token);
 const existing = recordedProbes(
  await github.listComments(repo, prNumber, token),
  botIdentity,
 ).find((p) => p.sha === live.headSha && p.passed);
 if (existing !== undefined) return { record: existing };

 if ((await headSha(worktree)) !== live.headSha) {
  throw new ParkSignal(
   `the worktree is not at ${changeRequestLabel(repo, prNumber)}'s head ${live.headSha.slice(0, 8)} — refusing to certify probes for a different tree`,
  );
 }
 const command = probeCommandFor(map.commands.probe as string, nodeId);
 const timeoutMs = map.commands.probeTimeoutMin * 60_000;
 await awaitQuietHost(ctx, "probe run 1");
 const logFailuresBefore = logFailureCount(ctx);
 let result = await runShell(command, worktree, ctx, { label: "probe run 1", timeoutMs, priority: "probe" });
 const runs = [result];
 let attempts = 1;
 let ranCommand = command;
 // The record names the selection of the first run: a narrowed retry selects only the failures.
 const summary = parseProbeSummary(result.stdout);
 if (result.code !== 0) {
  // A run that named its failures (a FAILED line) retries only those, when
  // the map says how. One that stopped without naming them (a timeout, a
  // kill: exit < 0, or 128+signal when a shell sat between; a crash) retries
  // only the selected probes it had not passed (2026-10-05: 88 probes selected
  // on #491 hit the 30-minute limit, and the full rerun had to start over);
  // one that says nothing usable reruns all.
  const failed = result.code > 0 ? parseFailedProbes(result.stdout) : [];
  const unfinished = failed.length === 0 ? unfinishedProbes(result.stdout) : [];
  const narrowed = failed.length > 0 ? failed : unfinished;
  const retryTemplate = map.commands.probeRetry;
  if (retryTemplate !== undefined && narrowed.length > 0) {
   ranCommand = probeRetryCommandFor(retryTemplate, nodeId, narrowed);
  }
  const what =
   ranCommand === command
    ? "the full suite"
    : failed.length > 0
     ? `only ${failed.join(", ")}`
     : `only the ${unfinished.length} probe(s) it had not passed when it stopped`;
  journal.recordEvent("reviewed", { nodeId, repo, detail: `probe run 1 failed (exit ${result.code}) — retrying ${what}`.slice(0, 400) });
  await awaitQuietHost(ctx, "the probe retry");
  result = await runShell(ranCommand, worktree, ctx, { label: "probe run 2 (the retry)", timeoutMs, priority: "probe" });
  runs.push(result);
  attempts = 2;
 }
 const failed = result.code > 0 ? parseFailedProbes(result.stdout) : [];
 // A failure the merge base shares is the base's, not this branch's
 // (2026-10-05: main went red on one probe and parked every later node).
 const base = result.code === 0 ? null : await probeMergeBase(ctx, failed, result.stdout);
 if (base !== null) journal.recordEvent("reviewed", { nodeId, repo, detail: baseProbeDetail(repo, base) });
 const baseRed = base !== null && base.red.length === failed.length ? base.red : undefined;
 const record: RecordedProbe = {
  sha: live.headSha,
  passed: result.code === 0 || baseRed !== undefined,
  ...summary,
  ...(baseRed === undefined ? {} : { baseRed }),
  ...(base !== null && base.cached.length > 0 ? { baseRedCache: { sha: base.sha, probes: base.cached } } : {}),
  ...(base !== null && base.unconfirmed.length > 0 ? { baseRedUnconfirmed: { sha: base.sha, probes: base.unconfirmed, exit: base.confirmationExit! } } : {}),
 };
 if (baseRed !== undefined) await announceBaseRed(ctx, base!.sha, record);
 ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "post the probe record");
 // Before the park: a probe confirmed red at base is the base's, whatever else this branch broke.
 // A cache hit counts too: another map on this base, or an earlier failed add, files here.
 if (base !== null && base.confirmed.length + base.cached.length > 0) {
  await fileBaseRedFixNodes(ctx, base, { number: prNumber, url: changeRequestUrl(repo, prNumber, live.webUrl) });
 }
 // Named failures lead the record, the event and the park: an output tail can hold only passing probes.
 const failing = probeFailureSummary(result.stdout, result.code);
 // Named only when every run here (both attempts, the merge base's) was written.
 const log = logFailureCount(ctx) === logFailuresBefore ? basename(workerLogFile(journal.path, repo, nodeId, ctx.generation)) : null;
 // Again after the filing: its lease wait and graph writes can outlast this worker's generation.
 ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "post the probe record");
 await github.postComment(repo, prNumber, probeComment(repo, ranCommand, record, attempts, result, failing, log), token);
 journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail: `probes ${record.passed ? "passed" : "FAILED"} at ${record.sha.slice(0, 8)} (${record.mode}, ${record.selected} selected, ${attempts} run(s))${baseRedNote(repo, record)}${record.passed ? "" : ` — failing: ${failing.join(" · ")}`}`.slice(0, 400),
 });
 if (record.passed) return { record };
 return {
  record,
  failure: {
   parkOutcome: probesFailedOutcome({
    repo,
    sha: record.sha,
    pr: prNumber,
    exit: result.code,
    failed,
    failureClass: probeFailureClass(runs),
    redOnBase: base?.red ?? [],
    summary: failing,
    tail: tail(result),
   }),
   branchFixable: branchFixableProbes(runs, failed, base),
   failureSummary: failing,
  },
 };
}

/** The host's 1-minute load and core count: the probe tier waits for a quiet host. */
export type { HostLoad } from "./host-load.ts";

/** How long a probe run waits for the host to quiet down before running anyway. */
const QUIET_HOST = { pollMs: 30_000, maxMs: 20 * 60_000 };

/**
 * The 1-minute load the host counts as busy at for this node's lane
 * (`busyLoadFor`, node #312): every wait, retry and host-load park reads it.
 * Unset, the core count.
 */
const busyLoad = (ctx: ImplementContext) => busyLoadFor(ctx.config?.workers, implementLane(ctx.map));

/** The host's load now when it is busy, else null. */
const busyHostNow = (ctx: ImplementContext): HostLoadReading | null => {
 const host = (ctx.hostLoad ?? realHostLoad)();
 return isQuiet(host, busyLoad(ctx)) ? null : host;
};

/**
 * Wait until the host is quiet (`isQuiet`) before a probe or test run.
 * The browser probes are timing-sensitive, and the headless lane's worker and
 * test runs load the same host (2026-10-04: probe-gamepad failed at peak load
 * 28.6 on 10 cores during node 58's fix pass, and the immediate retry ran
 * under the same load; one quiet run passed the same head). After `maxMs`
 * the run goes ahead anyway: a busy host delays the probe tier, never stops it.
 * Returns the last reading: what the host was when the run started.
 */
async function awaitQuietHost(ctx: ImplementContext, run: string): Promise<HostLoadReading> {
 const read = ctx.hostLoad ?? realHostLoad;
 const { pollMs, maxMs } = ctx.quietHost ?? QUIET_HOST;
 const limit = busyLoad(ctx);
 let host = read();
 if (isQuiet(host, limit)) return host;
 const nodeId = ctx.node.ref.id;
 const repo = ctx.map.repo;
 const started = Date.now();
 ctx.journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail: `${run} waits for the host: ${describeLoad(host, limit)}`,
 });
 while (!isQuiet(host, limit) && Date.now() - started < maxMs) {
  await new Promise((r) => setTimeout(r, pollMs));
  host = read();
 }
 const waited = Math.round((Date.now() - started) / 1000);
 ctx.journal.recordEvent("reviewed", {
  nodeId,
  repo,
  detail:
   isQuiet(host, limit)
    ? `${run} starts after ${waited}s: ${describeLoad(host, limit)}`
    : `${run} starts on a busy host after ${waited}s: ${describeLoad(host, limit)}`,
 });
 return host;
}

export interface BaseProbeResult {
 /** The merge base the probes ran at. */
 sha: string;
 /** Failed probes that fail the same checks at the merge base: the base's failure, not this branch's. */
 red: string[];
 /** Probes inherited from the twice-confirmed cache rather than a base run. */
 cached: string[];
 /** First-run inherited probes whose confirmation did not repeat identical assertions; not cached. */
 unconfirmed: string[];
 /** Probes this comparison confirmed and wrote to the cache; with `cached`, the probes that may file a fix-the-base node. */
 confirmed: string[];
 confirmationExit?: number;
 /** Failed probes that fail at the merge base too, but not the same way (another check, or a crash), so they gate. */
 differs: string[];
 /** Failed probes that pass at the merge base: the branch broke them. */
 passed: string[];
 /** Failed probes the branch added or edited: the base runs another probe under that name, so they gate. */
 changed: string[];
 /** Failed probes that crashed, were killed or timed out at the head (or whose kind is unreadable): never inherited, so they gate without a base run. */
 uncomparable: string[];
 /** Fresh probes without a base result (missing command, failed setup or unnamed failure): they gate. */
 unresolved: string[];
}

function cacheProvenance(sha: string, probes: string[], capitalized = false): string {
 return `${capitalized ? "Base" : "base"} result from cache at ${sha.slice(0, 8)}: ${probes.join(", ")}`;
}

function unconfirmedBaseNote(repo: string, sha: string, probes: string[], exit: number): string {
 return `Base confirmation at ${sha.slice(0, 8)} ${exit === 0 ? "passed" : `exited ${exit} without repeating identical assertion failures`}: ${probes.join(", ")}. No cache written for these probes; this ${changeRequestNoun(repo)} uses the first base comparison.`;
}

/** The journal line for a merge-base probe check. */
function baseProbeDetail(repo: string, b: BaseProbeResult): string {
 const at = `the merge base ${b.sha.slice(0, 8)}`;
 return [
  b.red.length > 0 ? `${b.red.join(", ")} fail at ${at} too` : null,
  b.cached.length > 0 ? cacheProvenance(b.sha, b.cached) : null,
  b.unconfirmed.length > 0 ? unconfirmedBaseNote(repo, b.sha, b.unconfirmed, b.confirmationExit!) : null,
  b.differs.length > 0 ? `${b.differs.join(", ")} fail at ${at} too, but not the same way — they gate` : null,
  b.passed.length > 0 ? `${b.passed.join(", ")} pass at ${at} — the failure is this branch's` : null,
  b.changed.length > 0 ? `${b.changed.join(", ")} are new or changed on this branch — they gate` : null,
  b.uncomparable.length > 0
   ? `${b.uncomparable.join(", ")} ended in a crash, kill, timeout or an unreadable kind at the head — not run at ${at}, they gate`
   : null,
  b.unresolved.length > 0 ? `${b.unresolved.join(", ")} have no base result — they gate` : null,
 ].filter((part) => part !== null).join("; ");
}

/**
 * A head failure the merge base could share: a completed assertion failure.
 * A crash, kill or timeout is a failure of its own, and a kind the runner did
 * not print or ranger does not know fails closed.
 */
function inheritable(run: FailedProbeRun | undefined): run is FailedProbeRun {
 return run !== undefined && run.kind === "assert";
}

/** A nonempty failure set is inherited only when every check is covered. */
function coversChecks(here: Set<string>, there: Set<string>): boolean {
 return here.size > 0 && [...here].every((check) => there.has(check));
}

function sameCheckSet(a: Set<string>, b: Set<string>): boolean {
 return a.size === b.size && coversChecks(a, b);
}

/** File names (no directory) in git's newline-separated path output. */
function fileNames(stdout: string): Set<string> {
 return new Set(stdout.split("\n").filter(Boolean).map((p) => p.slice(p.lastIndexOf("/") + 1)));
}

function baseRedChecksKey(repo: string, sha: string, probe: string): string {
 return `base-red-checks.${repo}.${sha}.${probe}`;
}

/** Malformed values are misses; only nonempty check-name arrays are trusted. */
function cachedBaseChecks(journal: Journal, key: string): Set<string> | null {
 const value = journal.getHealth(key);
 if (value === null) return null;
 try {
  const checks: unknown = JSON.parse(value);
  return Array.isArray(checks) && checks.length > 0 && checks.every((c) => typeof c === "string" && c.trim().length > 0)
   ? new Set(checks)
   : null;
 } catch {
  return null;
 }
}

function baseProbeRun(ctx: ImplementContext, dir: string, sha: string, probes: string[], label: string): Promise<RunResult> {
 return runShell(probeRetryCommandFor(ctx.map.commands.probeRetry!, ctx.node.ref.id, probes), dir, ctx, {
  label: `merge base ${sha.slice(0, 8)}: ${label}`,
  timeoutMs: ctx.map.commands.probeTimeoutMin * 60_000,
  priority: "probe",
 });
}

async function confirmBaseRed(
 ctx: ImplementContext,
 dir: string,
 sha: string,
 red: string[],
 baseChecks: Map<string, FailedProbeRun>,
): Promise<{ unconfirmed: string[]; confirmationExit: number }> {
 const confirmation = await baseProbeRun(ctx, dir, sha, red, "probe confirmation");
 const names = confirmation.code > 0 ? parseFailedProbes(confirmation.stdout) : [];
 const checks = parseFailedChecks(confirmation.stdout);
 const unconfirmed: string[] = [];
 for (const probe of red) {
  const first = baseChecks.get(probe)!;
  const second = checks.get(probe);
  if (names.includes(probe) && inheritable(second) && sameCheckSet(first.checks, second.checks)) {
   ctx.journal.setHealth(baseRedChecksKey(ctx.map.repo, sha, probe), JSON.stringify([...first.checks].sort()));
  } else {
   unconfirmed.push(probe);
  }
 }
 if (unconfirmed.length > 0) {
  ctx.journal.recordEvent("reviewed", {
   repo: ctx.map.repo,
   nodeId: ctx.node.ref.id,
   detail: `${unconfirmedBaseNote(ctx.map.repo, sha, unconfirmed, confirmation.code)} Confirmation exit ${confirmation.code}${confirmation.code === 0 ? " (passed)" : `: ${probeFailureSummary(confirmation.stdout, confirmation.code).join(" · ")}`}`,
  });
 }
 return { unconfirmed, confirmationExit: confirmation.code };
}

/**
 * Compare failed probes with twice-confirmed cached checks at the merge base,
 * or run uncached probes in a throwaway detached worktree. Confirm matching
 * base assertions a second time before caching; that run does not change
 * this PR's single-run comparison. A probe the branch added or edited is
 * not compared: the base would run another probe under
 * its name, so it gates whatever the base says. A probe file holds many
 * checks, so one red at the base is the base's only when every check it
 * fails here fails there too, and both runs ended as assertion failures. A
 * head crash, kill or timeout cannot be inherited, so it gates without a base
 * run or a wait for a quiet host (2026-10-05: two crashed probes on seelite
 * #702 waited 240 s for a base run that could not clear them). Null when no
 * comparison is possible: no named head failures or
 * unreadable git state. Unresolved fresh failures gate even if other probes
 * have a cached base result.
 * @internal Exported for the probe-comparison test seam.
 */
export async function probeMergeBase(
 ctx: ImplementContext,
 failed: string[],
 headStdout: string,
): Promise<BaseProbeResult | null> {
 const { map, worktree } = ctx;
 const template = map.commands.probeRetry;
 if (failed.length === 0) return null;
 const merged = await safeGit(["merge-base", "HEAD", `origin/${map.base}`], { cwd: worktree, timeoutMs: 30_000 });
 const sha = merged.stdout.trim();
 if (merged.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return null;
 const tree = await safeGit(["ls-tree", "-r", "--name-only", sha], { cwd: worktree, timeoutMs: 30_000 });
 const diff = await safeGit(["diff", "--name-only", sha, "HEAD"], { cwd: worktree, timeoutMs: 30_000 });
 if (tree.code !== 0 || diff.code !== 0) return null;
 const atBase = fileNames(tree.stdout);
 const touched = fileNames(diff.stdout);
 const changed = failed.filter((n) => !atBase.has(n) || touched.has(n));
 const headChecks = parseFailedChecks(headStdout);
 const uncomparable = failed.filter((n) => !changed.includes(n) && !inheritable(headChecks.get(n)));
 const comparable = failed.filter((n) => !changed.includes(n) && !uncomparable.includes(n));
 const cached: string[] = [];
 const differs: string[] = [];
 const fresh: string[] = [];
 for (const probe of comparable) {
  const checks = cachedBaseChecks(ctx.journal, baseRedChecksKey(map.repo, sha, probe));
  if (checks === null) fresh.push(probe);
  else if (coversChecks(headChecks.get(probe)!.checks, checks)) cached.push(probe);
  else differs.push(probe);
 }
 const known: BaseProbeResult = { sha, red: [...cached], cached, unconfirmed: [], confirmed: [], differs, passed: [], changed, uncomparable, unresolved: fresh };
 if (fresh.length === 0 || template === undefined) return known;
 const scratch = mkdtempSync(join(tmpdir(), "ranger-probe-base-"));
 const dir = join(scratch, "worktree");
 try {
  const add = await safeGit(["worktree", "add", "--detach", dir, sha], { cwd: worktree, timeoutMs: 120_000 });
  if (add.code !== 0) return known;
  if (map.commands.install !== undefined) {
   const install = await runShell(map.commands.install, dir, ctx, { label: `merge base ${sha.slice(0, 8)}: install`, timeoutMs: INSTALL_TIMEOUT_MS });
   if (install.code !== 0) return known;
  }
  await awaitQuietHost(ctx, "the merge-base probe run");
  const run = await baseProbeRun(ctx, dir, sha, fresh, "probe run");
  if (run.code === 0) return { ...known, passed: fresh, unresolved: [] };
  const named = run.code > 0 ? parseFailedProbes(run.stdout) : [];
  if (named.length === 0) return known;
  const baseChecks = parseFailedChecks(run.stdout);
  // Both runs must be completed assertion failures: a crash, kill or timeout
  // after the inherited check is a failure of its own that names no check.
  const sameChecks = (probe: string): boolean => {
   const here = headChecks.get(probe);
   const there = baseChecks.get(probe);
   if (!inheritable(here) || there === undefined || there.kind !== "assert") return false;
   return coversChecks(here.checks, there.checks);
  };
  const redThere = fresh.filter((n) => named.includes(n));
  const red = redThere.filter(sameChecks);
  const result: BaseProbeResult = {
   ...known,
   red: [...cached, ...red],
   differs: [...differs, ...redThere.filter((n) => !sameChecks(n))],
   passed: fresh.filter((n) => !named.includes(n)),
   unresolved: [],
  };
  if (red.length > 0) {
   // Confirmation uses this worktree without another quiet-host wait.
   const confirmation = await confirmBaseRed(ctx, dir, sha, red, baseChecks);
   return { ...result, ...confirmation, confirmed: red.filter((n) => !confirmation.unconfirmed.includes(n)) };
  }
  return result;
 } finally {
  await safeGit(["worktree", "remove", "--force", dir], { cwd: worktree, timeoutMs: 60_000 });
  rmSync(scratch, { recursive: true, force: true });
  await safeGit(["worktree", "prune"], { cwd: worktree, timeoutMs: 30_000 });
 }
}

/**
 * Tell the map's channel once per map, merge base and probe set that the base
 * is red: every later branch off it would otherwise fail the same probes. The
 * run was at the merge base, not the base's tip, so the notice says so. Best
 * effort; the probe record on the PR is the durable trace.
 */
async function announceBaseRed(ctx: ImplementContext, sha: string, probe: RecordedProbe): Promise<void> {
 const red = probe.baseRed!;
 const key = `base-red.${mapKey(ctx.map)}.${sha}.${[...red].sort().join(",")}`;
 if (ctx.journal.getHealth(key) !== null) return;
 const text = renderCard({
  emoji: "🔴",
  status: `${ctx.map.base} was red`,
  title: `at ${code(sha.slice(0, 8))} on ${red.map(code).join(", ")}`,
  meta: [`map: ${mapKey(ctx.map)}`, `base ${code(ctx.map.base)}`, `found by node ${code(`#${ctx.node.ref.id}`)}`],
  lines: [
   `Node ${code(`#${ctx.node.ref.id}`)} failed these probes twice.${baseRedNote(ctx.map.repo, probe)}`,
   `Later ${changeRequestNoun(ctx.map.repo)}s reuse only twice-confirmed cached checks; an unconfirmed comparison needs a fresh base run.`,
  ],
 });
 try {
  await (ctx.announce ?? ((t: string) => DiscordAnnouncer.fromMap(ctx.map).post(t, "base-red notice")))(text);
  ctx.journal.setHealth(key, new Date().toISOString());
 } catch {
  /* best effort: the next node off this base tries again */
 }
}

/** The journal's record of a map's fix-the-base node for one probe (node #152). */
export function baseRedFixKey(map: { repo: string; root: number }, probe: string): string {
 return `base-red-fix.${mapKey(map)}.${probe}`;
}

interface FixRecord {
 node: string;
 sha?: string;
 /** Set while the node exists but is not attached below `parent`. */
 unattached?: { parent: string };
}

function fixRecord(value: string | null): FixRecord | null {
 if (value === null) return null;
 try {
  const record = JSON.parse(value) as { node?: unknown; sha?: unknown; attached?: unknown; parent?: unknown } | null;
  const node = record?.node;
  if (typeof node !== "string" || node.length === 0) return null;
  const parsed: FixRecord = { node };
  if (typeof record?.sha === "string") parsed.sha = record.sha;
  if (record?.attached === false && typeof record.parent === "string") parsed.unattached = { parent: record.parent };
  return parsed;
 } catch {
  return null;
 }
}

function machineFixNodeGraph(ctx: ImplementContext): FixNodeGraph {
 const repo = ctx.map.repo;
 const credential = graphCredential(ctx);
 return {
  add: (parent, spec) => graphAdd(repo, parent, spec, ctx.token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS }),
  link: (node, parent) => graphLink(repo, node, parent, ctx.token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS }),
  status: async (id) => (await budgetedRead(ctx.journal, repo, credential, budgetPolicy(ctx.config), new Date(),
   () => graphNode(repo, id, credential, { timeoutMs: GRAPH_CALL_TIMEOUT_MS }))).status,
 };
}

function machineScribeGraph(ctx: ImplementContext): ScribeGraph {
 const repo = ctx.map.repo;
 const credential = { token: ctx.token, source: "write-token" };
 return {
  add: (parent, spec) => graphAdd(repo, parent, spec, ctx.token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS }),
  link: (node, parent, blockedBy) => graphLink(repo, node, parent, ctx.token, { timeoutMs: GRAPH_CALL_TIMEOUT_MS, blockedBy }),
  node: (id) => budgetedRead(ctx.journal, repo, credential, budgetPolicy(ctx.config), new Date(),
   () => graphNode(repo, id, credential, { timeoutMs: GRAPH_CALL_TIMEOUT_MS })),
 };
}

/** What one Scribe filing after a merge came to: the filed node, or why it failed. */
export type ScribeOutcome = { node: string } | { error: string };

/** The Scribe's filings after a merge; a key is absent when there was nothing to file. */
export interface ScribeFilings {
 review?: ScribeOutcome | { proseLeft: number };
 /** `unread` when the merge's diff could not be read: nothing was scanned. */
 landmines?: (ScribeOutcome & { count: number }) | { unread: string };
}

/** The findings a review round left: every severity sage counts. */
function leftFindings(r: { blockers: number; majors: number; nits: number }): number {
 return r.blockers + r.majors + r.nits;
}

const ROUND_IMPACT = /^Round impact: behavior (\d+), checks (\d+), prose \d+; unclassified impact (\d+)/gm;

function leftWork(r: { blockers: number; majors: number; nits: number; body: string }): number {
 const lines = [...r.body.matchAll(ROUND_IMPACT)];
 const asked = lines.length === 0 ? r.nits : lines.reduce((n, m) => n + Number(m[1]) + Number(m[2]) + Number(m[3]), 0);
 return r.blockers + r.majors + asked;
}

/**
 * The Scribe's pass after a merge (design §6, node #24), before the close so
 * the receipt can cite what it filed: the last sage round's findings
 * (split-out-of-review, only when it left a blocker, a major, or a behavior,
 * check or unclassified finding by sage's round-impact lines, or any finding
 * when the round has none) and the marker comments the merge commit added
 * (code-comment-graduated), each one `propose` node below this node. A
 * prose-only round files nothing: its nits stay on the change, journalled and
 * named in the receipt. Best effort: a failed filing is journalled and
 * named in the receipt, and the close goes on. A superseded supervisor stops
 * here (FencedError).
 */
export async function scribeAfterMerge(
 ctx: ImplementContext,
 pr: Pick<ChangeRequest, "iid" | "webUrl" | "mergeCommitSha">,
 final: RecordedReview | undefined,
): Promise<ScribeFilings> {
 const { journal, map } = ctx;
 const nodeId = ctx.node.ref.id;
 const graph = ctx.scribe ?? machineScribeGraph(ctx);
 const fence = () => journal.assertGeneration(nodeId, map.repo, ctx.generation, "file discovered work");
 const spawning = { id: nodeId, title: ctx.node.node.title };
 const change = { number: pr.iid, url: changeRequestUrl(map.repo, pr.iid, pr.webUrl) };
 const file = async (provenance: Provenance, what: string, spec: () => AddSpec): Promise<ScribeOutcome> => {
  try {
   const filed = await scribeFile(graph, journal, { map, parent: nodeId, provenance, spec: spec() }, fence);
   journal.recordEvent("filed", {
    nodeId, repo: map.repo,
    detail: `${filed.added ? "filed" : "already filed"} ${what} as node #${filed.node} below #${nodeId} (${provenance})`.slice(0, 400),
   });
   return { node: filed.node };
  } catch (error) {
   if (error instanceof FencedError) throw error;
   const message = error instanceof Error ? error.message : String(error);
   journal.recordEvent("filed", { nodeId, repo: map.repo, detail: `filing ${what} (${provenance}) FAILED: ${message}`.slice(0, 400) });
   return { error: message.slice(0, 300) };
  }
 };
 const filings: ScribeFilings = {};
 if (final !== undefined && leftWork(final) > 0) {
  filings.review = await file("split-out-of-review", "the last review's findings", () => splitOutOfReviewSpec(map.repo, spawning, change, final));
 } else if (final !== undefined && final.nits > 0) {
  filings.review = { proseLeft: final.nits };
  journal.recordEvent("filed", {
   nodeId, repo: map.repo,
   detail: `left the last review's ${final.nits} nit(s) on ${changeRequestLabel(map.repo, pr.iid)} (${change.url}), not filed (prose only: no blocker, major, behavior or check finding)`.slice(0, 400),
  });
 }
 const merge = pr.mergeCommitSha;
 if (merge !== null) {
  let landmines;
  try {
   landmines = await landminesInMerge(ctx.canonical, merge);
  } catch (error) {
   const message = error instanceof Error ? error.message : String(error);
   journal.recordEvent("filed", { nodeId, repo: map.repo, detail: `reading the merge's marker comments FAILED: ${message}`.slice(0, 400) });
   return { ...filings, landmines: { unread: message.slice(0, 300) } };
  }
  if (landmines.length > 0) {
   const outcome = await file("code-comment-graduated", `${landmines.length} marker comment(s)`, () => codeCommentSpec(map.repo, spawning, change, merge, landmines));
   filings.landmines = { ...outcome, count: landmines.length };
  }
 }
 return filings;
}

/** The marker comments a merge commit added over its first parent (the base before the merge). */
async function landminesInMerge(canonical: string, sha: string): Promise<ReturnType<typeof landminesInDiff>> {
 const diff = await safeGit(["diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-textconv", `${sha}^1`, sha, "--"], { cwd: canonical });
 if (diff.code !== 0) throw new Error(`git diff ${sha.slice(0, 8)}^1 exited ${diff.code}: ${diff.stderr.trim().slice(0, 200)}`);
 return landminesInDiff(diff.stdout);
}

/** The found-by-probe filing for one probe: the Scribe's template (design §6). */
export function fixNodeSpec(ctx: ImplementContext, probe: string, checks: string[], sha: string, pr: { number: number; url: string }): AddSpec {
 return foundByProbeSpec(ctx.map.repo, ctx.map.base, ctx.node.ref, probe, checks, sha, pr);
}

/** The note's suffix when the filing lock was lost while a write ran. */
function leaseLost(owned: () => void): string {
 try {
  owned();
  return "";
 } catch {
  return " (the filing lock was lost during the write; recorded anyway, check for a duplicate fix node)";
 }
}

/**
 * The narrow found-by-probe filer (node #109's ruling, ahead of the Scribe):
 * a probe confirmed red at the merge base, by this comparison or by the
 * cache, files one `propose` build node below the detecting node. The map's
 * record skips a probe already filed for this merge base (open or closed,
 * without a read), and a probe whose fix node from an earlier base is still
 * open. The cache hit is what lets a second map on the same base file its
 * own node.
 *
 * Each (map, probe) is filed under a cross-process lease (`fix-node-lock.ts`)
 * held from the record read to the record write, so two overlapping runs
 * do not both add (short of a holder suspended past its lease). Up to
 * FIX_NODE_FILING_CONCURRENCY probes file at once, each under its own lease,
 * so the wait is the slowest probe, not the sum. A run that waits past FIX_NODE_LOCK_TIMEOUT_MS journals
 * the skip and leaves the probe to the holder, or, if the holder's add
 * failed, to the next confirmation. The lease and the worker generation are
 * fenced before each add and link (a superseded worker journals the stop and
 * files no further probe), not after: a node that exists is recorded even when the lease was
 * lost during its write, and the note says so. An add that created its node
 * but left it unattached is recorded as such, and the next confirmation
 * links that node below the parent it was filed under instead of adding
 * another. Any other failed add (or failed status read or link) is
 * journalled and retried the next time the probe is found red at a merge
 * base.
 *
 * Two windows are left: a run that dies between a successful add and its
 * record write, and an add killed or timed out with no payload (the node id
 * is unknown). Either can leave one untracked node for the next
 * confirmation to duplicate. Never throws: certification and the inherited
 * verdict do not depend on it. Writes and reads run under the machine token.
 */
/** Probes filed at once: each holds its own lease, so one slow add does not hold up the rest. */
export const FIX_NODE_FILING_CONCURRENCY = 4;

export async function fileBaseRedFixNodes(
 ctx: ImplementContext,
 base: Pick<BaseProbeResult, "sha" | "confirmed"> & { cached?: string[] },
 pr: { number: number; url: string },
): Promise<void> {
 const { journal, map } = ctx;
 const nodeId = ctx.node.ref.id;
 const graph = ctx.fixNode ?? machineFixNodeGraph(ctx);
 const note = (detail: string) => journal.recordEvent("reviewed", { nodeId, repo: map.repo, detail: detail.slice(0, 400) });
 // A superseded worker files nothing more: the lease wait and the status read both await.
 const fence = () => journal.assertGeneration(nodeId, map.repo, ctx.generation, "file a fix-the-base node");
 let superseded = false;
 const fileOne = async (probe: string) => {
  const key = baseRedFixKey(map, probe);
  try {
   await withFixNodeLock(journal, key, async (owned) => {
    const raw = journal.getHealth(key);
    const prior = fixRecord(raw);
    // Created but unattached: attach it where it was filed, never add a second.
    if (prior?.unattached !== undefined) {
     owned();
     fence();
     await graph.link(prior.node, prior.unattached.parent);
     const { attached: _attached, parent: _parent, ...record } = JSON.parse(raw!) as Record<string, unknown>;
     journal.setHealth(key, JSON.stringify(record));
     note(`attached fix-the-base node #${prior.node} for ${probe} below #${prior.unattached.parent}${leaseLost(owned)}`);
     return;
    }
    // Filed for this merge base already: a closed node there means the fix landed after it.
    if (prior?.sha === base.sha) return;
    if (prior !== null) {
     const status = await graph.status(prior.node);
     if (status !== "closed") {
      note(`fix-the-base node #${prior.node} for ${probe} is ${status} — not filing another`);
      return;
     }
    }
    const checks = [...(cachedBaseChecks(journal, baseRedChecksKey(map.repo, base.sha, probe)) ?? [])].sort();
    const record = { sha: base.sha, detectedBy: nodeId, pr: pr.number };
    owned();
    fence();
    try {
     const spec = fixNodeSpec(ctx, probe, checks, base.sha, pr);
     assertFilable(map, nodeId, spec);
     const filed = await graph.add(nodeId, spec);
     journal.setHealth(key, JSON.stringify({ node: filed.node, ...record }));
     note(`filed fix-the-base node #${filed.node} below #${nodeId}: ${probe} red at the merge base ${base.sha.slice(0, 8)}${leaseLost(owned)}`);
    } catch (error) {
     if (error instanceof GraphAddUnattached) {
      journal.setHealth(key, JSON.stringify({ node: error.node, ...record, attached: false, parent: nodeId }));
     }
     throw error;
    }
   });
  } catch (error) {
   if (error instanceof FencedError) {
    superseded = true;
    note(`fix-the-base filing for ${probe} at ${base.sha.slice(0, 8)} stopped: ${error.message}`);
    return;
   }
   if (error instanceof FixNodeLockBusy) {
    note(`fix-the-base filing for ${probe} at ${base.sha.slice(0, 8)} skipped: another run is filing it (${error.message})`);
    return;
   }
   const unattached = error instanceof GraphAddUnattached ? ` — node #${error.node} is recorded and is attached below #${error.parent} the next time, not filed again` : "";
   note(`fix-the-base filing for ${probe} at ${base.sha.slice(0, 8)} failed (retried the next time it is found red at a merge base)${unattached}: ${error instanceof Error ? error.message : String(error)}`);
  }
 };
 const probes = [...new Set([...base.confirmed, ...(base.cached ?? [])])];
 let next = 0;
 const lane = async () => {
  while (!superseded && next < probes.length) await fileOne(probes[next++]);
 };
 await Promise.all(Array.from({ length: Math.min(FIX_NODE_FILING_CONCURRENCY, probes.length) }, lane));
}

/**
 * The probe record on the PR. A failed run's probes, kinds and checks come
 * first, in a code block (probe output is the branch's text: no mentions or
 * markup), then the output's tail. The whole output of every run, the retry
 * and the merge-base run included, is in the worker log it names by file;
 * `log` is null when a write failed, and the record says so instead.
 */
function probeComment(
 repo: string,
 command: string,
 p: RecordedProbe,
 attempts: number,
 result: RunResult,
 failing: string[],
 log: string | null,
): string {
 const out = (result.stdout + (result.stderr ? `\n${result.stderr}` : "")).trim();
 const clipped = out.length > 20_000 ? `…${out.slice(-20_000)}` : out;
 return [
  probeMarker(p),
  `**Probes — ${p.passed ? "passed" : "failed"}** at \`${p.sha.slice(0, 8)}\` (selection ${p.mode}, ${p.selected} probe(s); ${attempts} run(s))${baseRedNote(repo, p)}`,
  "",
  ...(failing.length === 0
   ? []
   : [
      "Failing:",
      "",
      "```",
      ...failing.map((line) => line.replaceAll("`", "'")),
      "```",
      "",
      log === null
       ? "Ranger could not write its worker log for every run (the journal's log-failed events say why): the tail below is all the record keeps."
       : `The full output of every run is in ranger's worker log \`${log}\`.`,
      "",
     ]),
  `\`${command}\``,
  "",
  "<details><summary>output</summary>",
  "",
  "```",
  clipped,
  "```",
  "</details>",
 ].join("\n");
}

/**
 * The branch the lane works on. A declared `git-merged-into` probe names the
 * branch the close checks, so it wins; otherwise the worktree branch.
 */
export function implementBranchFor(
 node: { probes?: { type: string; ref?: string }[] },
 fallback: string,
): string {
 const merged = (node.probes ?? []).find(
  (p) => p.type === "git-merged-into" && typeof p.ref === "string" && p.ref.length > 0,
 );
 return merged?.ref ?? fallback;
}

/**
 * The paths the node's close gate checks on this map's base after the merge:
 * its `artifact-exists` probes on this repo, read at the base (or, with no
 * `atRef`, on the canonical checkout's disk, which the close fast-forwards to
 * the base). A probe on another repo or ref is not this branch's to satisfy.
 */
export function checkpointArtifacts(
 node: { probes?: { type: string; [key: string]: unknown }[] },
 repo: string,
 base: string,
): string[] {
 const atBase = (ref: unknown) =>
  ref === undefined || ref === base || ref === `origin/${base}` || ref === `refs/heads/${base}`;
 const paths = (node.probes ?? []).flatMap((p) =>
  p.type === "artifact-exists" &&
  typeof p.path === "string" &&
  p.path.length > 0 &&
  (p.repo === undefined || p.repo === repo) &&
  atBase(p.atRef)
   ? [p.path]
   : [],
 );
 return [...new Set(paths)];
}

/** The checkpoint artifacts `sha`'s tree lacks: a merge of it would leave the close refusing (ranger #263, 2026-10-14). */
async function missingArtifacts(worktree: string, sha: string, paths: string[]): Promise<string[]> {
 const missing: string[] = [];
 for (const path of paths) {
  const found = await safeGit(["cat-file", "-e", `${sha}:${path.replace(/^\.\//, "")}`], { cwd: worktree, timeoutMs: 10_000 });
  if (found.code !== 0) missing.push(path);
 }
 return missing;
}

/**
 * A sage-clean review whose head lacks a checkpoint artifact gets the
 * supervisor's major on top: the fix pass answers it and the next round
 * reviews the result, as any major. Without it ranger merged ranger #263's
 * PR, whose tests went to another file than the one its checkpoint names, and
 * the close then refused after the merge.
 */
export function withArtifactFinding<R extends { majors: number; body: string }>(review: R, missing: string[], base: string): R {
 if (missing.length === 0) return review;
 const list = missing.map((p) => `\`${p}\``).join(", ");
 return {
  ...review,
  majors: review.majors + 1,
  body: [
   review.body.trim(),
   "",
   "## Supervisor finding (ranger, not the reviewer) — major",
   `The node's close gate checks that ${list} exist${missing.length === 1 ? "s" : ""} on \`${base}\` after the merge, and this head lacks ${missing.length === 1 ? "it" : "them"}.`,
   "Create each at exactly that path (moving this node's tests or code there is fine); the close refuses the node otherwise.",
  ].join("\n"),
 };
}

/** The credential the lane's graph reads run under: the gated one a GitLab map needs, else the write token. */
function graphCredential(ctx: ImplementContext): ResolvedToken {
 return ctx.graphToken ?? { token: ctx.token, source: "write-token" };
}

/**
 * The review gate a change request passes before ranger readies it: sage on
 * GitHub. GitLab has none until *Settle the review gate a ranger-built GitLab
 * MR must pass before ranger merges it* (ranger#96) lands its build (ranger
 * issue #97, "Review"), so null, and the lane holds the node at
 * awaiting-review. An injected reviewer is the test seam on either forge.
 */
function reviewGate(ctx: ImplementContext): Reviewer | null {
 if (ctx.reviewer !== undefined) return ctx.reviewer;
 return parseForgeRef(ctx.map.repo).forge === "github" ? sageReview : null;
}

/** Resolve where to pick up, from GitHub first (F2). */
export function resolvePhase(pr: ChangeRequest | null): ImplementPhase | "pr-closed" {
 if (pr === null) return "implement";
 if (pr.state === "merged") return "close";
 if (pr.state === "closed") return "pr-closed";
 return "review";
}

async function tryCarryReview(ctx: ImplementContext, reviews: RecordedReview[], live: ChangeRequest): Promise<RecordedReview | undefined> {
 const previous = reviews.at(-1);
 if (previous === undefined || gatingFindings(previous) !== 0) return undefined;
 const { map, journal, node, worktree } = ctx;
 const proof = await baseOnlyMergePatchId(worktree, map.base, previous.sha, live.headSha);
 if ("refused" in proof) {
  journal.recordEvent("reviewed", { nodeId: node.ref.id, repo: map.repo, detail: `review carry refused from ${previous.sha} to ${live.headSha}: ${proof.refused}` });
  return undefined;
 }
 const body = `Review carried from \`${previous.sha}\` to \`${live.headSha}\`: base-only merges with unchanged stable patch-id \`${proof.patchId}\` and matching whitespace-sensitive patch-id.\n\n${previous.body}`;
 journal.assertGeneration(node.ref.id, map.repo, ctx.generation, "carry review");
 const github = ctx.github ?? lanePort(ctx.config, map.repo);
 await github.postComment(map.repo, live.iid, `${reviewMarker(previous.round, { ...previous, commitId: live.headSha }, previous.substrate, previous.sha)}\n${body}`, ctx.token);
 journal.recordEvent("review-carried", { nodeId: node.ref.id, repo: map.repo, detail: `round ${previous.round} carried from ${previous.sha} to ${live.headSha}; patch-id ${proof.patchId}` });
 return { ...previous, sha: live.headSha, carried: previous.sha, body };
}

export async function runImplement(ctx: ImplementContext): Promise<ImplementOutcome> {
 const { config, map, journal, node, token, botIdentity, branch, worktree } = ctx;
 const github = ctx.github ?? lanePort(config, map.repo);
 const reviewer = reviewGate(ctx);
 const repo = map.repo;
 const nodeId = node.ref.id;
 const base = map.base;
 const fence = (action: string) =>
  journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, action);

 const testCommand = map.commands.test;
 if (testCommand === undefined) {
  return {
   status: "refused",
   detail: `map ${repo} declares no commands.test — the implement lane will not push untested work`,
   workerExit: null,
  };
 }

 // F2 resume: the recorded PR first (a head-branch lookup misses a PR whose
 // branch was deleted on merge), then the PR found by head branch.
 const recorded = journal.getWorker(nodeId, ctx.map.repo)?.prNumber ?? null;
 let pr =
  recorded === null
   ? await github.findPrByHead(repo, branch, token)
   : await github.getPr(repo, recorded, token);
 const phase = resolvePhase(pr);
 if (node.status === "closed") return finishClosedElsewhere({ ...ctx, pr });
 journal.recordEvent("worker-start", {
  nodeId,
  repo,
  detail: `implement lane resumes at phase ${phase} (branch ${branch}${pr === null ? "" : `, ${changeRequestLabel(repo, pr.iid)}`})`,
 });

 if (phase === "pr-closed") {
  throw new ParkSignal(
   `${changeRequestLabel(repo, pr?.iid ?? "?")} for ${branch} was closed without merging — a human declined it; ranger will not reopen or re-propose it`,
  );
 }
 if (phase === "close") {
  return closeAfterMerge(ctx, github, pr as ChangeRequest);
 }

 // ---- implement ----
 let workerExit: number | null = null;
 if (phase === "implement") {
  journal.updateWorker(nodeId, ctx.map.repo, { phase: "implement" });
  // Before the install, so it installs what the moved base declares.
  const caughtUp = await catchUpWithBase(ctx, testCommand);
  if (caughtUp?.failure !== undefined) return caughtUp.failure;
  if (!remoteTests(ctx) && map.commands.install !== undefined) {
   const install = await runShell(map.commands.install, worktree, ctx, { label: "install", timeoutMs: INSTALL_TIMEOUT_MS });
   if (install.code !== 0) {
    return {
     status: "failed",
     detail: `install (${map.commands.install}) exited ${install.code}: ${tail(install)}`,
     workerExit: caughtUp?.workerExit ?? null,
    };
   }
  }
  // Work an earlier run built and committed, but never pushed, is adopted
  // when it passes the supervisor's checks (#691: its tests failed under
  // load; a fresh worker would find nothing to commit and fail again).
  const built = (await adoptBuiltWork(ctx, testCommand)) ?? (await workerPass(ctx, testCommand, { kind: "build" }));
  workerExit = built.workerExit;
  if (built.failure !== undefined) return built.failure;

  fence("push");
  await assertRemotePush(ctx, built.sha);
  const vetted = await vettedPush({
   worktree,
   canonical: ctx.canonical,
   branch,
   credential: gitCredential(repo, token),
   configSnapshot: built.snapshot,
   ...(remoteTests(ctx) ? { source: built.sha } : {}),
  });
  recordKnownGood(journal, ctx.canonical, vetted, "vetted push");
  journal.recordEvent("pushed", { nodeId, repo, detail: `${branch} @ ${built.sha.slice(0, 8)}` });
  // Review selection reads who wrote a head. Every session records its own
  // commit as it makes it (checkedWorkerPass); an adopted build keeps that
  // record and is never credited to this run's substrate.
  if (built.adopted !== true) recordHead(ctx, built.sha);

  const title = prTitle(ctx);
  const body = refuseClosingKeyword(ctx, `the draft ${changeRequestNoun(repo)} description`, draftBody(ctx));
  fence("open PR");
  pr = await github.createDraftPr(
   repo,
   { head: branch, base, title, body },
   token,
  );
  journal.updateWorker(nodeId, ctx.map.repo, { phase: "review", prNumber: pr.iid });
  await awaitHead(github, repo, pr.iid, built.sha, token, ctx.headPollMs);
  journal.recordEvent("pr-opened", { nodeId, repo, detail: `${changeRequestLabel(repo, pr.iid)} (draft) ${pr.webUrl}` });
 }

 // ---- review loop ----
 const open = pr as ChangeRequest;
 journal.updateWorker(nodeId, ctx.map.repo, { phase: "review", prNumber: open.iid });
 const opening = await github.listComments(repo, open.iid, token);
 let reviews = recordedReviews(opening, botIdentity);
 // A base merge pass moves the head without a finding to answer: each one
 // that landed in the PR's head grants the round that reviews the merged
 // branch. A marker whose merge was never pushed (a crash between the two)
 // grants nothing and uses up none of the node's merge passes.
 const openingHead = (await github.getPr(repo, open.iid, token)).headSha;
 let baseMerges = await landedBaseMerges(worktree, recordedBaseMerges(opening, botIdentity), openingHead);
 // A CI fix pass grants its round the same way.
 let ciFixes = ciFixState(recordedCiFixes(opening, botIdentity), openingHead).used;
 let probeFixes = ciFixState(recordedProbeFixes(opening, botIdentity), openingHead).used;
 const capNow = () => config.workers.reviewRounds + baseMerges + ciFixes + probeFixes;
 let probe: RecordedProbe | undefined;
 // The head whose set-aside major is already journaled: once per head per
 // run, as the loop re-reads an unchanged head on every pass.
 let notedSha: string | undefined;
 let staleMerged = false;
 const artifacts = checkpointArtifacts(node.node, repo, base);
 /**
  * One base merge pass on the pushed head, then its marker and its push. A
  * failed pass is the run's outcome. `stale` says the branch was merged up
  * for being far behind its base, not for a conflict.
  */
 const mergeBaseIn = async (pushedHead: string, stale?: StaleBase): Promise<ImplementOutcome | undefined> => {
  const merged = await baseMergePass(ctx, testCommand, { kind: "pushed", head: pushedHead }, stale);
  workerExit = merged.workerExit;
  if (merged.failure !== undefined) return merged.failure;
  // The marker first: a merged head pushed without one would read as an
  // unreviewed head at the cap. A marker whose push never happens counts
  // for nothing (landedBaseMerges), so a crash between them costs nothing.
  fence("record the base merge");
  await github.postComment(repo, open.iid, baseMergeMarker(merged.sha, base, stale), token);
  await publishPass(
   ctx,
   github,
   open.iid,
   merged,
   "push base merge",
   `base merge pass ${baseMerges + 1} @ ${merged.sha.slice(0, 8)}: ${baseMergeWhy(base, stale)}`,
  );
  baseMerges += 1;
  return undefined;
 };
 /**
  * A sage-clean, mergeable head whose CI is red goes back to a worker
  * (soma #795/#796 parked for good on a deterministic red). CI tests the
  * branch merged into its base, so when the base moved at all it is merged
  * in first; otherwise a CI fix pass reads the failed runs' logs. A CI that
  * is pending, green, unreadable or red for no code's fault goes on to
  * ready, and the merge desk reads it there. "again" re-reads the new head.
  */
 const ciStep = async (head: string): Promise<"ready" | "again" | ImplementOutcome> => {
  let ci: CiVerdict;
  try {
   ci = await github.ciVerdictFor(repo, head, token);
  } catch (error) {
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: `CI at ${head.slice(0, 8)} not read (${String(error).slice(0, 200)}): it goes ready, and the merge desk reads CI there`,
   });
   return "ready";
  }
  if (!workerFixableCi(ci)) return "ready";
  const recorded = ciFixState(recordedCiFixes(await github.listComments(repo, open.iid, token), botIdentity), head);
  if (recorded.foundNothing) return "ready";
  // This run's own count bounds the loop too, whatever the PR's markers say.
  const used = Math.max(recorded.used, ciFixes);
  if (used >= MAX_CI_FIXES) {
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: `CI is red at ${head.slice(0, 8)} (${ci.reason}), but the node has used its ${MAX_CI_FIXES} CI fix pass(es): it goes ready, and the merge desk parks it`.slice(0, 400),
   });
   return "ready";
  }
  if (baseMerges < MAX_BASE_MERGES) {
   // The fetch carries the write credential: the state must still be the known-good one (node #81).
   await trustedSnapshot(journal, ctx.canonical, { repo, nodeId }, mapKey(map));
   await fastForwardCanonical(ctx.canonical, base, gitCredential(repo, token));
   const behind = await commitsBehind(worktree, base);
   if (behind > 0) return (await mergeBaseIn(head, { behind, limit: 0, ciRed: ci.reason })) ?? "again";
  }
  const log = github.ciFailureLog === undefined
   ? ""
   : await github.ciFailureLog(repo, ci.failed, token).catch((error: unknown) => `(logs not read: ${String(error).slice(0, 200)})`);
  journal.recordEvent("reviewed", {
   nodeId,
   repo,
   detail: `CI is red at ${head.slice(0, 8)} (${ci.reason}) — a CI fix pass reads the failed runs' logs`.slice(0, 400),
  });
  const rulings = principalRulings(await github.listComments(repo, open.iid, token), principalLoginForRepo(config, repo));
  const fixed = await workerPass(ctx, testCommand, { kind: "ci-fix", red: head, reason: ci.reason, log, rulings });
  workerExit = fixed.workerExit;
  if (fixed.failure !== undefined) return fixed.failure;
  // The marker first, as a base merge's: a fix pushed without one would
  // read as an unreviewed head at the cap.
  fence("record the CI fix");
  if (fixed.unchanged === true) {
   await github.postComment(repo, open.iid, ciFixMarker({ sha: head, red: head, reason: ci.reason }), token);
   journal.recordEvent("reviewed", { nodeId, repo, detail: `CI fix pass at ${head.slice(0, 8)} found nothing in the branch to change: it goes ready, and the merge desk parks it` });
   return "ready";
  }
  await github.postComment(repo, open.iid, ciFixMarker({ sha: fixed.sha, red: head, reason: ci.reason }), token);
  await publishPass(ctx, github, open.iid, fixed, "push CI fix", `CI fix pass ${used + 1} @ ${fixed.sha.slice(0, 8)}: CI was red at ${head.slice(0, 8)}`);
  ciFixes += 1;
  return "again";
 };
 const probeTierOrFixPass = async (head: string): Promise<"ready" | "again" | ImplementOutcome> => {
  const tier = await probeFinalHead(ctx, github, open.iid);
  probe = tier.record;
  const failure = tier.failure;
  if (failure === undefined) return "ready";
  if (failure.branchFixable.length === 0) throw new ParkSignal(failure.parkOutcome);
  const recorded = ciFixState(recordedProbeFixes(await github.listComments(repo, open.iid, token), botIdentity), head);
  const used = Math.max(recorded.used, probeFixes);
  if (recorded.foundNothing || used >= MAX_PROBE_FIXES) {
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: (recorded.foundNothing
     ? `probes still fail at ${head.slice(0, 8)}, where a probe fix pass found nothing in the branch to change: it parks`
     : `probes still fail at ${head.slice(0, 8)} (${failure.branchFixable.join(", ")}), but the node has used its ${MAX_PROBE_FIXES} probe fix pass(es): it parks`).slice(0, 400),
   });
   throw new ParkSignal(failure.parkOutcome);
  }
  journal.recordEvent("reviewed", {
   nodeId,
   repo,
   detail: `probes failed at ${head.slice(0, 8)} on the branch's own ${failure.branchFixable.join(", ")} — a probe fix pass gets the failures`.slice(0, 400),
  });
  const rulings = principalRulings(await github.listComments(repo, open.iid, token), principalLoginForRepo(config, repo));
  const fixed = await workerPass(ctx, testCommand, { kind: "probe-fix", red: head, failed: failure.branchFixable, summary: failure.failureSummary, rulings });
  workerExit = fixed.workerExit;
  if (fixed.failure !== undefined) return fixed.failure;
  fence("record the probe fix");
  if (fixed.unchanged === true) {
   await github.postComment(repo, open.iid, probeFixMarker({ sha: head, red: head, failed: failure.branchFixable }), token);
   journal.recordEvent("reviewed", { nodeId, repo, detail: `probe fix pass at ${head.slice(0, 8)} found nothing in the branch to change: it parks` });
   throw new ParkSignal(failure.parkOutcome);
  }
  await github.postComment(repo, open.iid, probeFixMarker({ sha: fixed.sha, red: head, failed: failure.branchFixable }), token);
  await publishPass(ctx, github, open.iid, fixed, "push probe fix", `probe fix pass ${used + 1} @ ${fixed.sha.slice(0, 8)}: probes failed at ${head.slice(0, 8)}`);
  probeFixes += 1;
  probe = undefined;
  return "again";
 };
 for (;;) {
  const cap = capNow();
  const live = await github.getPr(repo, open.iid, token);
  // Whatever reviews or fixes this head works on a tree at it (ranger issue #228).
  await syncWorktreeToHead(ctx, open.iid, live.headSha);
  // A branch far behind its base is merged up before anything reviews or
  // probes it (ranger issue #231): reds the base already fixed would park it
  // again. Once per run, and only on the pushed head: unpushed work in the
  // worktree is adoptBuiltWork's to judge first, and the merge pass resets
  // to the pushed head.
  if (!staleMerged && (await headSha(worktree)) === live.headSha) {
   const behind = await commitsBehind(worktree, base);
   // A head the merge desk sent back because no CI ran on it merges in any
   // base commit it lacks: the push is what starts CI (noCiStep).
   const noCi = journal.listCiAbsent(repo, nodeId).some((s) => s.head === live.headSha && s.step === "sent-back");
   const limit = noCi ? 0 : config.workers.maxBehindBase;
   if (behind > limit) {
    staleMerged = true;
    // A merge up counts against the same budget as a conflict's: past it,
    // the branch is reviewed as it is, and the journal says how far behind.
    if (baseMerges >= MAX_BASE_MERGES) {
     journal.recordEvent("reviewed", {
      nodeId,
      repo,
      detail: `${branch} is ${behind} commit(s) behind origin/${base} (limit ${limit}), but the node has used its ${MAX_BASE_MERGES} base merge pass(es): it goes on as it is`,
     });
    } else {
     const failed = await mergeBaseIn(live.headSha, { behind, limit });
     if (failed !== undefined) return failed;
     continue;
    }
   }
  }
  let current = reviewAtHead(reviews, live.headSha);
  if (current === undefined && reviewer !== null) {
   current = await tryCarryReview(ctx, reviews, live);
   if (current !== undefined) reviews = [...reviews, current];
  }
  const superseded = supersededNote(reviews, live.headSha);
  if (superseded !== null && notedSha !== live.headSha) {
   journal.recordEvent("reviewed", { nodeId, repo, detail: superseded });
   notedSha = live.headSha;
  }
  if (current === undefined) {
   // No review gate on this forge yet: the change request stays a draft,
   // off the merge desk, and the park card is the escalation.
   if (reviewer === null) {
    journal.updateWorker(nodeId, ctx.map.repo, { phase: "awaiting-review" });
    throw new ParkSignal(gitlabReviewHoldOutcome({ repo, pr: open.iid }));
   }
   const rounds = reviewRounds(reviews);
   if (rounds >= cap) {
    throw new ParkSignal(reviewCapHeadMovedOutcome({ repo, rounds, pr: open.iid }));
   }
   const round = rounds + 1;
   fence("review");
   const { substrate: reviewSubstrate, chosenOn } = await selectReviewSubstrate(ctx, live.headSha, round);
   // The sage round is a substrate session (node #56): its row opens under
   // the generation fence once selection has settled (selection awaits, and
   // the generation can move meanwhile), and ends with the cap confirmation,
   // so a capped review is recorded as capped.
   const reviewed = await recordSession(
    journal,
    { substrate: reviewSubstrate, kind: "review", repo, nodeId, generation: ctx.generation },
    async (openSession): Promise<{ verdict: ReviewVerdict } | { error: ReviewError; cap: CapSignal | null }> => {
     openSession();
     try {
      return {
       verdict: await reviewer(repo, open.iid, ctx.readOnlyToken, {
        substrate: reviewSubstrate,
        nice: config.workers.niceness,
        reviewAuthor: botIdentity,
       }),
      };
     } catch (error) {
      if (!(error instanceof ReviewError)) throw error;
      return { error, cap: await confirmCap(reviewSubstrate, journal, { readers: ctx.substrateReaders }) };
     }
    },
    (r) => ("verdict" in r ? "ok" : failedSessionOutcome(r.error.message, r.cap)),
   );
   if (!("verdict" in reviewed)) {
    // A review that failed on its substrate's limit resumes elsewhere; any
    // other review failure is an ordinary one.
    if (reviewed.cap === null) throw reviewed.error;
    return {
     status: "failed",
     detail: `sage review round ${round} on ${reviewSubstrate} hit its rate limit: ${reviewed.error.message.slice(0, 300)}`,
     workerExit,
     prNumber: open.iid,
     substrateCapped: reviewed.cap,
    };
   }
   const verdict = reviewed.verdict;
   if (verdict.commitId !== live.headSha) {
    throw new ParkSignal(
     `sage reviewed ${verdict.commitId.slice(0, 8)} but ${changeRequestLabel(repo, open.iid)}'s head is ${live.headSha.slice(0, 8)} — the head moved during review`,
    );
   }
   fence("post review");
   await github.postComment(
    repo,
    open.iid,
    reviewComment(round, verdict, reviewSubstrate),
    token,
   );
   current = {
    round,
    sha: verdict.commitId,
    blockers: verdict.blockers,
    majors: verdict.majors,
    nits: verdict.nits,
    substrate: reviewSubstrate,
    body: verdict.body,
   };
   reviews = [...reviews, current];
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: `round ${round} @ ${verdict.commitId.slice(0, 8)}: ${verdict.verdict}, ${verdict.blockers} blocker(s), ${verdict.majors} major(s)${chosenOn}`,
   });
  }
  journal.updateWorker(nodeId, ctx.map.repo, {
   reviewRound: current.round,
   verdictSha: current.sha,
   verdictBlockers: current.blockers,
  });
  if (gatingFindings(current) === 0 && artifacts.length > 0) {
   const missing = await missingArtifacts(worktree, live.headSha, artifacts);
   if (missing.length > 0) {
    current = withArtifactFinding(current, missing, base);
    journal.recordEvent("reviewed", {
     nodeId,
     repo,
     detail: `sage clean at ${live.headSha.slice(0, 8)}, but the checkpoint artifact(s) ${missing.join(", ")} are missing there: a supervisor major goes to the fix pass`.slice(0, 400),
    });
   }
  }
  // Blockers AND majors gate (principal, 2026-10-03): each is reworked and
  // re-reviewed. Suggestions and nits do not gate.
  if (gatingFindings(current) === 0) {
   // Sage-clean. Before the probes certify this head, it must merge: GitHub
   // runs no CI on a conflicting PR, so a conflict found only at the merge
   // desk waits forever (seelite #692).
   if (!(await conflictsWithBase(ctx, github, open.iid))) {
    const step = await ciStep(live.headSha);
    const probed = step === "ready" && map.commands.probe !== undefined ? await probeTierOrFixPass(live.headSha) : step;
    if (probed === "ready") break;
    if (probed === "again") continue;
    return probed;
   }
   if (baseMerges >= MAX_BASE_MERGES) {
    throw new ParkSignal(baseConflictOutcome({ repo, pr: open.iid, base, passes: baseMerges }));
   }
   const failed = await mergeBaseIn(live.headSha);
   if (failed !== undefined) return failed;
   continue;
  }
  if (current.round >= cap) {
   throw new ParkSignal(
    reviewCapOutcome({ repo, blockers: current.blockers, majors: current.majors, round: current.round, pr: open.iid }),
   );
  }
  // A push that landed after the review read the head (a principal's session)
  // makes the review answer a tree the branch no longer has: the loop goes
  // round again, syncs, and reviews the new head (ranger issue #228).
  const after = await github.getPr(repo, open.iid, token);
  if (after.headSha !== live.headSha) {
   journal.recordEvent("reviewed", {
    nodeId,
    repo,
    detail: `${changeRequestLabel(repo, open.iid)}'s head moved from ${live.headSha.slice(0, 8)} to ${after.headSha.slice(0, 8)} after round ${current.round} read it: no fix pass answers a review of a head the branch no longer has`,
   });
   continue;
  }
  // One fix pass per review that found blockers or majors. On a resume the review is
  // re-read from its PR comment, so a crash between review and fix loses nothing,
  // and a fix an earlier run committed but never pushed is adopted, as a build is.
  // The principal's rulings are read right before a worker runs: one posted
  // during the review binds this pass, not the next (ranger issue #230).
  const readRulings = async (): Promise<string[]> =>
   principalRulings(await github.listComments(repo, open.iid, token), principalLoginForRepo(config, repo));
  const fixed =
   (await adoptBuiltWork(ctx, testCommand, { round: current.round, pushedHead: live.headSha })) ??
   (await workerPass(ctx, testCommand, { kind: "fix", round: current.round, body: current.body, rulings: await readRulings() }));
  workerExit = fixed.workerExit;
  if (fixed.failure !== undefined) return fixed.failure;
  await publishPass(ctx, github, open.iid, fixed, "push fix", `fix pass ${current.round} @ ${fixed.sha.slice(0, 8)}`);
 }

 // The run-node awake hold covers this informational capture step too.
 const final = reviews[reviews.length - 1];
 let labels: string[] = [];
 try { if (map.commands.views) labels = await github.issueLabels(repo, Number(nodeId), token); }
 catch (error) {
  journal.recordEvent("reviewed", { nodeId, repo, detail: `views label lookup failed (informational): ${String(error).slice(-500)}` });
 }
 if (labels.includes(NEEDS_EYE_LABEL)) {
  let record: ViewsRecord | undefined;
  try {
   record = await captureViews({
    map, nodeId, sha: final.sha, labels,
    probePassed: probe?.passed === true && probe.sha === final.sha,
    journalPath: journal.path, worktree,
    env: workerEnv(config, repo, ctx.sessionJournal, ctx.commitAuthor), dependencies: ctx.viewsDependencies,
   });
  } catch (error) {
   record = { sha: final.sha, status: "failed", reason: redactViewsReason(String(error), workerEnv(config, repo, ctx.sessionJournal, ctx.commitAuthor)) };
   try { saveViewsRecord(viewsDirectory(journal.path, repo, nodeId, final.sha), record); } catch { /* best effort */ }
  }
  if (record !== undefined) {
   fence("post the views record");
   try {
    const comments = await github.listComments(repo, open.iid, token);
    const body = viewsComment(record, viewsDirectory(journal.path, repo, nodeId, final.sha));
    if (!comments.some(c => c.author === botIdentity && c.body === body)) {
     await github.postComment(repo, open.iid, body, token);
    }
   } catch (error) {
    journal.recordEvent("reviewed", { nodeId, repo, detail: `views comment failed (informational): ${String(error).slice(-500)}` });
   }
  }
 }

 // ---- ready → awaiting merge ----
 fence("mark ready");
 const body = refuseClosingKeyword(ctx, `the ready ${changeRequestNoun(repo)} description`, readyBody(ctx, final, reviewRounds(reviews), probe));
 await github.updatePrBody(repo, open.iid, body, token);
 await github.markReady(repo, await github.getPr(repo, open.iid, token), token);
 journal.updateWorker(nodeId, ctx.map.repo, {
  status: "awaiting-merge",
  phase: "awaiting-merge",
  workerPgid: null,
 });
 journal.recordEvent("awaiting-merge", {
  nodeId,
  repo,
  detail: `${changeRequestLabel(repo, open.iid)} ready; sage clean at ${final.sha.slice(0, 8)} — the merge card follows once CI is green`,
 });
 return {
  status: "awaiting-merge",
  detail: `${changeRequestLabel(repo, open.iid)} is ready and waits on the principal's merge`,
  workerExit,
  prNumber: open.iid,
 };
}

/** Base merge passes one node gets before a still-conflicting branch parks. */
const MAX_BASE_MERGES = 2;

interface BaseMergeInput {
 base: string;
 /** The files a trial merge reported as conflicting (the worker's starting point). */
 files: string[];
 /** Set when the branch is merged up for trailing its base, not for a conflict (ranger issue #231). */
 stale?: StaleBase;
}

/** The base is informational: any ref name the config accepts must still parse. */
const BASE_MERGE_MARKER = /<!-- ranger:base-merge sha=([0-9a-f]{7,64})(?: base=[^\s>]*)? -->/;

/**
 * A branch merged up for trailing its base (ranger issue #231): how far, and
 * the configured limit. `ciRed` is set when CI was red at the head: CI tests
 * the branch merged into its base, so any drift can be the cause, and the
 * limit does not apply.
 */
export interface StaleBase {
 behind: number;
 limit: number;
 ciRed?: string;
}

/** Why a base merge pass ran, in the words the marker, the journal and the push detail share. */
export function baseMergeWhy(base: string, stale?: StaleBase): string {
 if (stale === undefined) return `origin/${base} conflicted with the branch`;
 if (stale.ciRed !== undefined) return `CI was red (${stale.ciRed.slice(0, 200)}) and the branch was ${stale.behind} commit(s) behind origin/${base}`;
 return `the branch was ${stale.behind} commit(s) behind origin/${base} (limit ${stale.limit})`;
}

export function baseMergeMarker(sha: string, base: string, stale?: StaleBase): string {
 return `<!-- ranger:base-merge sha=${sha} base=${base} -->\n**Base merge** — ${baseMergeWhy(base, stale)}, so a worker merged it in at \`${sha.slice(0, 8)}\`. The next sage round reviews the merged branch.`;
}

/** Base merge passes recorded on the PR by the MACHINE ACCOUNT (anyone else's markers are ignored). */
export function recordedBaseMerges(comments: IssueComment[], botIdentity: string): { sha: string }[] {
 const out: { sha: string }[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(BASE_MERGE_MARKER);
  if (m !== null) out.push({ sha: m[1] });
 }
 return out;
}

/**
 * CI fix passes one node gets before a red CI parks at the merge desk. A
 * dedicated budget, like the base merges', rather than a share of the review
 * rounds: a PR that used its rounds on sage findings would otherwise get no
 * CI fix at all. Each fix that lands grants the sage round reviewing it.
 */
export const MAX_CI_FIXES = 2;

const CI_FIX_MARKER = /<!-- ranger:ci-fix sha=([0-9a-f]{7,64}) red=([0-9a-f]{7,64}) -->/;

/** One recorded CI fix pass: the red head it answered and the commit it made (`sha === red`: it changed nothing). */
export interface CiFixRecord {
 sha: string;
 red: string;
}

export function ciFixMarker(r: CiFixRecord & { reason: string }): string {
 const what = r.sha === r.red
  ? "and a worker found nothing in the branch to change. Ranger leaves it for the principal: rerun CI if it is flaky."
  : `so a worker fixed it at \`${r.sha.slice(0, 8)}\`. The next sage round reviews the fix.`;
 return `<!-- ranger:ci-fix sha=${r.sha} red=${r.red} -->\n**CI fix pass** — CI was red at \`${r.red.slice(0, 8)}\` (${r.reason.slice(0, 300)}), ${what}`;
}

function recordedFixes(comments: IssueComment[], botIdentity: string, marker: RegExp): CiFixRecord[] {
 const out: CiFixRecord[] = [];
 for (const c of comments) {
  if (c.author !== botIdentity) continue;
  const m = c.body.match(marker);
  if (m !== null) out.push({ sha: m[1], red: m[2] });
 }
 return out;
}

/** CI fix passes recorded on the PR by the MACHINE ACCOUNT (anyone else's markers are ignored). */
export function recordedCiFixes(comments: IssueComment[], botIdentity: string): CiFixRecord[] {
 return recordedFixes(comments, botIdentity, CI_FIX_MARKER);
}

/**
 * Probe fix passes one node gets before probes that still fail on the
 * branch's own account park it. Its own budget, like the CI fixes': the
 * marker on the PR carries it across a run-node restart, and each fix that
 * lands grants the sage round reviewing it.
 */
export const MAX_PROBE_FIXES = 1;

const PROBE_FIX_MARKER = /<!-- ranger:probe-fix sha=([0-9a-f]{7,64}) red=([0-9a-f]{7,64}) -->/;

export function probeFixMarker(r: CiFixRecord & { failed: string[] }): string {
 const what = r.sha === r.red
  ? "and a worker found nothing in the branch to change. Ranger leaves it for the principal."
  : `so a worker fixed it at \`${r.sha.slice(0, 8)}\`. The next sage round reviews the fix, and the probes run again.`;
 return `<!-- ranger:probe-fix sha=${r.sha} red=${r.red} -->\n**Probe fix pass** — probes failed at \`${r.red.slice(0, 8)}\` on this branch (${r.failed.filter((n) => PROBE_FILE.test(n)).join(", ")}), ${what}`;
}

/** Probe fix passes recorded on the PR by the MACHINE ACCOUNT (anyone else's markers are ignored). */
export function recordedProbeFixes(comments: IssueComment[], botIdentity: string): CiFixRecord[] {
 return recordedFixes(comments, botIdentity, PROBE_FIX_MARKER);
}

/**
 * What the recorded CI (or probe) fix passes leave at `head`. `used` counts the fixes
 * that moved the branch off a red head; a marker whose red head is still the
 * head was never pushed (a crash between the two) and counts for nothing.
 * `foundNothing`: a pass already ran at this head and changed nothing, so no
 * other one runs there.
 */
export function ciFixState(fixes: CiFixRecord[], head: string): { used: number; foundNothing: boolean } {
 return {
  used: new Set(fixes.filter((f) => f.sha !== f.red && f.red !== head).map((f) => f.red)).size,
  foundNothing: fixes.some((f) => f.sha === f.red && f.red === head),
 };
}

/**
 * A red CI a worker may fix: a run concluded `failure`. A cancelled,
 * timed-out or unnamed red is no code's fault, and stays the principal's.
 */
export function workerFixableCi(ci: CiVerdict): ci is Extract<CiVerdict, { state: "red" | "pending" }> & { failed: CiFailedRun[] } {
 return ci.state === "red" && (ci.failed ?? []).some((f) => f.conclusion === "failure");
}

/** How many recorded base merges landed: their merge commit is in the PR's head. */
async function landedBaseMerges(worktree: string, merges: { sha: string }[], head: string): Promise<number> {
 let landed = 0;
 for (const { sha } of new Map(merges.map((m) => [m.sha, m])).values()) {
  const inside = await safeGit(["merge-base", "--is-ancestor", sha, head], { cwd: worktree, timeoutMs: 30_000 });
  if (inside.code === 0) landed += 1;
 }
 return landed;
}

/** Push a pass's commits through the vetted push, record them, and wait for GitHub to show the head. */
async function publishPass(
 ctx: ImplementContext,
 github: ForgePort,
 prNumber: number,
 pass: PassResult,
 action: string,
 detail: string,
): Promise<void> {
 ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, action);
 await assertRemotePush(ctx, pass.sha);
 const vetted = await vettedPush({
  worktree: ctx.worktree,
  canonical: ctx.canonical,
  branch: ctx.branch,
  credential: gitCredential(ctx.map.repo, ctx.token),
  configSnapshot: pass.snapshot,
  ...(remoteTests(ctx) ? { source: pass.sha } : {}),
 });
 recordKnownGood(ctx.journal, ctx.canonical, vetted, "vetted push");
 ctx.journal.recordEvent("pushed", { nodeId: ctx.node.ref.id, repo: ctx.map.repo, detail });
 // An adopted pass keeps the record of the session that wrote it.
 if (pass.adopted !== true) recordHead(ctx, pass.sha);
 await awaitHead(github, ctx.map.repo, prNumber, pass.sha, ctx.token, ctx.headPollMs);
}

/**
 * Whether GitHub says the PR conflicts with its base. GitHub computes
 * mergeability lazily after a push, so an unknown answer is polled for a
 * while; one that stays unknown reads as no conflict, and the merge gate
 * asks again before any merge.
 */
async function conflictsWithBase(ctx: ImplementContext, github: ForgePort, prNumber: number): Promise<boolean> {
 const { pollMs, attempts } = ctx.mergeablePoll ?? { pollMs: 5_000, attempts: 12 };
 for (let i = 0; i < attempts; i++) {
  const pr = await github.getPr(ctx.map.repo, prNumber, ctx.token);
  if (pr.mergeState !== "pending") {
   return pr.mergeState === "conflict";
  }
  if (i < attempts - 1) await new Promise((r) => setTimeout(r, pollMs));
 }
 return false;
}

/**
 * Bring the worktree to the change request's live head before anything
 * reviews or works on it (ranger issue #228). A principal's session or
 * another agent can push to the branch while the node is parked; a resumed
 * worker on the old tree would answer a review of the new head by editing
 * code that head no longer has.
 *
 * - At the head already: nothing to do, and no fetch.
 * - The head is inside the worktree's HEAD (an earlier run committed and
 *   never pushed): left as it is, for `adoptBuiltWork` to judge.
 * - The worktree's HEAD is inside the head and the tree is clean: fetched
 *   and fast-forwarded, and the journal records both SHAs.
 * - Anything else (the worktree has commits the head lacks, or uncommitted
 *   changes): parks naming both SHAs and the dirty paths, and changes
 *   nothing in the worktree.
 */
async function syncWorktreeToHead(ctx: ImplementContext, prNumber: number, prHead: string): Promise<void> {
 const { worktree, journal, branch } = ctx;
 const repo = ctx.map.repo;
 const nodeId = ctx.node.ref.id;
 const here = await headSha(worktree);
 if (here === prHead) return;
 const label = changeRequestLabel(repo, prNumber);
 if (!/^[0-9a-f]{40}$/.test(prHead)) {
  throw new ParkSignal(`${label}'s head is unknown ("${prHead}"), and the worktree is at ${here.slice(0, 8)}: ranger will not work on a tree it cannot match to the head`);
 }
 const haveHead = async () =>
  (await safeGit(["cat-file", "-e", `${prHead}^{commit}`], { cwd: worktree, timeoutMs: 10_000 })).code === 0;
 // The head inside the worktree's HEAD needs no fetch: the head is already
 // here. It is unpushed work on top of the head (adoptBuiltWork judges it),
 // unless HEAD was itself pushed and the branch then rewound under it: then
 // origin/<branch>, as ranger's last push left it (nothing fetched yet),
 // still holds HEAD, and pushing it again would undo the rewind (sage round
 // 2 on PR #234).
 if ((await haveHead()) && (await isAncestor(worktree, prHead, here))) {
  const tracked = await safeGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], { cwd: worktree, timeoutMs: 10_000 });
  const pushedTip = tracked.stdout.trim();
  if (tracked.code === 0 && /^[0-9a-f]{40}$/.test(pushedTip) && (await isAncestor(worktree, here, pushedTip))) {
   throw new ParkSignal(
    `${label}'s head went back to ${prHead.slice(0, 8)}, behind the worktree (${here.slice(0, 8)}), which ranger had pushed: someone rewound ${branch}. ` +
     `Nothing was changed and nothing is pushed over the rewind; reset the worktree or the branch, then resume`,
   );
  }
  return;
 }
 // The fetch carries the write credential: the state must still be the known-good one (node #81).
 await trustedSnapshot(journal, ctx.canonical, { repo, nodeId }, mapKey(ctx.map));
 await fetchBranch(ctx.canonical, branch, gitCredential(repo, ctx.token));
 if (!(await haveHead())) {
  throw new ParkSignal(
   `${label}'s head ${prHead.slice(0, 8)} is not on origin/${branch} after a fetch, and the worktree is at ${here.slice(0, 8)}: nothing was changed`,
  );
 }
 if (await isAncestor(worktree, prHead, here)) return;
 const dirty = await dirtyFiles(worktree);
 const dirtyNote = dirty.length === 0 ? "" : `; uncommitted: ${dirty.slice(0, 20).map((l) => l.trim()).join(", ")}${dirty.length > 20 ? ` (+${dirty.length - 20} more)` : ""}`;
 if (!(await isAncestor(worktree, here, prHead))) {
  throw new ParkSignal(
   `the worktree (${here.slice(0, 8)}) has commits ${label}'s head (${prHead.slice(0, 8)}) does not contain: someone pushed to ${branch} while this tree held unpushed work${dirtyNote}. ` +
    `Nothing was changed; merge or drop one side, then resume`,
  );
 }
 if (dirty.length > 0) {
  throw new ParkSignal(
   `${label}'s head moved to ${prHead.slice(0, 8)}, past the worktree (${here.slice(0, 8)}), but the worktree has uncommitted changes${dirtyNote}. Nothing was changed; commit or discard them, then resume`,
  );
 }
 journal.assertGeneration(nodeId, repo, ctx.generation, "fast-forward the worktree to the PR head");
 const ff = await safeGit(["merge", "--ff-only", prHead], { cwd: worktree, timeoutMs: 60_000 });
 if (ff.code !== 0) {
  throw new GitSafetyError(`cannot fast-forward ${worktree} from ${here.slice(0, 8)} to ${prHead.slice(0, 8)}: ${ff.stderr.trim()}`);
 }
 journal.recordEvent("worktree-synced", {
  nodeId,
  repo,
  detail: `worktree fast-forwarded from ${here} to ${label}'s head ${prHead}: pushed to ${branch} from outside this run`,
 });
}

/**
 * Bring a resumed node's branch up to its base before anything adopts or
 * builds on it, when there is no PR yet (node #310). `bootstrapWorktree`
 * reuses a worktree as it stands: soma #829 was resumed on a tree 17 commits
 * behind a base that had already fixed what it parked on, and a worker
 * session went on it.
 *
 * - Not behind origin/<base> as fetched: nothing to do.
 * - Changes in the tree (anything but the blocked report a session leaves
 *   untracked): left as it is, for `adoptBuiltWork` and the build pass to
 *   judge as before, and the journal says how far behind it stays.
 * - No commits of its own: fast-forwarded to origin/<base>, no worker
 *   session, and the journal records both SHAs and the count.
 * - Commits of its own, more than workers.maxBehindBase behind: one base
 *   merge pass on the local HEAD (ranger issue #231's pass); the adoption
 *   tests or the build pass then see the merged branch.
 * - Commits of its own within the limit: left as it is.
 */
async function catchUpWithBase(ctx: ImplementContext, testCommand: string): Promise<PassResult | undefined> {
 const { worktree, journal, map, branch } = ctx;
 const repo = map.repo;
 const nodeId = ctx.node.ref.id;
 const base = map.base;
 const baseSha = await fetchBaseTrusted(ctx);
 const behind = await commitsBehind(worktree, base);
 if (behind === 0) return undefined;
 const dirty = (await dirtyFiles(worktree)).filter((l) => l !== `?? ${BLOCKED_REPORT_FILE}`);
 if (dirty.length > 0) {
  journal.recordEvent("worktree-not-synced", {
   nodeId,
   repo,
   detail: `${branch} is ${behind} commit(s) behind origin/${base}, but the worktree has uncommitted changes (${dirty.slice(0, 5).map((l) => l.trim()).join(", ")}): it is not moved`.slice(0, 400),
  });
  return undefined;
 }
 const ahead = await commitsAhead(worktree, base);
 if (ahead === 0) {
  const here = await headSha(worktree);
  journal.assertGeneration(nodeId, repo, ctx.generation, "fast-forward the worktree to the base");
  const ff = await safeGit(["merge", "--ff-only", baseSha], { cwd: worktree, timeoutMs: 60_000 });
  if (ff.code !== 0) {
   throw new GitSafetyError(`cannot fast-forward ${worktree} from ${here.slice(0, 8)} to origin/${base} (${baseSha.slice(0, 8)}): ${ff.stderr.trim()}`);
  }
  journal.recordEvent("worktree-synced", {
   nodeId,
   repo,
   detail: `worktree fast-forwarded from ${here} to origin/${base} ${baseSha}: ${branch} had no commits of its own and was ${behind} commit(s) behind origin/${base}`,
  });
  return undefined;
 }
 const limit = ctx.config.workers.maxBehindBase;
 if (behind <= limit) return undefined;
 return baseMergePass(ctx, testCommand, { kind: "local", baseSha }, { behind, limit });
}

/**
 * Fetch the base into the canonical clone and return origin/<base>'s commit
 * as fetched, read before any worker runs: the worker shares the repository
 * and could move the ref itself. The fetch carries the write credential, so
 * the git state must still be the known-good one (node #81).
 */
async function fetchBaseTrusted(ctx: ImplementContext): Promise<string> {
 const base = ctx.map.base;
 await trustedSnapshot(ctx.journal, ctx.canonical, { repo: ctx.map.repo, nodeId: ctx.node.ref.id }, mapKey(ctx.map));
 await fastForwardCanonical(ctx.canonical, base, gitCredential(ctx.map.repo, ctx.token));
 const fetched = await safeGit(["rev-parse", "--verify", `refs/remotes/origin/${base}^{commit}`], {
  cwd: ctx.canonical,
  timeoutMs: 10_000,
 });
 const baseSha = fetched.stdout.trim();
 if (fetched.code !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
  throw new GitSafetyError(`cannot resolve origin/${base} after the fetch: ${fetched.stderr.trim()}`);
 }
 return baseSha;
}

/**
 * The files `git merge-tree` reports as conflicting between the branch and
 * origin/<base>: a hint for the worker's prompt, empty when git cannot say.
 */
async function conflictingFiles(worktree: string, base: string): Promise<string[]> {
 const trial = await safeGit(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", `origin/${base}`], {
  cwd: worktree,
  timeoutMs: 60_000,
 });
 if (trial.code !== 1) return [];
 return trial.stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).slice(0, 20);
}

/** Where a base merge pass starts: the PR's pushed head, or a local HEAD with no PR yet (node #310). */
type MergeFrom = { kind: "pushed"; head: string } | { kind: "local"; baseSha: string };

/**
 * One worker pass that merges the moved base into the branch. The supervisor
 * fetches the base first (the worker holds no credential); the worker merges
 * and resolves; the supervisor's own checks then require a clean tree,
 * passing tests, and origin/<base> actually inside the branch.
 *
 * `from` names where the merge starts:
 * - `pushed`: the PR's pushed head. The worktree is reset to it first, and
 *   the pass fetches the base itself.
 * - `local` (no PR yet, node #310): the local HEAD, whose commits were never
 *   pushed and must not be reset away; the caller has checked the tree clean
 *   and fetched the base (`baseSha`). A pass that commits nothing leaves the
 *   tree as it found it, and one that exited 0 so parks: the conflict stands.
 */
async function baseMergePass(ctx: ImplementContext, testCommand: string, from: MergeFrom, stale?: StaleBase): Promise<PassResult> {
 const base = ctx.map.base;
 const start = from.kind === "pushed" ? from.head : await headSha(ctx.worktree);
 const resetTo = async (sha: string, why: string) => {
  for (const args of [["reset", "--hard", sha], ["clean", "-fd"]]) {
   // Fenced before EACH destructive command: a replacement run can take the
   // node over while the previous one awaits.
   ctx.journal.assertGeneration(ctx.node.ref.id, ctx.map.repo, ctx.generation, `git ${args[0]} ${why}`);
   const r = await safeGit(args, { cwd: ctx.worktree, timeoutMs: 60_000 });
   if (r.code !== 0) throw new GitSafetyError(`cannot reset ${ctx.worktree} to ${sha.slice(0, 8)} (git ${args[0]}): ${r.stderr.trim()}`);
  }
 };
 // Start from what GitHub has: an earlier run may have merged locally and
 // crashed before its push, and that unpushed state is neither vetted nor
 // reviewed. The pass redoes the merge on the pushed head — only while this
 // supervisor still owns the node: a superseded one must not erase a newer
 // run's work.
 if (from.kind === "pushed") await resetTo(from.head, "before a base merge");
 const baseSha = from.kind === "pushed" ? await fetchBaseTrusted(ctx) : from.baseSha;
 const files = await conflictingFiles(ctx.worktree, base);
 ctx.journal.recordEvent("reviewed", {
  nodeId: ctx.node.ref.id,
  repo: ctx.map.repo,
  detail:
   stale === undefined
    ? `${changeRequestNoun(ctx.map.repo)} conflicts with origin/${base}${files.length > 0 ? ` in ${files.join(", ")}` : ""} — a worker merges it in`
    : `${ctx.branch}: ${baseMergeWhy(base, stale)}${files.length > 0 ? `, conflicting in ${files.join(", ")}` : ""} — a worker merges it in before any review or probe run`,
 });
 const pass = await workerPass(ctx, testCommand, { kind: "base-merge", base, files, ...(stale === undefined ? {} : { stale }) });
 if (from.kind === "local" && (await headSha(ctx.worktree)) === start) {
  // Nothing committed on a tree that was clean: what the worker left is a
  // half-done merge, and the next run must not build on it.
  await resetTo(start, "after a base merge that committed nothing");
  if (pass.failure !== undefined && pass.workerExit === 0 && pass.failure.substrateCapped === undefined) {
   throw new ParkSignal(
    `base merge pass committed nothing, and origin/${base} as fetched (${baseSha.slice(0, 8)}) is not in ${ctx.branch} — the conflict stands${files.length > 0 ? ` in ${files.join(", ")}` : ""}; the worktree is back at ${start.slice(0, 8)} and nothing was pushed`,
   );
  }
 }
 if (pass.failure !== undefined) return pass;
 const inside = await safeGit(["merge-base", "--is-ancestor", baseSha, "HEAD"], {
  cwd: ctx.worktree,
  timeoutMs: 30_000,
 });
 if (inside.code !== 0) {
  throw new ParkSignal(
   `base merge pass committed, but origin/${base} as fetched (${baseSha.slice(0, 8)}) is not in ${ctx.branch} — the conflict stands; nothing was pushed`,
  );
 }
 return pass;
}

interface PassResult {
 workerExit: number | null;
 snapshot: string;
 sha: string;
 failure?: ImplementOutcome;
 /** The commits were adopted from an earlier run, not written by this run's worker. */
 adopted?: boolean;
 /** A CI or probe fix pass that exited 0 and committed nothing: the red is not the branch's to fix. */
 unchanged?: boolean;
}

/**
 * Cross-model review selection (node #45): prefer a substrate other than the
 * one that wrote the head; an unrecorded head counts as Pi's. Substrates
 * capped earlier in this run are left out, so a review never re-picks one
 * whose capped-until has lapsed meanwhile. A round whose number is a multiple
 * of substrates.pi.reviewEvery runs on Pi by rotation, whatever the quota.
 */
async function selectReviewSubstrate(
 ctx: ImplementContext,
 headSha: string,
 round: number,
): Promise<{ substrate: SubstrateName; chosenOn: string }> {
 const author = ctx.journal.headSubstrate(ctx.map.repo, headSha) ?? "pi";
 const every = ctx.config.substrates.pi.reviewEvery;
 const rotation = isPiReviewTurn(round, every);
 const { substrate, chosenOn } = await selectSubstrate(ctx.journal, {
  config: ctx.config.substrates,
  excluded: ctx.excludedSubstrates ?? new Set<SubstrateName>(),
  readers: ctx.substrateReaders,
  pick: (input) => (rotation ? "pi" : selectForReview(input, author)),
 });
 const why = rotation ? `Pi rotation (pi.reviewEvery ${every}); ` : "";
 return { substrate, chosenOn: ` on ${substrate} (head by ${author}; ${why}${chosenOn})` };
}

/** Which substrate wrote a pushed SHA: the review of that head reads it back. */
function recordHead(ctx: ImplementContext, sha: string): void {
 if (ctx.substrate === undefined) return;
 ctx.journal.recordHeadSubstrate({
  sha,
  repo: ctx.map.repo,
  nodeId: ctx.node.ref.id,
  substrate: ctx.substrate,
 });
}

/** What a worker session is for: the build, a fix pass answering a sage round, a red CI or failed probes, or a base merge. */
type WorkerPassSpec =
 | { kind: "build" }
 | { kind: "fix"; round: number; body: string; rulings: string[] }
 | { kind: "ci-fix"; red: string; reason: string; log: string; rulings: string[] }
 | { kind: "probe-fix"; red: string; failed: string[]; summary: string[]; rulings: string[] }
 | ({ kind: "base-merge" } & BaseMergeInput);

/** The pass's name in logs, events and outcomes. */
function passLabel(spec: WorkerPassSpec): string {
 switch (spec.kind) {
  case "build":
   return "build pass";
  case "fix":
   return `fix pass ${spec.round}`;
  case "ci-fix":
   return "CI fix pass";
  case "probe-fix":
   return "probe fix pass";
  case "base-merge":
   return "base merge pass";
 }
}

/** Why a pass that exited 0 without a new commit failed. */
function nothingCommitted(spec: WorkerPassSpec): string {
 switch (spec.kind) {
  case "build":
   return "worker exited 0 but committed nothing — nothing to push";
  case "fix":
   return `fix pass ${spec.round} committed nothing — the blockers stand`;
  case "ci-fix":
   return `CI fix pass committed nothing — CI stays red at ${spec.red.slice(0, 8)}`;
  case "probe-fix":
   return `probe fix pass committed nothing — the probes stay red at ${spec.red.slice(0, 8)}`;
  case "base-merge":
   return `base merge pass committed nothing — the conflict with origin/${spec.base} stands`;
 }
}

/**
 * One worker session (build, fix or base merge), recorded as a substrate
 * session (node #56) that ends once the supervisor's own checks have judged
 * it. A RANGER_WORKER_CMD session runs on a substrate ranger cannot know, so
 * it is not recorded.
 */
async function workerPass(ctx: ImplementContext, testCommand: string, spec: WorkerPassSpec): Promise<PassResult> {
 const nodeId = ctx.node.ref.id;
 if (ctx.substrate === undefined) {
  return checkedWorkerPass(ctx, testCommand, spec, () =>
   ctx.journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "spawn the worker"),
  );
 }
 return recordSession(
  ctx.journal,
  {
   substrate: ctx.substrate,
   kind: spec.kind === "build" ? "worker" : "fix-pass",
   repo: ctx.map.repo,
   nodeId,
   generation: ctx.generation,
   model: ctx.model ?? null,
  },
  (open) => checkedWorkerPass(ctx, testCommand, spec, open),
  (pass) =>
   pass.failure === undefined ? "ok" : failedSessionOutcome(pass.failure.detail, pass.failure.substrateCapped),
 );
}

/**
 * The worker session itself, then the supervisor's own test + keyword checks.
 * `fenceSpawn` runs right before the spawn: the generation fence, which for
 * a recorded substrate also opens the session row (node #56), so a pass
 * superseded during the awaits before it neither spawns nor records a session.
 */
async function checkedWorkerPass(
 ctx: ImplementContext,
 testCommand: string,
 spec: WorkerPassSpec,
 fenceSpawn: () => void,
): Promise<PassResult> {
 const { config, map, journal, node, worktree, branch, botIdentity } = ctx;
 const nodeId = node.ref.id;
 // Checked against the known-good state, not just read (node #81): a state
 // changed since the supervisor last saw it clean is never this pass's baseline.
 const snapshot = await trustedSnapshot(journal, ctx.canonical, { repo: map.repo, nodeId }, mapKey(map));
 const before = await headSha(worktree);
 // origin/<base> as the supervisor holds it before the worker runs: the base
 // a failing test is compared with (node #164) is never a ref the worker or
 // its tests could have moved.
 const baseRef = await safeGit(["rev-parse", "--verify", `refs/remotes/origin/${map.base}^{commit}`], { cwd: worktree, timeoutMs: 30_000 });
 const baseTip = baseRef.code === 0 && /^[0-9a-f]{40}$/.test(baseRef.stdout.trim()) ? baseRef.stdout.trim() : null;
 const prompt = assembleImplementPrompt({
  repo: map.repo,
  node: {
   id: nodeId,
   title: node.node.title,
   body: node.body ?? "",
   kind: node.node.kind,
   autonomy: node.node.autonomy,
   checkpointId: node.node.checkpointId,
   url: node.url,
  },
  map: { title: ctx.rootNode.node.title, body: ctx.rootNode.body ?? "" },
  branch,
  worktree,
  botIdentity,
  testCommand,
  ...(spec.kind === "fix" ? { review: { round: spec.round, body: spec.body }, rulings: spec.rulings } : {}),
  ...(spec.kind === "ci-fix" ? { ciFix: { head: spec.red, reason: spec.reason, log: spec.log, base: map.base }, rulings: spec.rulings } : {}),
  ...(spec.kind === "probe-fix" ? { probeFix: { head: spec.red, failed: spec.failed, summary: spec.summary }, rulings: spec.rulings } : {}),
  ...(spec.kind === "base-merge" ? { baseMerge: { base: spec.base, files: spec.files, ...(spec.stale === undefined ? {} : { stale: spec.stale }) } } : {}),
  probeTier: map.commands.probe !== undefined,
  remoteTests: remoteTests(ctx),
  artifacts: checkpointArtifacts(node.node, map.repo, map.base),
 });
 // Only this session's blocked report counts, never one a crashed run left.
 discardBlockedReport(worktree);
 fenceSpawn();
 const output = workerOutputFor(ctx.substrate);
 const raw = await ctx.workerRun(prompt, {
  cwd: worktree,
  timeoutMs: config.workers.wallClockMin * 60_000,
  nice: config.workers.niceness,
  env: workerEnv(config, map.repo, ctx.sessionJournal, ctx.commitAuthor),
  ...output.runOptions,
  processGroup: true,
  onSpawn: (pgid) => journal.updateWorker(nodeId, ctx.map.repo, { workerPgid: pgid }),
 });
 journal.updateWorker(nodeId, ctx.map.repo, { workerPgid: null });

 // Read on the substrate's own output format (node #45): a Claude stream's
 // quota readings are cached, and its signal lines feed the cap check.
 const { result, lines } = output.read(raw, journal);

 const pass = passLabel(spec);
 const log = logRun(ctx, pass, result) ?? "not written, see the journal";
 // Before ANY git call after the worker: a tampered config or hook would run
 // with whatever the next git call carries.
 await assertGitUntouched(ctx.canonical, snapshot);

 const fail = (detail: string, substrateCapped?: CapSignal): PassResult => ({
  workerExit: result.code,
  snapshot,
  sha: before,
  failure: {
   status: "failed",
   detail: `${detail} (worker log: ${log})`,
   workerExit: result.code,
   ...(substrateCapped === undefined ? {} : { substrateCapped }),
  },
 });
 const stopped = hookStopReason(result.stdout, lines);
 if (stopped !== null) throw new ParkSignal(policyBlockedOutcome({ pass, reason: stopped, log }));
 // The worker said the node cannot be done yet: park on its reason, before
 // any commit it made is tested or pushed.
 const blocked = result.code === 0 ? readBlockedReport(worktree) : null;
 if (blocked !== null) throw await blockedPark(ctx, pass, blocked, { dropNote: (await blockerNoteBranch(worktree, map.base)) !== null, log });
 if (result.code !== 0) {
  // Mid-session cap (node #45): only the substrate's own signal says so, and
  // only a failed run can be one. A capped failure does not count.
  const capSignal: CapSignal | null =
   ctx.substrate === undefined
    ? null
    : await confirmCap(ctx.substrate, journal, { lines, stderr: result.stderr, readers: ctx.substrateReaders });
  if (capSignal !== null) return fail(substrateCappedOutcome(capSignal), capSignal);
  return fail(`worker exited ${result.code}: ${tail(result)}`);
 }
 // A base merge brings in the base's manifests and lockfile: the tests must
 // run on its dependencies, not the ones installed for the old base. It runs
 // before the commit and clean-tree checks, so an install that rewrites a
 // tracked file (a lockfile, generated source) fails the pass rather than
 // letting the tests certify content that never gets pushed.
 if (!remoteTests(ctx) && spec.kind === "base-merge" && map.commands.install !== undefined) {
  const install = await runShell(map.commands.install, worktree, ctx, { label: `${pass}: install`, timeoutMs: INSTALL_TIMEOUT_MS });
  if (install.code !== 0) {
   return fail(`install (${map.commands.install}) after the base merge exited ${install.code}: ${tail(install)}`);
  }
 }
 const sha = await headSha(worktree);
 // A CI fix pass may find the red is not the branch's (a flaky test, a
 // runner outage): it commits nothing, and that is an answer, not a failure.
 if ((spec.kind === "ci-fix" || spec.kind === "probe-fix") && sha === before && (await dirtyFiles(worktree)).length === 0) {
  return { workerExit: result.code, snapshot, sha, unchanged: true };
 }
 if (sha === before || (await commitsAhead(worktree, map.base)) === 0) {
  return fail(nothingCommitted(spec));
 }
 if (spec.kind === "build") {
  const note = await blockerNoteBranch(worktree, map.base);
  if (note !== null) throw await blockedPark(ctx, pass, note, { dropNote: true, log });
 }
 // This session wrote `sha`: record it now, so a later run that adopts the
 // commit unpushed still credits the substrate that actually wrote it.
 recordHead(ctx, sha);
 // The supervisor tests the working tree but pushes commits: a dirty tree
 // would let a green test run cover code that never lands.
 const dirty = await dirtyFiles(worktree);
 if (dirty.length > 0) {
  return fail(
   `worker left ${dirty.length} uncommitted or untracked file(s) (${dirty.slice(0, 5).join("; ")}) — the tests would not test what gets pushed`,
  );
 }
 const { tests, retried, baseRed, busy } = await supervisorTests(ctx, testCommand, pass, baseTip);
 // The retry ran on a busy host too and failed: the host's failure, not the
 // branch's. No fix pass, no failed node: the run parks and a resume waits
 // for a quiet host (node #297); the resume adopts this pass's commits.
 if (tests.code !== 0 && busy !== undefined) throw hostLoadPark(ctx, busy, `the supervisor's tests (${testCommand}) after the ${pass}`, tests);
 if (tests.code !== 0 && baseRed === undefined) return fail(testsFailedDetail(testCommand, tests, "after the worker"));
 if (retried || baseRed !== undefined) {
  // The pass was certified in a fresh clone, or its failures are the base's:
  // the worktree still holds what the failed run left, and the probes run
  // there next.
  const restored = await restoreWorktree(ctx, sha);
  if (restored !== null) return fail(restored);
 }
 // The tests ran worker-written code: the state must still be the vetted one
 // before it counts as seen clean.
 const clean = await assertGitUntouched(ctx.canonical, snapshot);
 recordKnownGood(journal, ctx.canonical, clean, `passing ${pass}`);
 await assertNoClosingKeywords(worktree, map.base, parseForgeRef(map.repo).forge);
 // Only a pass that goes on to the push puts its waived tests in the receipts.
 if (baseRed !== undefined) recordTestsBaseRed(journal, map.repo, ctx.node.ref.id, { head: sha, base: baseRed.sha, names: baseRed.names, rest: baseRed.rest });
 return { workerExit: result.code, snapshot, sha };
}

/**
 * The park for a worker that reported the node blocked, or whose build is
 * only a blocker note (`dropNote`: the caller found the branch is). Before
 * any PR, a branch that holds nothing but the note goes back to its base: it was never pushed, the outcome keeps the
 * note's reason and condition, and a resume once the condition holds must
 * start a fresh build, not adopt the note and park again.
 */
async function blockedPark(
 ctx: ImplementContext,
 pass: string,
 report: BlockedReport,
 opts: { dropNote: boolean; log?: string },
): Promise<ParkSignal> {
 const { worktree, map, journal, node } = ctx;
 let outcome = blockedOutcome({ pass, ...report, ...(opts.log === undefined ? {} : { log: opts.log }) });
 const unpushed = (journal.getWorker(node.ref.id, map.repo)?.prNumber ?? null) === null;
 if (unpushed && opts.dropNote) {
  const base = await safeGit(["--no-replace-objects", "merge-base", `origin/${map.base}`, "HEAD"], { cwd: worktree, timeoutMs: 10_000 });
  const failed = base.code === 0 ? await restoreWorktree(ctx, base.stdout.trim()) : `no merge base with origin/${map.base}`;
  if (failed !== null) outcome += ` — the note's commits stay in the worktree (${failed}): drop them before a resume`;
 }
 return new ParkSignal(outcome);
}

/**
 * A repo command (install/test/probe) — it executes worker-written code, so it
 * runs in the worker's env (no credential) and its own process group. Its
 * whole output goes to the node's worker log under `label`, pass or fail
 * (node #107: #478 and #691 kept only a tail of passing tests, and the
 * evidence took a 30-minute rerun to recover).
 */
async function runShell(
 command: string,
 cwd: string,
 ctx: ImplementContext,
 opts: { label: string; timeoutMs: number; priority?: "background" | "probe"; measureCpu?: boolean },
): Promise<RunResult> {
 const run: ShellRun = ctx.shellRun ?? ((cmd, o) => runCmd("/bin/sh", ["-c", cmd], o));
 const execute = (cmd: string) => run(cmd, {
  cwd,
  env: workerEnv(ctx.config, ctx.map.repo, ctx.sessionJournal, ctx.commitAuthor),
  timeoutMs: opts.timeoutMs,
  processGroup: true,
  // Install and tests yield the CPU; the timing-sensitive probes do not.
  ...(opts.priority === "probe" ? {} : { nice: ctx.config.workers.niceness }),
 });
 const result = ctx.map.testBackend?.kind === "shadow" && opts.measureCpu ? await runShadowMeasured(command, execute) : await execute(command);
 logRun(ctx, `${opts.label} (${command})`, result);
 return result;
}

/** How many of a node run's log writes failed: a record names the log only when none did across its runs. */
const logFailures = new WeakMap<ImplementContext, number>();

/** The node run's failed log writes so far; compare two readings to learn whether runs between them were logged. */
function logFailureCount(ctx: ImplementContext): number {
 return logFailures.get(ctx) ?? 0;
}

/**
 * Append a run's whole output to the node's worker log. A log that cannot be
 * written is journaled and the run goes on: logging never changes a gate.
 */
function logRun(ctx: ImplementContext, label: string, result: RunResult): string | null {
 const saved = tryWorkerLog(ctx.journal.path, ctx.map.repo, ctx.node.ref.id, ctx.generation, label, result);
 if ("file" in saved) return saved.file;
 logFailures.set(ctx, logFailureCount(ctx) + 1);
 ctx.journal.recordEvent("log-failed", {
  nodeId: ctx.node.ref.id,
  repo: ctx.map.repo,
  detail: `could not write the worker log (${label}): ${saved.error}`.slice(0, 400),
 });
 return null;
}

/** After the principal's merge: fast-forward, gated close citing CI, decisions --write. */
async function closeAfterMerge(
 ctx: ImplementContext,
 github: ForgePort,
 pr: ChangeRequest,
): Promise<ImplementOutcome> {
 const { map, journal, node, token, botIdentity } = ctx;
 const repo = map.repo;
 const nodeId = node.ref.id;
 journal.updateWorker(nodeId, ctx.map.repo, { phase: "close", prNumber: pr.iid });

 const credential = graphCredential(ctx);
 const liveNode = await budgetedRead(journal, repo, credential, budgetPolicy(ctx.config), new Date(),
  () => graphNode(repo, nodeId, credential, { timeoutMs: GRAPH_CALL_TIMEOUT_MS }));
 if (liveNode.status === "closed") return finishClosedElsewhere({ ...ctx, node: liveNode, pr });

 await fastForwardCanonical(ctx.canonical, map.base, gitCredential(repo, token));

 const success = await github.ciVerdictFor(repo, pr.headSha, token, "close");
 if (success.state !== "green") {
  throw new ParkSignal(
   `${changeRequestLabel(repo, pr.iid)} merged, but no successful ${ciRunNoun(repo)} on its head ${pr.headSha.slice(0, 8)} — nothing for the close to cite`,
  );
 }
 const reviews = recordedReviews(await github.listComments(repo, pr.iid, token), botIdentity);
 const final = reviews[reviews.length - 1];

 const probe = recordedProbes(await github.listComments(repo, pr.iid, token), botIdentity).find(
  (p) => p.sha === pr.headSha && p.passed,
 );
 const filings = await scribeAfterMerge(ctx, pr, final);
 const resolution = closeResolution(ctx, pr, final, reviewRounds(reviews), success, probe, filings);
 const resolutionFile = join(tmpdir(), `ranger-close-${fileStemFor(repo, nodeId)}.md`);
 writeFileSync(resolutionFile, resolution, "utf8");

 const prRef = pr.webUrl;
 const evidence: { kind: string; summary: string; pointer: string }[] = [];
 if (final !== undefined) {
  evidence.push({
   kind: "judged",
   summary: `sage review round ${final.round} at ${final.sha.slice(0, 8)}: ${final.blockers} blockers, ${final.majors} majors (machine evidence)`,
   pointer: prRef,
  });
 }
 if (ctx.ratify === "merge") {
  // `tested` is reserved on auto nodes (soma derives it); on a propose node
  // it is informational, and the merged PR is the externally checkable pointer.
  evidence.push({
   kind: "tested",
   summary: `CI ${ciRunText(repo, success, "summary")} succeeded at ${pr.headSha.slice(0, 8)}; ${ratificationText(ctx, pr)}`,
   pointer: success.runUrl,
  });
 }

 journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "close the node");
 const close = await graphClose(
  repo,
  nodeId,
  botIdentity,
  token,
  {
   resolutionFile,
   gist: gistLine(repo, node.node.title, pr.iid),
   checkpointId: node.node.checkpointId,
   ...(ctx.ratify === "auto" ? { ci: `${success.runId}@${pr.headSha}` } : {}),
   evidence,
  },
  { cwd: ctx.canonical, timeoutMs: GRAPH_CALL_TIMEOUT_MS },
 );
 if (!close.closed) {
  // A forge read inside the close that got no answer says nothing about the
  // node: thrown plain, failNode leaves the row for the sweep to respawn,
  // uncounted, and the respawn's first read finds the node closed if the
  // close landed after all.
  if (isTransientGitHubError(close.detail)) {
   throw new Error(`close after merge hit a transient forge error: ${close.detail.slice(0, 600)}`);
  }
  throw new ParkSignal(`close refused after merge: ${close.detail.slice(0, 600)}`);
 }
 journal.recordEvent("closed", { nodeId, repo, detail: close.detail.slice(0, 400) });

 // Best-effort: a failed write records decisions-failed only, never
 // decisions-written too (node #108), and the close outcome stands.
 try {
  journal.assertGeneration(nodeId, ctx.map.repo, ctx.generation, "write decisions");
  await graphDecisions(repo, String(map.root), token, {
   cwd: ctx.canonical,
   timeoutMs: GRAPH_CALL_TIMEOUT_MS,
  });
  journal.recordEvent("decisions-written", { nodeId, repo, detail: "decisions --write after confirmed close" });
 } catch (error) {
  const detail = `decisions --write FAILED after close: ${error instanceof Error ? error.message : String(error)}`;
  journal.recordEvent("decisions-failed", { nodeId, repo, detail: detail.slice(0, 400) });
 }

 // The merged branch's worktree is ranger's scratch; drop it.
 await safeGit(["worktree", "remove", "--force", ctx.worktree], {
  cwd: ctx.canonical,
 });
 rmSync(resolutionFile, { force: true });

 return {
  status: "success",
  detail: close.detail.slice(0, 400),
  workerExit: null,
  close,
  prNumber: pr.iid,
 };
}

/**
 * GitHub can serve a PR's previous head for a few seconds after a push. Wait
 * until it shows the pushed SHA before reviewing, or a stale head would match
 * the last round's verdict again (a spurious second fix pass) or look like a
 * mid-review push (a spurious park).
 */
async function awaitHead(
 github: ForgePort,
 repo: string,
 prNumber: number,
 sha: string,
 token: string,
 timeoutMs = 120_000,
): Promise<void> {
 const deadline = Date.now() + timeoutMs;
 for (;;) {
  const live = await github.getPr(repo, prNumber, token);
  if (live.headSha === sha) return;
  if (Date.now() >= deadline) {
   throw new ParkSignal(
    `${forgeName(repo)} still shows ${changeRequestLabel(repo, prNumber)} at ${live.headSha.slice(0, 8)}, not the pushed ${sha.slice(0, 8)}, after ${Math.round(timeoutMs / 1000)}s`,
   );
  }
  await Bun.sleep(3_000);
 }
}

/** GitHub caps a comment at 65 536 characters; the marker always survives, first. */
const COMMENT_BUDGET = 60_000;

function reviewComment(round: number, verdict: ReviewVerdict, substrate?: SubstrateName): string {
 const head = `${reviewMarker(round, verdict, substrate)}\n**Sage review — round ${round}** (offline, machine evidence; not a human sign-off)\n\n`;
 const room = COMMENT_BUDGET - head.length;
 const body =
  verdict.body.length <= room
   ? verdict.body
   : `${verdict.body.slice(0, room - 80)}\n\n… (truncated by ranger; the full review is in the run log)`;
 return head + body;
}

/** Every failing test a run names, in bun's `(fail) <name> [12ms]` format, each once. */
export function allFailedTestNames(result: RunResult): string[] {
 return [...new Set(failedTests(result).map((t) => t.name))];
}

/**
 * One `(fail)` line: its name, the test file whose header preceded it (""
 * when none did), and its cause: the error bun printed for it, as failingCause
 * normalizes it ("" when bun printed none).
 */
export interface FailedTest {
 file: string;
 name: string;
 cause: string;
}

/** bun's recap of the failures, printed after more than 20 passes outside AI mode: `4 tests failed:`. */
const RECAP = /^\d+ tests? failed:$/;

/**
 * An error line as a cause: absolute paths and digits masked, so the same
 * error in the node's worktree and in a fresh clone of the base (another
 * directory, other timings) reads the same, while an assertion and a
 * TypeError, or two different messages, do not.
 */
function failingCause(line: string): string {
 return line
  .trim()
  .replace(/(?:\/[^\s'"`():,]+)+/g, "<path>")
  .replace(/\d+/g, "N");
}

/**
 * Every `(fail)` line a run prints, in order and with repeats: two tests
 * with one title are two failures. bun heads each file's results with its
 * path relative to the checkout (`test/a.test.ts:`), the same in a fresh
 * clone of the base; a `(fail)` line takes the last header in its stream.
 * Its cause is the last error line (`error: …`, `TypeError: …`) printed
 * since the previous result line or header, and a timeout note bun prints
 * after it (`  ^ this test timed out after 50ms.`). The last, not the first:
 * a test's own `console.error` output shares the stream and comes before
 * the error bun prints for it, just above the `(fail)` line. bun 1.3.14
 * prints no nested `cause`, only the outer error.
 *
 * bun's recap of the failures repeats each `(fail)` line after the last
 * file: a stream's lines stop counting at its recap header. A test that
 * prints that header itself makes the count fall short of bun's summary,
 * which gates (failuresAllNamed); it never waives.
 */
export function failedTests(result: RunResult): FailedTest[] {
 const tests: FailedTest[] = [];
 for (const stream of [result.stdout, result.stderr]) {
  let file = "";
  let cause = "";
  let last: FailedTest | null = null;
  for (const line of stream.split("\n")) {
   if (RECAP.test(line)) break;
   const header = /^(\S[^:]*\.[cm]?[jt]sx?):$/.exec(line);
   const m = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
   if (m) {
    last = { file, name: m[1].trim(), cause };
    tests.push(last);
   } else if (last !== null && /^\s+\^ this test timed out/.test(line)) {
    last.cause = [last.cause, failingCause(line.replace(/^\s+\^\s*/, ""))].filter((c) => c !== "").join(" / ");
    continue;
   } else if (/^(?:error|[A-Z]\w*Error)(?:: |$)/.test(line)) {
    cause = failingCause(line);
   }
   if (header || m || /^\((?:pass|skip|todo)\) /.test(line)) {
    if (header) file = header[1];
    cause = "";
    if (!m) last = null;
   }
  }
 }
 return tests;
}

/** A failing test as an event names it: `file: name`, or the bare name when no header preceded it. */
function testIdentity(t: FailedTest): string {
 return t.file === "" ? t.name : `${t.file}: ${t.name}`;
}

/**
 * Whether the run's failures are all bun's named ones, as far as the output
 * shows: bun's summary counts as many failing tests as there are `(fail)`
 * lines, no error is reported outside a test (a file that does not load, an
 * unhandled error between tests), and no TypeScript diagnostic (`error
 * TS2322:`) shows a typecheck failing beside the tests. bun counts a file
 * that fails to load as a failing test with no `(fail)` line, so a shared
 * named failure must not hide it. A run without bun's summary is not
 * accounted for. Another step's failure in the command that prints none of
 * these is not seen here: testsRedAtBase waives only the `bun test` step
 * (bunTestChain) and runs every other step on its own, which must pass.
 * The `(fail)` lines are failedTests', without bun's recap.
 */
export function failuresAllNamed(result: RunResult): boolean {
 const out = `${result.stdout}\n${result.stderr}`;
 const lines = failedTests(result).length;
 const counted = [...out.matchAll(/^\s*(\d+) fail$/gm)];
 const errors = [...out.matchAll(/^\s*(\d+) errors?$/gm)].reduce((n, m) => n + Number(m[1]), 0);
 return (
  counted.length > 0 &&
  counted.reduce((n, m) => n + Number(m[1]), 0) === lines &&
  errors === 0 &&
  !/^# Unhandled error/m.test(out) &&
  !/\berror TS\d+:/m.test(out)
 );
}

/**
 * The branch's failing tests the base run does not fail as often, file,
 * title and cause alike: each counts once per `(fail)` line, so a second
 * failing test sharing a title with a base-red one is not waived by it, and
 * a test that fails another way at the base (an assertion there, a
 * TypeError on the branch) is not the base's failure.
 */
export function failuresNotAtBase(branch: FailedTest[], base: FailedTest[]): string[] {
 const said = (cause: string) => (cause === "" ? "no error line" : `"${cause}"`);
 const there = failureCounts(base);
 return [...failureCounts(branch)].flatMap(([k, n]) => {
  const at = there.get(k) ?? 0;
  if (n <= at) return [];
  const [id, cause] = k.split("\u0000");
  const otherwise = [...new Set(base.filter((t) => testIdentity(t) === id && t.cause !== cause).map((t) => said(t.cause)))];
  if (at === 0 && otherwise.length > 0) return [`${id} (fails with ${said(cause)} on the branch, ${otherwise.join(" / ")} at the base)`];
  return [n === 1 && at === 0 ? id : `${id} (${n} on the branch, ${at} at the base)`];
 });
}

function failureKey(t: FailedTest): string {
 return `${testIdentity(t)}\u0000${t.cause}`;
}

function failureCounts(tests: FailedTest[]): Map<string, number> {
 const n = new Map<string, number>();
 for (const t of tests) n.set(failureKey(t), (n.get(failureKey(t)) ?? 0) + 1);
 return n;
}

function testsNotAtBase(branch: FailedTest[], base: FailedTest[]): FailedTest[] {
 const here = failureCounts(branch);
 const there = failureCounts(base);
 const seen = new Set<string>();
 return branch.filter((t) => {
  const k = failureKey(t);
  if (seen.has(k)) return false;
  seen.add(k);
  return (here.get(k) ?? 0) > (there.get(k) ?? 0);
 });
}

/**
 * Several runs at one merge base as one: each failure (file, title and
 * cause) as many times as the run failing it most often has it, so a flaky
 * base's reruns add the failures they caught, never a count no single run
 * showed.
 */
export function mostFailing(runs: FailedTest[][]): FailedTest[] {
 const most = new Map<string, FailedTest[]>();
 for (const run of runs) {
  const byKey = new Map<string, FailedTest[]>();
  for (const t of run) byKey.set(failureKey(t), [...(byKey.get(failureKey(t)) ?? []), t]);
  for (const [k, tests] of byKey) if (tests.length > (most.get(k)?.length ?? 0)) most.set(k, tests);
 }
 return [...most.values()].flat();
}

const RERUNNABLE_FILE = /^[\w@+,%-][\w.@+,%-]*(?:\/[\w@+,%-][\w.@+,%-]*)*$/;

/** How many times a red merge base reruns the files holding the branch failures it did not share. */
export const BASE_RERUNS = 2;

/**
 * Whether the run reports coverage the way bun enforces a threshold: its
 * coverage table printed, or `--coverage` in the command. A missed
 * threshold fails the run with no `(fail)` line and no failing count (bun
 * 1.3.14 prints only the table and exits 1), so a shared failing test beside
 * it cannot be told apart from a coverage regression.
 */
export function coverageInPlay(testCommand: string, result: RunResult): boolean {
 return /(?:^|\s)--coverage(?:[\s=]|$)/.test(testCommand) || /^\s*File\s+\|\s+% (?:Funcs|Lines)/m.test(`${result.stdout}\n${result.stderr}`);
}

/** One step of a test command: plain words, nothing the shell expands, redirects or chains. */
const PLAIN_STEP = /^[\w./@:=+,%-]+(?: +[\w./@:=+,%-]+)*$/;

/**
 * A test command a base-red waiver can split: plain steps joined by `&&`,
 * exactly one of them `bun test`. `bun` is that step, `rest` every other
 * step, in order, joined by `&&` ("" when the command is `bun test` alone).
 * Null for any other shape (`;`, `||`, a pipe, quotes, an expansion, two bun
 * steps, a script that runs bun inside): what failed beside bun cannot be
 * told apart.
 */
export function bunTestChain(command: string): { bun: string; rest: string } | null {
 const steps = command.split("&&").map((s) => s.trim());
 if (!steps.every((s) => PLAIN_STEP.test(s))) return null;
 const bun = steps.filter((s) => /^bun test(?: |$)/.test(s));
 if (bun.length !== 1) return null;
 return { bun: bun[0], rest: steps.filter((s) => s !== bun[0]).join(" && ") };
}

/** One waived supervisor test run: the branch head, its merge base, the base-red tests, and the other steps that passed alone. */
export interface TestsBaseRed {
 head: string;
 base: string;
 names: string[];
 rest: string;
}

function testsBaseRedKey(repo: string, nodeId: string): string {
 return `tests-base-red.${repo}.${nodeId}`;
}

/** Every waived supervisor test run this journal recorded for the node, oldest first. */
export function recordedTestsBaseRed(journal: Journal, repo: string, nodeId: string): TestsBaseRed[] {
 try {
  const v = JSON.parse(journal.getHealth(testsBaseRedKey(repo, nodeId)) ?? "[]");
  return Array.isArray(v) ? v : [];
 } catch {
  return [];
 }
}

function recordTestsBaseRed(journal: Journal, repo: string, nodeId: string, waived: TestsBaseRed): void {
 journal.setHealth(testsBaseRedKey(repo, nodeId), JSON.stringify([...recordedTestsBaseRed(journal, repo, nodeId), waived]));
}

/**
 * What the PR and close receipts say about the supervisor's tests: "passed"
 * only when no run was waived; otherwise each waived run, by head, merge
 * base and test (node #164: a base-red pass is not a passing run).
 */
export function testsReceipt(command: string | undefined, where: string, waived: TestsBaseRed[]): string {
 if (waived.length === 0) return `\`${command}\` passed ${where} before every push.`;
 const code = (s: string) => `\`${s.replaceAll("`", "'")}\``;
 const runs = waived.map((w) => {
  const names = w.names.slice(0, 10).map(code).join(", ") + (w.names.length > 10 ? ` and ${w.names.length - 10} more` : "");
  const rest = w.rest === "" ? "" : `; the other steps, ${code(w.rest)}, passed on their own`;
  return `at \`${w.head.slice(0, 8)}\` it failed only on tests its merge base \`${w.base.slice(0, 8)}\` fails too (${names})${rest}`;
 });
 return `\`${command}\` ran ${where} before every push. It passed every time but these, whose failures were not gating: ${runs.join("; ")}.`;
}

/** An exit the shell reports for a signal (128 + N: 137 a kill, 143 a SIGTERM). */
function signalExit(code: number): boolean {
 return code > 128;
}

/** The first three failing tests a run names: what the journal line keeps. */
export function failedTestNames(result: RunResult): string[] {
 return allFailedTestNames(result).slice(0, 3);
}

/** A failed supervisor test run, named: the failing tests first (the journal keeps 400 characters), then the tail. */
function testsFailedDetail(testCommand: string, tests: RunResult, after: string): string {
 const names = failedTestNames(tests);
 return `tests (${testCommand}) failed ${after} (exit ${tests.code})${names.length > 0 ? ` — failing: ${names.join("; ")}` : " — failing test names unavailable"}: ${tail(tests)}`;
}

/**
 * The supervisor's own test run. A failure keeps its whole output in the
 * node's log (2026-10-05: #691's failure kept only 400 characters of passing
 * tests, so the failing one was lost). A failure on a busy host is retried
 * once, after the host quiets or the quiet-host wait (20 minutes) runs out:
 * the worker's run passed the same tree, and a rerun at normal load passed
 * it again, while the supervisor's ran at load 40–100 and failed.
 *
 * The retry runs in a fresh clone of the committed head, with its own
 * install (testsInFreshCheckout): nothing the failed run wrote into the
 * node's worktree or the shared repository (untracked or ignored fixtures,
 * index flags, links, replacement refs) reaches it. The node's worktree is
 * left as it is, and a retry whose pass ends with the worktree on another
 * HEAD counts for nothing.
 *
 * What this guards against is leftovers: state outside the commit that a
 * failed run produced. The commit's own install and test scripts are the
 * commit; one that misreports itself (an `exit 0`, a redirected git
 * worktree) is the commit's behaviour, which no re-run can catch, and the
 * review reads that code.
 *
 * A failure that names its failing tests is then checked at its merge base
 * with `baseTip` (testsRedAtBase): when the base run fails each of them, by file
 * and title and as many times, with the same exit code, and the command's
 * other steps pass on their own, they are the base's, and `baseRed` says the
 * pass goes on as if the tests passed (the receipts say it did not). `tests`
 * is always the branch's own run.
 *
 * A retry that ran validly but started on a busy host (the quiet-host wait
 * ran out) and failed sets `busy` to the load it started at, and gets no
 * merge-base run: a second run under the same load is no evidence about the
 * branch, and a base run on that host would be none about the base (node
 * #297: every failure across four such runs on cortex #2557 was a 4–5 s
 * timeout at load 58–108 on 10 cores; the same head passed 11494/0 alone).
 */
async function supervisorTests(
 ctx: ImplementContext,
 testCommand: string,
 label: string,
 baseTip: string | null,
): Promise<{ tests: RunResult; retried: boolean; baseRed?: BaseRedTests; busy?: BusyReading }> {
 const { journal, map, node, worktree } = ctx;
 const head = await headSha(worktree);
 // A full suite started on a busy host is what times out (2026-10-14: soma's
 // 6-minute suite ran past the 20-minute timeout at load 45-55 on 10 cores):
 // wait for a quiet host first, then run anyway, as the probe tier does.
 if (!remoteTests(ctx)) await awaitQuietHost(ctx, "the supervisor test run");
 let tests = await backendTests(ctx, head, () => runShell(testCommand, worktree, ctx, { label: `${label}: supervisor tests`, timeoutMs: testTimeoutMs(ctx), measureCpu: true }));
 if (remoteTests(ctx)) return { tests, retried: false };
 if (tests.code === 0) return { tests, retried: false };
 if ((await headSha(worktree)) !== head) {
  journal.recordEvent("reviewed", {
   nodeId: node.ref.id,
   repo: map.repo,
   detail: `tests (${testCommand}) failed and moved HEAD — not retried`,
  });
  return { tests, retried: false };
 }
 const retry = await retryOnBusyHost(ctx, testCommand, head, `tests (${testCommand})`, "the test retry", `${label}: supervisor test retry`);
 if (retry === null) return { tests, retried: false, ...await baseRedAt(ctx, { testCommand, tests, head, label, baseTip }) };
 tests = retry.result;
 // A retry that did not run validly (its clone, install or checkout check
 // failed) certifies nothing: its (fail) lines are no evidence to waive.
 if (!retry.ran) return { tests, retried: false };
 if (tests.code === 0 && (await headSha(worktree)) !== head) {
  tests = { ...tests, code: 1, stderr: `the retry passed at ${head.slice(0, 8)}, but the worktree moved off it meanwhile\n${tests.stderr}` };
 }
 if (tests.code === 0) {
  journal.recordEvent("reviewed", { nodeId: node.ref.id, repo: map.repo, detail: `tests (${testCommand}) passed on the retry in a fresh checkout` });
  return { tests, retried: true };
 }
 const busy = retry.busy ?? killedOnBusyHost(ctx, tests, `the test retry (${testCommand})`);
 if (busy !== null) return { tests, retried: false, busy };
 return { tests, retried: false, ...await baseRedAt(ctx, { testCommand, tests, head, label, baseTip }) };
}

/**
 * Failing tests that fail at the merge base too, by file, title, count,
 * error and exit code: as far as the two runs show, the base's failures.
 */
interface BaseRedTests {
 sha: string;
 names: string[];
 /** The command's other steps, which passed on their own ("" when there are none). */
 rest: string;
}

/** A failed supervisor test run at `head`, and the origin/<base> tip read before the worker ran. */
interface FailedRun {
 testCommand: string;
 tests: RunResult;
 head: string;
 label: string;
 baseTip: string | null;
}

/** `{ baseRed }` when the branch's failures are all red at the base and HEAD stayed at `head` meanwhile; else nothing. */
async function baseRedAt(ctx: ImplementContext, run: FailedRun): Promise<{ baseRed?: BaseRedTests }> {
 const { testCommand, head } = run;
 const baseRed = await testsRedAtBase(ctx, run);
 if (baseRed === null) return {};
 if ((await headSha(ctx.worktree)) !== head) {
  ctx.journal.recordEvent("reviewed", {
   nodeId: ctx.node.ref.id,
   repo: ctx.map.repo,
   detail: `tests (${testCommand}): the worktree moved off ${head.slice(0, 8)} during the merge-base test run — the failures gate`,
  });
  return {};
 }
 return { baseRed };
}

/**
 * The probe rule (node #109) for the supervisor's tests: a failure the merge
 * base shares is the base's, not the branch's (2026-10-07: two nodes failed
 * on tests their branches never touched, one passing 44/44 alone, the other a
 * timeout soma's main hits at the same base). When the failed run names its
 * failing tests, the map's whole test command runs once more in a fresh clone
 * of the merge base of `head` and origin/<base>, after the host quiets.
 * origin/<base> is `baseTip`, read before the worker ran, and the merge base
 * is computed in a clone of its own (mergeBaseInFreshClone): a failed run
 * that moves the ref, plants a replacement or writes grafts cannot pick the
 * commit its failures are compared with.
 *
 * Only the `bun test` step is waived: the command must be plain steps joined
 * by `&&`, one of them `bun test` (bunTestChain), and every other step then
 * runs on its own in a fresh clone of `head` and must pass, so a lint or
 * typecheck failure beside the shared tests (or one the failing bun step
 * kept from running) still gates.
 *
 * "Shares" is what the runs show: the result is the base's red set when
 * every `(fail)` line the branch run printed is one there too, by file,
 * title and error and as many times (failuresNotAtBase), the base run exits
 * with the branch run's code, and the other steps pass; null when they gate.
 *
 * A red merge base can be flaky (2026-10-16: cortex's base failed a
 * different subset of its fs.watch tests on every run on this host, so no
 * branch run ever matched it). When the base run fails another set, its
 * `bun test` step reruns only the test files holding the branch failures
 * it has not failed yet (rerunsAtBase), in a fresh clone of the merge base
 * after the host quiets, up to BASE_RERUNS times or until every branch
 * failure has been red there. The base's failures are then those of every
 * run there, each as often as the run failing it most (mostFailing). A
 * failure with no file header, or a file a rerun could not name safely
 * (RERUNNABLE_FILE: relative, plain words, no `.`-led segment), gets no
 * rerun; a rerun that did not run stops the reruns, and one a signal ended
 * counts for nothing. A base that passes reruns nothing: every failure only
 * the branch has gates.
 *
 * A run with coverage in play (coverageInPlay) gets no base run: a missed
 * threshold names no test. A failure that names no test (a
 * typecheck after passing tests, a crash, a timeout, a kill), one a signal
 * ended (exit > 128), or one whose `(fail)` lines do not account for every
 * failure bun reports (failuresAllNamed) gets no base run; a base run a signal
 * ended is no base result. Every outcome of a base run or rerun, or why none ran, is a
 * `reviewed` event; the lane records a waived run that goes on to the push
 * for the PR and close receipts (testsReceipt).
 */
async function testsRedAtBase(ctx: ImplementContext, run: FailedRun): Promise<BaseRedTests | null> {
 const { journal, map, node } = ctx;
 const { testCommand, tests, head, label, baseTip } = run;
 const failed = failedTests(tests);
 if (tests.code <= 0 || signalExit(tests.code) || failed.length === 0) return null;
 const event = (detail: string) => journal.recordEvent("reviewed", { nodeId: node.ref.id, repo: map.repo, detail });
 const chain = bunTestChain(testCommand);
 if (chain === null) {
  event(`tests (${testCommand}) failed; the merge-base check did not run: the command is not plain steps joined by && with one \`bun test\` step, so a failure beside the tests could not be told apart — the failures gate`);
  return null;
 }
 if (!failuresAllNamed(tests)) {
  event(`tests (${testCommand}) failed with failures no (fail) line names (an error outside a test, a TypeScript diagnostic, or a count the names do not cover); the merge-base check did not run — the failures gate`);
  return null;
 }
 if (coverageInPlay(testCommand, tests)) {
  event(`tests (${testCommand}) failed with coverage reported, and a missed coverage threshold names no test; the merge-base check did not run — the failures gate`);
  return null;
 }
 if (baseTip === null) {
  event(`tests (${testCommand}) failed; the merge-base check did not run: origin/${map.base} did not resolve before the worker ran — the failures gate`);
  return null;
 }
 const merged = await mergeBaseInFreshClone(ctx, head, baseTip);
 if ("why" in merged) {
  event(`tests (${testCommand}) failed; the merge-base check did not run: ${merged.why} — the failures gate`);
  return null;
 }
 const { sha } = merged;
 await awaitQuietHost(ctx, "the merge-base test run");
 const base = await freshCheckoutTests(ctx, testCommand, sha, `${label}: merge base ${sha.slice(0, 8)}`, "base");
 if (!base.ran) {
  event(`tests (${testCommand}) failed; the merge-base check at ${sha} did not run: ${base.result.stderr.trim().split("\n")[0]} — the failures gate`);
  return null;
 }
 if (signalExit(base.result.code)) {
  event(`tests (${testCommand}) at the merge base ${sha} were ended by a signal (exit ${base.result.code}) — not a base result, the failures gate`);
  return null;
 }
 const atBase = base.result.code > 0 ? await rerunsAtBase(ctx, { testCommand, bun: chain.bun, sha, label, event }, failed, failedTests(base.result)) : { red: [], reruns: 0 };
 const unshared = failuresNotAtBase(failed, atBase.red);
 if (unshared.length > 0) {
  const how = base.result.code === 0 ? "passes" : `fails another set (exit ${base.result.code})`;
  event(`tests (${testCommand}) at the merge base ${sha} ${how} — not red there, they gate: ${unshared.join("; ")}`);
  return null;
 }
 if (base.result.code !== tests.code) {
  event(`tests (${testCommand}) at the merge base ${sha} exit ${base.result.code}, the branch run exited ${tests.code} — not the same failure, they gate`);
  return null;
 }
 if (chain.rest !== "") {
  const steps = await freshCheckoutTests(ctx, chain.rest, head, `${label}: the other test steps`, "steps");
  if (!steps.ran) {
   event(`tests (${testCommand}) are red at the merge base ${sha} too, but the other steps (${chain.rest}) did not run on their own at ${head.slice(0, 8)}: ${steps.result.stderr.trim().split("\n")[0]} — the failures gate`);
   return null;
  }
  if (steps.result.code !== 0) {
   event(`tests (${testCommand}) are red at the merge base ${sha} too, but the other steps (${chain.rest}) exit ${steps.result.code} on their own at ${head.slice(0, 8)} — they gate: ${tail(steps.result)}`);
   return null;
  }
 }
 const names = [...new Set(failed.map(testIdentity))];
 const reran = atBase.reruns === 0 ? "" : ` (counting ${atBase.reruns} rerun(s) of their files there)`;
 event(`tests (${testCommand}) at the merge base ${sha}, failing the same way${reran}${chain.rest === "" ? "" : ` (the other steps, ${chain.rest}, pass on their own)`}: red on the merge base too, not gating: ${names.join("; ")}`);
 return { sha, names, rest: chain.rest };
}

async function rerunsAtBase(
 ctx: ImplementContext,
 run: { testCommand: string; bun: string; sha: string; label: string; event: (detail: string) => void },
 failed: FailedTest[],
 first: FailedTest[],
): Promise<{ red: FailedTest[]; reruns: number }> {
 const { testCommand, bun, sha, label, event } = run;
 const runs = [first];
 let reruns = 0;
 for (let n = 1; n <= BASE_RERUNS; n++) {
  const missing = testsNotAtBase(failed, mostFailing(runs));
  if (missing.length === 0) break;
  const unnamed = missing.filter((t) => !RERUNNABLE_FILE.test(t.file));
  if (unnamed.length > 0) {
   event(`tests (${testCommand}) at the merge base ${sha} fail another set; no rerun there: ${unnamed.map(testIdentity).join("; ")} name(s) no test file a rerun can select`);
   break;
  }
  const command = `${bun} ${[...new Set(missing.map((t) => `./${t.file}`))].join(" ")}`;
  const what = `tests (${testCommand}) rerun ${n} of ${BASE_RERUNS} at the merge base ${sha} (${command})`;
  await awaitQuietHost(ctx, `merge-base rerun ${n}`);
  const rerun = await freshCheckoutTests(ctx, command, sha, `${label}: merge base ${sha.slice(0, 8)} rerun ${n}`, "base");
  if (!rerun.ran) {
   event(`${what} did not run: ${rerun.result.stderr.trim().split("\n")[0]} — it counts for nothing`);
   break;
  }
  if (signalExit(rerun.result.code)) {
   event(`${what} was ended by a signal (exit ${rerun.result.code}) — it counts for nothing`);
   continue;
  }
  reruns++;
  runs.push(rerun.result.code > 0 ? failedTests(rerun.result) : []);
  const still = failuresNotAtBase(failed, mostFailing(runs));
  event(`${what} exit ${rerun.result.code}: ${still.length === 0 ? "every branch failure is red there now" : `still not red there: ${still.join("; ")}`}`);
 }
 return { red: mostFailing(runs), reruns };
}

/**
 * `git merge-base head baseTip`, computed in a bare clone of the node's
 * branch made for it: `--no-local`, so the commits arrive as objects (no
 * commit-graph or alternates hardlinked from the shared repository), with
 * `baseTip` and `head` fetched by sha. The clone has no grafts, replacement
 * refs or config the failed run could have written; a shallow clone (the
 * shared repository marked shallow) is refused. Grafts in the shared
 * repository make the clone fail, which counts as no merge base.
 */
async function mergeBaseInFreshClone(ctx: ImplementContext, head: string, baseTip: string): Promise<{ sha: string } | { why: string }> {
 const scratch = mkdtempSync(join(tmpdir(), "ranger-merge-base-"));
 const dir = join(scratch, "repo.git");
 const git = (args: string[], cwd: string, timeoutMs = 60_000) => safeGit(["--no-replace-objects", ...args], { cwd, timeoutMs });
 const first = (r: RunResult) => r.stderr.trim().split("\n").filter((l) => !/^(?:remote: )?hint:/.test(l)).slice(-1)[0] ?? `exit ${r.code}`;
 try {
  const clone = await git(["clone", "--quiet", "--bare", "--no-local", "--no-tags", "--single-branch", "--branch", ctx.branch, ctx.canonical, dir], scratch, 300_000);
  if (clone.code !== 0) return { why: `could not clone to compute the merge base (${first(clone)})` };
  const fetch = await git(["fetch", "--quiet", "--no-tags", ctx.canonical, head, baseTip], dir, 300_000);
  if (fetch.code !== 0) return { why: `could not fetch ${head.slice(0, 8)} and origin/${ctx.map.base} at ${baseTip.slice(0, 8)} to compute the merge base (${first(fetch)})` };
  const shallow = await git(["rev-parse", "--is-shallow-repository"], dir, 10_000);
  if (shallow.stdout.trim() !== "false") return { why: "the clone to compute the merge base is shallow" };
  const merged = await git(["merge-base", head, baseTip], dir, 30_000);
  const sha = merged.stdout.trim();
  if (merged.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
   return { why: `no merge base with origin/${ctx.map.base} at ${baseTip.slice(0, 8)} (${merged.stderr.trim() || `exit ${merged.code}`})` };
  }
  return { sha };
 } finally {
  await rm(scratch, { recursive: true, force: true });
 }
}

/**
 * The one busy-host retry supervisor test runs and adoption share: on a
 * loaded host, wait for it to quiet (or for the wait to run out) and run
 * install and the tests once more in a fresh clone of `sha`. Null when the
 * host is not busy: no retry. `ran` is freshCheckoutTests' own: false when
 * the retry's clone, install or checkout check failed (or the local run never
 * happened), so its result is no evidence. `busy` is the load the retry
 * started at when the quiet-host wait ran out first, else null: a busy
 * retry's failure is the host's, not the branch's (node #297).
 */
async function retryOnBusyHost(
 ctx: ImplementContext,
 testCommand: string,
 sha: string,
 what: string,
 run: string,
 label: string,
): Promise<{ ran: boolean; result: RunResult; busy: HostLoadReading | null } | null> {
 const host = busyHostNow(ctx);
 if (host === null) return null;
 ctx.journal.recordEvent("reviewed", {
  nodeId: ctx.node.ref.id,
  repo: ctx.map.repo,
  detail: `${what} failed on a busy host (${describeLoad(host, busyLoad(ctx))}) — retrying once, in a fresh checkout of ${sha.slice(0, 8)}, when it quiets`,
 });
 const started = await awaitQuietHost(ctx, run);
 let ran = false;
 const local = async () => {
  const fresh = await freshCheckoutTests(ctx, testCommand, sha, label, "retry");
  ran = fresh.ran;
  return fresh.result;
 };
 const result = ctx.map.testBackend?.kind === "shadow" ? await backendTests(ctx, sha, local) : await local();
 return { ran, result, busy: isQuiet(started, busyLoad(ctx)) ? null : started };
}

/**
 * The park for supervisor tests whose busy-host retry ran busy and failed
 * (node #297). `what` names the run; the outcome leads with the wait reason
 * and the first three failing tests.
 */
function hostLoadPark(ctx: ImplementContext, host: BusyReading, what: string, tests: RunResult): HostLoadPark {
 return new HostLoadPark(hostLoadOutcome({ ...host, what, names: failedTestNames(tests), busyLoad: busyLoad(ctx) }), host);
}

const KILLED_ON_BUSY_HOST = "was killed with no failing test while the host was busy";

/**
 * A retry that started on a quiet host but was killed (exit -1: the test
 * timeout, or a signal) with no failing test while the host is busy now
 * likely got no verdict: the load ended it, not the code (2026-10-14: soma
 * #802 and #853 failed on 20-minute timeouts with no failing test). The load
 * now, or null when the run named a failure or the host is quiet. A hanging
 * suite's own processes can read as a busy host too, so this parks once per
 * node a day: a second such kill within 24 hours is the node's failure.
 */
function killedOnBusyHost(ctx: ImplementContext, tests: RunResult, what: string): BusyReading | null {
 if (tests.code !== -1 || allFailedTestNames(tests).length > 0) return null;
 const host = busyHostNow(ctx);
 if (host === null) return null;
 const nodeId = ctx.node.ref.id;
 const repo = ctx.map.repo;
 const again = ctx.journal.countEventsSince("host-killed", repo, nodeId, new Date(Date.now() - 24 * 60 * 60 * 1000)) > 0;
 ctx.journal.recordEvent(again ? "reviewed" : "host-killed", {
  nodeId,
  repo,
  detail: again
   ? `${what} ${KILLED_ON_BUSY_HOST} (${describeLoad(host, busyLoad(ctx))}) for the second time in 24h — it counts as the node's failure`
   : `${what} ${KILLED_ON_BUSY_HOST} (${describeLoad(host, busyLoad(ctx))}) — it parks for a quiet host once; a second time in 24h counts`,
 });
 return again ? null : { ...host, killed: true };
}

/**
 * Put the node's worktree back to exactly `sha` once a fresh clone has
 * certified it (a test retry, or an adoption): whatever the failed run left
 * in the worktree (fixtures, ignored files, index flags) must not reach the
 * probes and views that run there next. Ignored files go too, so the
 * install runs again. Returns why it could not, or null.
 */
async function restoreWorktree(ctx: ImplementContext, sha: string): Promise<string | null> {
 const { worktree, map, node, journal } = ctx;
 // read-tree writes fresh index entries (no --skip-worktree or
 // --assume-unchanged flag survives); clean -x removes ignored leftovers.
 for (const args of [["read-tree", "--reset", "-u", sha], ["reset", "--hard", sha], ["clean", "-ffdx"]]) {
  journal.assertGeneration(node.ref.id, map.repo, ctx.generation, `git ${args[0]} to restore the worktree`);
  const r = await safeGit(["--no-replace-objects", ...args], { cwd: worktree, timeoutMs: 120_000 });
  if (r.code !== 0) return `could not restore the worktree to ${sha.slice(0, 8)} (git ${args[0]}): ${r.stderr.trim()}`;
 }
 if (!remoteTests(ctx) && map.commands.install !== undefined) {
  const install = await runShell(map.commands.install, worktree, ctx, { label: "restoring the worktree: install", timeoutMs: INSTALL_TIMEOUT_MS });
  if (install.code !== 0) return `install (${map.commands.install}) after restoring the worktree exited ${install.code}: ${tail(install)}`;
 }
 if ((await headSha(worktree)) !== sha || (await dirtyFiles(worktree)).length > 0) {
  return `the worktree is not at a clean ${sha.slice(0, 8)} after restoring it`;
 }
 journal.recordEvent("reviewed", {
  nodeId: node.ref.id,
  repo: map.repo,
  detail: `restored the worktree to ${sha.slice(0, 8)} (reset, cleaned, reinstalled) before anything else runs in it`,
 });
 return null;
}

/**
 * The map's install and test commands in a throwaway clone of the node's
 * branch, checked out at `sha`. A clone, not a linked worktree, of that one
 * branch without tags: it carries no other ref but origin/<base>, copied
 * from the canonical (refs/replace a failed run planted would make the files
 * checked out differ from the commit that gets pushed; a tag it left could be
 * what a test reads), no config and no hooks
 * from the node's repository. Every git call here also refuses replacement
 * objects.
 */
async function testsInFreshCheckout(ctx: ImplementContext, testCommand: string, sha: string, label: string): Promise<RunResult> {
 return (await freshCheckoutTests(ctx, testCommand, sha, label, "retry")).result;
}

/**
 * testsInFreshCheckout for a retry, a merge-base run, or the other steps of
 * a base-red run. `ran` is false when the clone, the copy of origin/<base>,
 * checkout or install failed, or the run changed the checkout's tracked content or HEAD: the result then
 * carries why, first.
 */
async function freshCheckoutTests(
 ctx: ImplementContext,
 testCommand: string,
 sha: string,
 label: string,
 purpose: "retry" | "base" | "steps",
): Promise<{ ran: boolean; result: RunResult }> {
 const scratch = mkdtempSync(join(tmpdir(), `ranger-test-${purpose}-`));
 // Named as the node's checkout is, with its origin URL (below): a repo's
 // tests may read either (2026-10-08: soma's install test wants "soma" in its
 // path, and its graph bridge test parses origin's host), and a clone named
 // `checkout` whose origin is a local path failed them every time.
 const dir = join(scratch, basename(ctx.canonical));
 const forRun = { retry: "for the retry", base: "for the merge-base run", steps: "for the other test steps" }[purpose];
 const failed = (why: string) => ({ ran: false, result: { code: 1, stdout: "", stderr: why } });
 const git = (args: string[], cwd: string, timeoutMs = 60_000) =>
  safeGit(["--no-replace-objects", ...args], { cwd, timeoutMs });
 try {
  // Only the node's branch, no tags: a ref the failed run left is no input.
  const clone = await git(
   ["clone", "--quiet", "--no-checkout", "--no-tags", "--single-branch", "--branch", ctx.branch, ctx.canonical, dir],
   scratch,
   300_000,
  );
  if (clone.code !== 0) return failed(`could not clone ${forRun}: ${clone.stderr.trim()}`);
  const originUrl = await git(["remote", "get-url", "origin"], ctx.canonical, 10_000);
  if (originUrl.code === 0 && originUrl.stdout.trim() !== "") {
   const set = await git(["remote", "set-url", "origin", originUrl.stdout.trim()], dir, 10_000);
   if (set.code !== 0) return failed(`could not set origin ${forRun}: ${set.stderr.trim()}`);
  }
  // The base's remote-tracking ref too, as the node's worktree sees it: a
  // repo's tests may diff against it (2026-10-14: soma's boundary check runs
  // `git merge-base HEAD origin/main`, and the single-branch clone failed it
  // on every retry and adoption — node #298). Copied from the canonical by
  // sha, no network; a canonical without it fails the run before install,
  // as tests would otherwise fail on a ref the branch never lacked.
  const baseRef = `refs/remotes/origin/${ctx.map.base}`;
  const baseTip = await git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], ctx.canonical, 10_000);
  const tip = baseTip.stdout.trim();
  if (baseTip.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tip)) {
   return failed(`the canonical checkout has no ${baseRef} (origin/${ctx.map.base}) to give the checkout ${forRun}: fetch the base there first`);
  }
  const base = await git(["fetch", "--quiet", "--no-tags", ctx.canonical, `+${tip}:${baseRef}`], dir, 300_000);
  const copied = await git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], dir, 10_000);
  if (base.code !== 0 || copied.stdout.trim() !== tip) {
   return failed(`could not copy ${baseRef} at ${tip.slice(0, 8)} into the checkout ${forRun}: ${base.stderr.trim() || copied.stderr.trim() || "the ref did not resolve"}`);
  }
  const checkout = await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha], dir, 120_000);
  if (checkout.code !== 0) return failed(`could not check out ${sha.slice(0, 8)} ${forRun}: ${checkout.stderr.trim()}`);
  if (ctx.map.commands.install !== undefined) {
   const install = await runShell(ctx.map.commands.install, dir, ctx, { label: `${label}: install in a fresh checkout`, timeoutMs: INSTALL_TIMEOUT_MS });
   if (install.code !== 0) return { ran: false, result: { ...install, stderr: `install ${forRun} failed\n${install.stderr}` } };
  }
  const tests = await runShell(testCommand, dir, ctx, { label: `${label}: tests in a fresh checkout`, timeoutMs: testTimeoutMs(ctx), measureCpu: true });
  // A sanity check on the run, not proof against the commit's own scripts
  // (see supervisorTests): install and the tests should leave the commit's
  // tracked content as committed — no new HEAD, no modified tracked file,
  // no index flag hiding one.
  const now = await git(["rev-parse", "HEAD"], dir, 10_000);
  const tracked = await git(["status", "--porcelain", "--untracked-files=no"], dir);
  const flags = await git(["ls-files", "-v"], dir);
  const changed =
   now.stdout.trim() !== sha ||
   tracked.code !== 0 ||
   tracked.stdout.trim() !== "" ||
   flags.code !== 0 ||
   flags.stdout.split("\n").some((l) => l.length > 0 && !l.startsWith("H "));
  if (changed) {
   const outcome = { retry: "the retry certifies nothing that gets pushed", base: "its result is not the base's", steps: "the steps certify nothing" }[purpose];
   return {
    ran: false,
    result: {
     ...tests,
     code: tests.code === 0 ? 1 : tests.code,
     stderr: `install or the tests changed ${sha.slice(0, 8)}'s tracked content or HEAD in the ${purpose} checkout — ${outcome}\n${tests.stderr}`,
    },
   };
  }
  return { ran: true, result: tests };
 } finally {
  await rm(scratch, { recursive: true, force: true });
 }
}

/**
 * Work a previous run built and committed but never pushed (its supervisor
 * tests failed, or it crashed before the push): when the branch is ahead of
 * the base with a clean tree and passes the supervisor's checks, it is
 * pushed as it stands, with no new worker session. One that fails them goes
 * to the worker as before, which can fix what broke. Null when there is
 * nothing to adopt or it does not pass.
 *
 * The git state is trusted exactly as on any resumed pass: checked against
 * the known-good record (node #81), so a change the failed run's tests made
 * parks here instead of becoming this run's baseline.
 *
 * With `fix`, the work is a fix pass answering the review at the PR's pushed
 * head: only commits on top of that head, with no merge among them (a base
 * merge is redone by its own pass), are adopted (2026-10-08: ranger #124 and
 * #152 lost finished fix passes to a load flake in the supervisor's tests).
 */
async function adoptBuiltWork(
 ctx: ImplementContext,
 testCommand: string,
 fix?: { round: number; pushedHead: string },
): Promise<PassResult | null> {
 const { map, worktree, journal, node } = ctx;
 if (fix === undefined ? (await commitsAhead(worktree, map.base)) === 0 : !(await fixCommitsOn(worktree, fix.pushedHead))) {
  return null;
 }
 if ((await dirtyFiles(worktree)).length > 0) return null;
 const what = fix === undefined ? "build" : `fix pass ${fix.round}`;
 if (fix === undefined) {
  const note = await blockerNoteBranch(worktree, map.base);
  if (note !== null) throw await blockedPark(ctx, "adopted build", note, { dropNote: true });
 }
 const snapshot = await trustedSnapshot(journal, ctx.canonical, { repo: map.repo, nodeId: node.ref.id }, mapKey(map));
 const sha = await headSha(worktree);
 // Tested in a fresh clone of the commit, not in the worktree: whatever the
 // failed run left there (ignored fixtures, links, replacement refs) must
 // not be what makes the adopted commit pass. A failure on a busy host gets
 // the same one retry as any supervisor test run, or a load flake would hand
 // finished work back to a worker with nothing left to commit.
 // Each attempt keeps its own output in the worker log, the retry's included.
 if (!remoteTests(ctx)) await awaitQuietHost(ctx, "the adoption test run");
 let tests = await backendTests(ctx, sha, () => testsInFreshCheckout(ctx, testCommand, sha, `adopted ${what}: supervisor tests`));
 let busy: BusyReading | null = null;
 if (tests.code !== 0) {
  const retry = remoteTests(ctx) ? null : await retryOnBusyHost(ctx, testCommand, sha, "adoption tests", "the adoption test retry", `adopted ${what}: supervisor test retry`);
  if (retry !== null) {
   tests = retry.result;
   if (retry.ran) busy = retry.busy ?? killedOnBusyHost(ctx, tests, "the adoption test retry");
  }
 }
 const clean = await assertGitUntouched(ctx.canonical, snapshot);
 // The retry ran on a busy host too and failed: a worker would find nothing
 // to change (node #297: cortex #2557 spent two sessions that way). The run
 // parks and a resume waits for a quiet host to adopt the work then.
 if (tests.code !== 0 && busy !== null) {
  throw hostLoadPark(ctx, busy, `the adoption tests (${testCommand}) on the ${what} a previous run committed`, tests);
 }
 if (tests.code !== 0) {
  if (remoteTests(ctx)) return { workerExit: null, snapshot, sha, failure: { status: "failed", detail: tests.stderr, workerExit: null } };
  journal.recordEvent("reviewed", {
   nodeId: node.ref.id,
   repo: map.repo,
   detail: `${testsFailedDetail(testCommand, tests, "on the work a previous run committed")} — the worker continues`.slice(0, 400),
  });
  return null;
 }
 if ((await headSha(worktree)) !== sha || (await dirtyFiles(worktree)).length > 0) return null;
 recordKnownGood(journal, ctx.canonical, clean, "passing adoption tests");
 await assertNoClosingKeywords(worktree, map.base, parseForgeRef(map.repo).forge);
 const restored = remoteTests(ctx) ? null : await restoreWorktree(ctx, sha);
 if (restored !== null) {
  return { workerExit: null, snapshot, sha, failure: { status: "failed", detail: restored, workerExit: null } };
 }
 journal.recordEvent("reviewed", {
  nodeId: node.ref.id,
  repo: map.repo,
  detail: `adopting ${sha.slice(0, 8)}${fix === undefined ? "" : ` as fix pass ${fix.round}`}: a previous run built and committed it, and it passes the supervisor's tests — no new worker session`,
 });
 return { workerExit: null, snapshot, sha, adopted: true };
}

/** Whether HEAD is commits on top of `pushedHead` with no merge among them. */
async function fixCommitsOn(worktree: string, pushedHead: string): Promise<boolean> {
 const git = (args: string[]) => safeGit(args, { cwd: worktree, timeoutMs: 10_000 });
 if ((await git(["merge-base", "--is-ancestor", pushedHead, "HEAD"])).code !== 0) return false;
 const ahead = await git(["rev-list", "--count", `${pushedHead}..HEAD`]);
 const merges = await git(["rev-list", "--merges", "--count", `${pushedHead}..HEAD`]);
 if (ahead.code !== 0 || merges.code !== 0) return false;
 return Number(ahead.stdout.trim()) > 0 && Number(merges.stdout.trim()) === 0;
}

function tail(result: RunResult): string {
 return (result.stderr.trim() || result.stdout.trim()).slice(-600);
}

/** The node title, refused if it would carry a closing keyword into the squash message. */
export function prTitle(ctx: ImplementContext): string {
 const { node } = ctx;
 return refuseClosingKeyword(ctx, "the node title", `${node.node.title} (node #${node.ref.id})`, "; retitle the node");
}

/**
 * Text ranger writes where the map's forge reads closing references (PR/MR
 * title and description), refused with the offending text quoted (node #128).
 */
function refuseClosingKeyword(ctx: ImplementContext, what: string, text: string, remedy = ""): string {
 const forge = parseForgeRef(ctx.map.repo).forge;
 const hit = findClosingKeyword(text, forge);
 if (hit !== null) throw new ParkSignal(`${closingKeywordRefusal(forge, what, hit)}${remedy}`);
 return text;
}

function nodeLink(ctx: ImplementContext): string {
 return `orienteer node ${ctx.map.repo} #${ctx.node.ref.id}`;
}

export function draftBody(ctx: ImplementContext): string {
 return [
  `Draft by ranger's implement lane for ${nodeLink(ctx)}.`,
  "",
  "Ranger reviews this draft with sage (offline) before marking it ready. The real",
  "description replaces this text then.",
 ].join("\n");
}

function probeLine(ctx: ImplementContext, probe: RecordedProbe | undefined): string[] {
 if (ctx.map.commands.probe === undefined) return [];
 return probe === undefined
  ? ["- Probes: not recorded at this head."]
  : [`- Probes: passed at \`${probe.sha.slice(0, 8)}\` (selection ${probe.mode}, ${probe.selected} probe(s)). Only the selected probes ran, not the full suite.${baseRedNote(ctx.map.repo, probe)}`];
}

/** The probes a passing record excuses because the merge base fails them too. */
export function baseRedNote(repo: string, probe: Pick<RecordedProbe, "baseRed" | "baseRedCache" | "baseRedUnconfirmed"> | undefined): string {
 const red = probe?.baseRed ?? [];
 const cache = probe?.baseRedCache;
 const confirmation = probe?.baseRedUnconfirmed;
 const provenance = cache === undefined ? "" : cacheProvenance(cache.sha, cache.probes, true);
 return (red.length === 0 ? "" : confirmation === undefined
  ? ` Not gating: ${red.join(", ")} failed here and fail at the merge base too.`
  : ` Not gating: ${red.join(", ")} failed here; inheritance uses the first base comparison or confirmed cache.`) +
  (provenance === "" ? "" : ` ${provenance}.`) +
  (confirmation === undefined ? "" : ` ${unconfirmedBaseNote(repo, confirmation.sha, confirmation.probes, confirmation.exit)}`);
}

export function readyBody(
 ctx: ImplementContext,
 final: RecordedReview,
 rounds: number,
 probe?: RecordedProbe,
): string {
 const noun = changeRequestNoun(ctx.map.repo);
 const ratify = ctx.map.autoMerge
  ? `Ranger squash-merges this itself once the gate passes, unless the node is labelled \`${NEEDS_EYE_LABEL}\`; then the principal merges by hand.${ctx.ratify === "merge" ? " For this `propose` node the merge is the ratification." : ""} Ranger closes the node after the merge.`
  : ctx.ratify === "merge"
   ? `This node is \`propose\`: **merging this ${noun} is the ratification**. Ranger closes the node after the merge.`
   : `Ranger closes the node after the merge, through its declared probes and this ${noun}'s CI run.`;
 return [
  `Implements ${nodeLink(ctx)}: ${ctx.node.node.title}`,
  "",
  `- Tests: ${testsReceipt(ctx.map.commands.test, "in the supervisor", recordedTestsBaseRed(ctx.journal, ctx.map.repo, ctx.node.ref.id))}`,
  `- Sage: ${rounds} offline round(s); the last, at \`${final.sha.slice(0, 8)}\`, found ${final.blockers} blockers, ${final.majors} majors, ${final.nits} nits. Machine review evidence, not a human sign-off.`,
  ...probeLine(ctx, probe),
  // An autoMerge map's ranger does merge: never say otherwise beside it.
  `- Merge: ${ctx.map.autoMerge ? "" : "ranger never merges. "}${ratify}`,
  "",
  // GitLab's merge method may add its own merge commit beside the squash one.
  `${forgeName(ctx.map.repo) === "GitLab" ? "Squash-merge lands the node's commits as one squash commit; the project's merge method may add a merge commit beside it." : "Squash-merge keeps one commit per node."} The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate.`,
 ].join("\n");
}

function unfixedFindingsLine(ctx: ImplementContext, pr: ChangeRequest, final: RecordedReview | undefined, review: ScribeFilings["review"]): string {
 if (final === undefined || leftFindings(final) === 0) return "None.";
 const counts = `${final.blockers} blocker(s), ${final.majors} major(s) and ${final.nits} nit(s) from the last sage round`;
 const noun = changeRequestNoun(ctx.map.repo);
 if (review === undefined) return `${counts} are on the ${noun}, not filed back.`;
 if ("proseLeft" in review) return `${counts} stay on the ${noun} (${changeRequestUrl(ctx.map.repo, pr.iid, pr.webUrl)}); prose-only findings are not filed back.`;
 if ("node" in review) return `${counts}, split out as node #${review.node} below this node.`;
 return `${counts} are on the ${noun}; filing them back failed (${review.error}).`;
}

export function closeResolution(
 ctx: ImplementContext,
 pr: ChangeRequest,
 final: RecordedReview | undefined,
 rounds: number,
 ci: Extract<CiVerdict, { state: "green" }>,
 probe?: RecordedProbe,
 filings: ScribeFilings = {},
): string {
 const deferred = unfixedFindingsLine(ctx, pr, final, filings.review);
 const landmines = filings.landmines;
 const landmineLine = landmines === undefined
  ? []
  : ["unread" in landmines
   ? `- Marker comments: the merge's diff could not be read, so none were filed (${landmines.unread}).`
   : "node" in landmines
    ? `- Marker comments: the merge added ${landmines.count}, filed as node #${landmines.node} below this node.`
    : `- Marker comments: the merge added ${landmines.count}; filing them back failed (${landmines.error}).`];
 return [
  `Implemented by ranger's implement lane in ${changeRequestLabel(ctx.map.repo, pr.iid)} (${changeRequestUrl(ctx.map.repo, pr.iid, pr.webUrl)}), merged by ${pr.mergedBy ?? "an unknown login"}${pr.mergeCommitSha === null ? "" : ` as ${pr.mergeCommitSha.slice(0, 8)}`}.`,
  "",
  `- Tests: ${testsReceipt(ctx.map.commands.test, "in the supervisor", recordedTestsBaseRed(ctx.journal, ctx.map.repo, ctx.node.ref.id))} CI ${ciRunText(ctx.map.repo, ci, "receipt")} succeeded on the ${changeRequestNoun(ctx.map.repo)} head ${pr.headSha.slice(0, 8)}.`,
  final === undefined
   ? "- Sage: no recorded review round."
   : `- Sage: ${rounds} offline round(s); the last at ${final.sha.slice(0, 8)} found ${final.blockers} blockers, ${final.majors} majors, ${final.nits} nits (machine evidence).`,
  ...probeLine(ctx, probe),
  `- Ratification: ${ctx.ratify === "merge" ? `${ratificationText(ctx, pr)}.` : "auto node; declared probes and CI."}`,
  `- Unfixed review findings: ${deferred}`,
  ...landmineLine,
 ].join("\n");
}

/**
 * Who ratified a propose node: the principal's own merge, or ranger's merge
 * under the principal's standing grant (2026-10-03: ranger merges nodes that
 * need no visual judgment; a `ranger:needs-eye` node is merged by hand).
 */
function ratificationText(ctx: ImplementContext, pr: ChangeRequest): string {
 return pr.mergedBy !== null && pr.mergedBy === principalLoginForRepo(ctx.config, ctx.map.repo)
  ? `the principal merged ${changeRequestLabel(ctx.map.repo, pr.iid)} (merge = ratification, #23 ruling)`
  : `${pr.mergedBy ?? "ranger"} merged ${changeRequestLabel(ctx.map.repo, pr.iid)} under the principal's standing grant (2026-10-03: ranger merges nodes that need no visual judgment)`;
}

export function gistLine(repo: string, title: string, pr: number): string {
 const raw = `${title} — ${changeRequestLabel(repo, pr)}`;
 return raw.length > 140 ? `${raw.slice(0, 137)}…` : raw;
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { commandFailure, deployLockFile, runShellCommand, type DeployRun } from "./deploy.ts";
import type { RunResult } from "./exec.ts";
import { parseForgeRef, repoIdentity } from "./forge-ref.ts";
import * as github from "./github.ts";
import type { Journal } from "./journal.ts";
import { implementLane } from "./lanes.ts";
import { withOwnedLease } from "./lock.ts";
import { resolveReadOnlyToken } from "./token-gate.ts";
import { workerHostEnv } from "./worker-env.ts";

/**
 * Where a park that waits for another repo's release reads that repo: its
 * newest release tag, and its base's head with the commits that tag lacks.
 */
export interface ReleaseReads {
 latestTag(repo: string): Promise<string | null>;
 sinceTag(repo: string, tag: string | null, branch: string): Promise<{ head: string; ahead: number }>;
}

/** Release reads through the GitHub API under the upstream repo's read-only token. */
export function githubReleaseReads(config: RangerConfig): ReleaseReads {
 const token = (repo: string) => {
  if (parseForgeRef(repo).forge !== "github") throw new Error(`${repo} is not on GitHub, the only forge ranger reads releases from`);
  return resolveReadOnlyToken(config, repo);
 };
 return {
  latestTag: async (repo) => {
   const read = token(repo);
   return github.latestReleaseTag(repo, read.token, read.source);
  },
  sinceTag: async (repo, tag, branch) => {
   const read = token(repo);
   return github.commitsSinceTag(repo, tag, branch, read.token, read.source);
  },
 };
}

export const RELEASE_TIMEOUT_MS = 15 * 60_000;
const LOCK_WAIT_BEYOND_A_RELEASE_MS = 60_000;

interface ReleaseWatch {
 upstream: string;
 tag: string | null;
 generation: number;
 seen?: string;
}

/** The health key of the release watch a parked node's row carries. */
export function releaseWatchKey(repo: string, nodeId: string): string {
 return `release-watch.${repo}#${nodeId}`;
}

function readWatch(value: string | null): ReleaseWatch | null {
 if (value === null) return null;
 try {
  const watch = JSON.parse(value) as Partial<ReleaseWatch> | null;
  if (typeof watch?.upstream !== "string" || typeof watch.generation !== "number") return null;
  if (watch.tag !== null && typeof watch.tag !== "string") return null;
  return { upstream: watch.upstream, tag: watch.tag, generation: watch.generation, ...(typeof watch.seen === "string" ? { seen: watch.seen } : {}) };
 } catch (error) {
  if (error instanceof SyntaxError) return null;
  throw error;
 }
}

/** The health key that marks a release of `upstream` at `head` as requested: one request per upstream head. */
export function releaseRequestKey(upstream: string, head: string): string {
 return `release.${repoIdentity(parseForgeRef(upstream))}.${head}`;
}

export interface ReleasePark {
 config: RangerConfig;
 journal: Journal;
 map: RangerMapConfig;
 node: { id: string; title: string };
 generation: number;
 upstream: string;
 reads: ReleaseReads;
 announce: (text: string) => Promise<unknown>;
 fence: () => void;
 run?: DeployRun;
 now?: () => Date;
}

const short = (sha: string) => sha.slice(0, 8);

function sameRepo(a: string, b: string): boolean {
 return repoIdentity(parseForgeRef(a)) === repoIdentity(parseForgeRef(b));
}

function message(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}

/**
 * Park a node that waits for `upstream`'s next release (`Needs-release:`).
 * Nothing is filed in the parked node's repo, where no worker could cut that
 * release. The upstream's newest tag is recorded for the release watch, which
 * queues the node's resume once a newer tag appears. When `upstream` is one of
 * ranger's maps with `commands.release` and its base has commits the tag
 * lacks, ranger cuts the release itself, at most once per upstream head;
 * otherwise the principal is asked once per park.
 */
export async function parkForRelease(park: ReleasePark): Promise<void> {
 const { config, map, node, upstream } = park;
 let tag: string | null;
 try {
  tag = await park.reads.latestTag(upstream);
 } catch (error) {
  await escalate(park, `Ranger cannot read ${upstream}'s releases (${message(error)}), so nothing watches for one: resume #${node.id} by hand once ${upstream} has the release.`);
  return;
 }
 park.fence();
 park.journal.setHealth(releaseWatchKey(map.repo, node.id), JSON.stringify({ upstream, tag, generation: park.generation } satisfies ReleaseWatch));
 const since = tag ?? "no release";
 const target = config.maps.find((m) => sameRepo(m.repo, upstream) && m.commands.release !== undefined);
 const command = target?.commands.release;
 if (target === undefined || command === undefined) {
  await escalate(park, `${upstream} has no release command in ranger's config: cut a release of ${upstream} (newest now: ${since}), and ranger resumes #${node.id} when its tag appears.`);
  return;
 }
 let head: { head: string; ahead: number };
 try {
  head = await park.reads.sinceTag(upstream, tag, target.base);
 } catch (error) {
  await escalate(park, `Ranger cannot compare ${upstream}'s ${target.base} with ${since} (${message(error)}): cut the release by hand, and ranger resumes #${node.id} when its tag appears.`);
  return;
 }
 if (head.ahead === 0) {
  await escalate(park, `${upstream}'s ${target.base} has no commits since ${since}: the change #${node.id} needs is not merged there yet. Ranger resumes #${node.id} when a new release tag appears.`);
  return;
 }
 await cutRelease(park, target, command, head.head);
}

function record(park: ReleasePark, kind: "release-requested" | "release-cut" | "release-failed" | "release-escalated", detail: string): void {
 park.journal.recordEvent(kind, { nodeId: park.node.id, repo: park.map.repo, detail: detail.slice(0, 400) });
}

async function notify(park: ReleasePark, kind: "release-cut" | "release-failed" | "release-escalated", text: string): Promise<void> {
 try {
  await park.announce(text);
 } catch (error) {
  record(park, kind, `the release notice did not post: ${message(error)}`);
 }
}

async function cutRelease(park: ReleasePark, target: RangerMapConfig, command: string, head: string): Promise<void> {
 const { journal, map, node, upstream } = park;
 const key = releaseRequestKey(upstream, head);
 const run = park.run ?? runShellCommand;
 let result: RunResult | null;
 try {
  result = await withOwnedLease(
   deployLockFile(journal.path, target.repo),
   {
    timeoutMs: RELEASE_TIMEOUT_MS + LOCK_WAIT_BEYOND_A_RELEASE_MS,
    contended: () => new Error(`another deploy or release of ${upstream} still holds the lock`),
    lost: (why) => new Error(`lost the release lock for ${upstream}: ${why}`),
    rejectExpired: true,
   },
   async (owned) => {
    if (journal.getHealth(key) !== null) return null;
    park.fence();
    owned();
    journal.setHealth(key, JSON.stringify({ node: `${map.repo}#${node.id}`, at: (park.now?.() ?? new Date()).toISOString() }));
    record(park, "release-requested", `cutting a release of ${upstream} at ${short(head)} for #${node.id} (${command})`);
    const scratch = mkdtempSync(join(tmpdir(), "ranger-release-"));
    try {
     return await run(command, {
      cwd: scratch,
      env: { ...workerHostEnv(), RANGER_RELEASE_REPO: upstream, RANGER_RELEASE_HEAD: head },
      timeoutMs: RELEASE_TIMEOUT_MS,
      processGroup: true,
     });
    } finally {
     rmSync(scratch, { recursive: true, force: true });
    }
   },
  );
 } catch (error) {
  record(park, "release-failed", `release of ${upstream} at ${short(head)} FAILED: ${message(error)}`);
  await notify(park, "release-failed", `🔴 Ranger could not cut a release of ${upstream} for node #${node.id}: ${message(error)}`);
  return;
 }
 if (result === null) {
  record(park, "release-requested", `a release of ${upstream} at ${short(head)} was already requested; #${node.id} waits for its tag`);
  return;
 }
 if (result.code !== 0) {
  const why = commandFailure(result, RELEASE_TIMEOUT_MS);
  record(park, "release-failed", `release of ${upstream} at ${short(head)} FAILED: ${why}`);
  await notify(park, "release-failed", `🔴 Ranger's release of ${upstream} at \`${short(head)}\` for node #${node.id} failed: ${why}`);
  return;
 }
 const tag = result.stdout.trim().split("\n").pop()?.trim().slice(0, 100) ?? "";
 const cut = tag === "" ? `a release of ${upstream}` : `${upstream} ${tag}`;
 record(park, "release-cut", `cut ${cut} at ${short(head)} for #${node.id}`);
 await notify(park, "release-cut", `🏷️ Ranger cut ${cut} at \`${short(head)}\`: node #${node.id} resumes once the release watch sees the tag.`);
}

async function escalate(park: ReleasePark, why: string): Promise<void> {
 const { journal, map, node } = park;
 const key = `release-escalated.${map.repo}#${node.id}.${park.generation}`;
 if (journal.getHealth(key) !== null) return;
 journal.setHealth(key, (park.now?.() ?? new Date()).toISOString());
 record(park, "release-escalated", why);
 await notify(park, "release-escalated", `🙋 Node #${node.id} (${node.title}) waits for a release of ${park.upstream}. ${why}`);
}

/**
 * The release watch: every parked row whose park recorded an upstream tag is
 * queued for a resume once that upstream's newest release tag differs. Each
 * upstream is read once per pass; a watch fires once, and a newer park of the
 * node records its own. Returns the reads that failed.
 */
export async function watchReleases(args: { journal: Journal; maps: readonly RangerMapConfig[]; reads: ReleaseReads }): Promise<{ map: RangerMapConfig; error: string }[]> {
 const { journal, reads } = args;
 const tags = new Map<string, Promise<string | null>>();
 const errors: { map: RangerMapConfig; error: string }[] = [];
 for (const map of args.maps) {
  for (const row of journal.listWorkers(map.repo, map.root)) {
   if (row.status !== "parked") continue;
   const key = releaseWatchKey(map.repo, row.nodeId);
   const watch = readWatch(journal.getHealth(key));
   if (watch?.generation !== row.generation || watch.seen !== undefined) continue;
   let latest: string | null;
   try {
    const read = tags.get(watch.upstream) ?? reads.latestTag(watch.upstream);
    tags.set(watch.upstream, read);
    latest = await read;
   } catch (error) {
    errors.push({ map, error: `release watch for #${row.nodeId} could not read ${watch.upstream}: ${message(error)}` });
    continue;
   }
   if (latest === null || latest === watch.tag) continue;
   journal.setHealth(key, JSON.stringify({ ...watch, seen: latest } satisfies ReleaseWatch));
   journal.recordEvent("release-seen", { nodeId: row.nodeId, repo: map.repo, detail: `${watch.upstream} released ${latest} (parked at ${watch.tag ?? "no release"}): #${row.nodeId} queued to resume` });
   journal.enqueueResume({ nodeId: row.nodeId, repo: map.repo, root: map.root, lane: implementLane(map) });
  }
 }
 return errors;
}

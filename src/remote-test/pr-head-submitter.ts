import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { RangerConfig } from "../config.ts";
import { runCmd } from "../exec.ts";
import { parseForgeRef, qualifiedRepo } from "../forge-ref.ts";
import { repositoryCloneUrl } from "../forge-text.ts";
import { listPullRequestHeads, type GhApi, type PullRequestHead } from "../github.ts";
import { resolveReadOnlyToken } from "../token-gate.ts";
import { privateDirectory, syncDirectory } from "./artifacts.ts";
import { privateOperatorPath } from "./baseline.ts";
import { validateBusConfig } from "./bus-contract.ts";
import { runBusCommand, type BusProducerInjected, type BusRunOutcome } from "./bus-producer.ts";
import { type ProfileManifest, type RemoteTestJob } from "./contract.ts";
import { readPrivateJson, saveJob } from "./ssh-cli.ts";
import { validateSshConfig } from "./ssh-client.ts";

const repositoryName = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
type Request = Omit<RemoteTestJob, "commitDigest" | "treeDigest" | "bundleDigest">;
export interface PrProfileBinding { repo: string; profile: ProfileManifest }
export type PrScanCode = "submitted" | "uncertain" | "refused" | "not_staged" | "submission_failed" |
 "duplicate" | "closed" | "fork" | "no_reviewed_binding" | "invalid_head" | "fetch_failed" | "list_failed" | "unsupported_repository";
export interface PrScanEvent { repo: string; pr: number | null; sha: string; profileId: string | null; code: PrScanCode }

export class PrSubmissionLedger {
 constructor(private db: Database, private now: () => number = Date.now) {
  db.run(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS scopes (repo TEXT NOT NULL, pr INTEGER NOT NULL, profile TEXT NOT NULL, correlation TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(repo,pr,profile));
   CREATE TABLE IF NOT EXISTS requests (repo TEXT NOT NULL, sha TEXT NOT NULL, profile TEXT NOT NULL, pr INTEGER NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repo,sha,profile));
   CREATE TABLE IF NOT EXISTS journal (at INTEGER NOT NULL, repo TEXT NOT NULL, pr INTEGER, sha TEXT NOT NULL, profile TEXT, code TEXT NOT NULL);`);
 }
 close() { this.db.close(); }
 has(repo: string, sha: string, profile: string): boolean {
  return this.db.query("SELECT 1 FROM requests WHERE repo=? AND sha=? AND profile=?").get(repo, sha, profile) !== null;
 }
 claim(repo: string, pr: number, sha: string, profile: ProfileManifest, deadline: number, boundRepo = repo): Request | null {
  return this.db.transaction(() => {
   if (this.has(repo, sha, profile.profileId)) return null;
   const scope = this.db.query("SELECT correlation,generation FROM scopes WHERE repo=? AND pr=? AND profile=?").get(repo, pr, profile.profileId) as { correlation: string; generation: number } | null;
   const correlationId = scope?.correlation ?? randomUUID(), generation = (scope?.generation ?? 0) + 1;
   const request: Request = {
    version: 1, jobId: randomUUID(), correlationId, repositoryId: qualifiedRepo(parseForgeRef(boundRepo)),
    profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest,
    imageDigest: profile.imageDigest, platform: profile.platform, deadline, generation,
   };
   this.db.query("INSERT INTO scopes VALUES(?,?,?,?,?) ON CONFLICT(repo,pr,profile) DO UPDATE SET generation=excluded.generation").run(repo, pr, profile.profileId, correlationId, generation);
   this.db.query("INSERT INTO requests(repo,sha,profile,pr,request,state) VALUES(?,?,?,?,?,'reserved')").run(repo, sha, profile.profileId, pr, JSON.stringify(request));
   return request;
  }).immediate();
 }
 abandon(repo: string, sha: string, profile: string) {
  this.db.query("DELETE FROM requests WHERE repo=? AND sha=? AND profile=? AND state='reserved'").run(repo, sha, profile);
 }
 finish(event: PrScanEvent, generation: number) {
  this.db.transaction(() => {
   this.db.query("UPDATE requests SET state=? WHERE repo=? AND sha=? AND profile=?").run(event.code, event.repo, event.sha, event.profileId);
   if (event.code === "submitted" || event.code === "uncertain") {
    this.db.query("UPDATE requests SET superseded=1 WHERE repo=? AND pr=? AND profile=? AND json_extract(request,'$.generation')<?").run(event.repo, event.pr, event.profileId, generation);
   }
   this.record(event);
  }).immediate();
 }
 record(event: PrScanEvent) {
  this.db.query("INSERT INTO journal VALUES(?,?,?,?,?,?)").run(this.now(), event.repo, event.pr, event.sha, event.profileId, event.code);
 }
 events(): PrScanEvent[] {
  return this.db.query("SELECT repo,pr,sha,profile AS profileId,code FROM journal ORDER BY rowid").all() as PrScanEvent[];
 }
}

async function privateRoot(root: string): Promise<string> {
 const path = await privateOperatorPath(root);
 try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(path);
 return path;
}

export async function openPrSubmissionLedger(root: string, now: () => number = Date.now): Promise<PrSubmissionLedger> {
 const path = join(await privateRoot(root), "pr-submissions.sqlite");
 const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Unsafe PR submission ledger");
  await file.sync();
 } finally { await file.close(); }
 const ledger = new PrSubmissionLedger(new Database(path, { strict: true }), now);
 await syncDirectory(root);
 return ledger;
}

export type HeadGitRunner = typeof runCmd;
export async function fetchPrHead(input: { repo: string; sha: string; root: string; token: string }, runner: HeadGitRunner = runCmd): Promise<{ worktree: string; release(): Promise<void> }> {
 if (!repositoryName.test(input.repo) || !commitId.test(input.sha)) throw Error("Invalid immutable PR source");
 const root = await privateRoot(input.root), worktree = join(root, `source-${randomUUID()}`);
 const sourceUrl = repositoryCloneUrl(input.repo);
 await mkdir(worktree, { mode: 0o700 });
 const env = {
  PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1",
 };
 const git = async (args: string[], authenticated = false) => {
  const result = await runner("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", ...args], {
   cwd: worktree, env: { ...env, ...(authenticated && {
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${new URL(sourceUrl).origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
   }) }, timeoutMs: 120_000, processGroup: true,
  });
  if (result.code !== 0) throw Error("Immutable PR source unavailable");
  return result.stdout.trim();
 };
 try {
  await git(["init", "--template=", ...(input.sha.length === 64 ? ["--object-format=sha256"] : []), "."]);
  await git(["-c", "http.followRedirects=false", "fetch", "--no-tags", "--no-recurse-submodules", "--", sourceUrl, input.sha], true);
  await git(["checkout", "--detach", input.sha, "--"]);
  if (await git(["rev-parse", "--verify", "HEAD"]) !== input.sha) throw Error("Immutable PR source mismatch");
  return { worktree, release: () => rm(worktree, { recursive: true, force: true }) };
 } catch (e) { await rm(worktree, { recursive: true, force: true }); throw e; }
}

export interface PrHeadScanDeps {
 ledger: PrSubmissionLedger;
 list(repo: string): Promise<PullRequestHead[]>;
 fetch(repo: string, sha: string): Promise<{ worktree: string; release(): Promise<void> }>;
 submit(input: { request: Request; worktree: string; expectedCommit: string }): Promise<BusRunOutcome>;
 now?: () => number;
}

export async function scanAndSubmitPrHeads(repositories: string[], bindings: PrProfileBinding[], deadlineSeconds: number, deps: PrHeadScanDeps): Promise<PrScanEvent[]> {
 const events: PrScanEvent[] = [], now = deps.now ?? Date.now;
 const record = (event: PrScanEvent) => { deps.ledger.record(event); events.push(event); };
 for (const repo of new Set(repositories.map(repo => repo.toLowerCase()))) {
  if (!repositoryName.test(repo)) { record({ repo, pr: null, sha: "", profileId: null, code: "unsupported_repository" }); continue; }
  let prs: PullRequestHead[];
  try { prs = await deps.list(repo); }
  catch { record({ repo, pr: null, sha: "", profileId: null, code: "list_failed" }); continue; }
  const profiles = bindings.filter(binding => binding.repo.toLowerCase() === repo);
  for (const pr of prs) {
   const base = { repo, pr: pr.number, sha: pr.headSha, profileId: null };
   if (pr.state !== "open") { record({ ...base, code: "closed" }); continue; }
   if (pr.headRepository?.toLowerCase() !== repo || pr.baseRepository?.toLowerCase() !== repo) { record({ ...base, code: "fork" }); continue; }
   if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || !commitId.test(pr.headSha)) { record({ ...base, code: "invalid_head" }); continue; }
   if (profiles.length === 0) { record({ ...base, code: "no_reviewed_binding" }); continue; }
   for (const { profile, repo: boundRepo } of profiles) {
    const event = { ...base, profileId: profile.profileId };
    if (deps.ledger.has(repo, pr.headSha, profile.profileId)) { record({ ...event, code: "duplicate" }); continue; }
    const request = deps.ledger.claim(repo, pr.number, pr.headSha, profile, now() + deadlineSeconds * 1000, boundRepo);
    if (!request) { record({ ...event, code: "duplicate" }); continue; }
    let source: Awaited<ReturnType<PrHeadScanDeps["fetch"]>>;
    try { source = await deps.fetch(repo, pr.headSha); }
    catch { deps.ledger.abandon(repo, pr.headSha, profile.profileId); record({ ...event, code: "fetch_failed" }); continue; }
    try {
     let code: PrScanCode;
     try { code = (await deps.submit({ request, worktree: source.worktree, expectedCommit: pr.headSha })).status; }
     catch { code = "submission_failed"; }
     const outcome = { ...event, code };
     deps.ledger.finish(outcome, request.generation); events.push(outcome);
    } finally { await source.release(); }
   }
  }
 }
 return events;
}

export interface PrHeadSubmitterRun {
 api?: GhApi;
 env?: NodeJS.ProcessEnv;
 now?: () => number;
 producer?: BusProducerInjected;
 fetch?: PrHeadScanDeps["fetch"];
}

export async function runPrHeadSubmitter(config: RangerConfig, run: PrHeadSubmitterRun = {}): Promise<PrScanEvent[]> {
 const settings = config.prHeadSubmitter;
 if (!settings) return [];
 const bus = validateBusConfig(await readPrivateJson(settings.busConfigFile));
 const ssh = validateSshConfig(await readPrivateJson(bus.ssh.configFile));
 const signer = z.object({ issuer: z.string() }).passthrough().parse(await readPrivateJson(settings.signerFile));
 const bindings: PrProfileBinding[] = [];
 for (const binding of bus.issuers.find(entry => entry.issuer === signer.issuer)?.bindings ?? []) {
  const profile = ssh.profiles.find(p => p.profileId === binding.profileId && p.profileDigest === binding.profileDigest);
  const repo = binding.repositoryId.startsWith("github:github.com/") ? binding.repositoryId.slice("github:github.com/".length) : "";
  if (profile && repositoryName.test(repo)) bindings.push({ repo, profile });
 }
 const root = await privateRoot(settings.stateRoot), ledger = await openPrSubmissionLedger(root, run.now);
 try {
  return await scanAndSubmitPrHeads([...config.maps.map(map => map.repo), ...bindings.map(binding => binding.repo)], bindings, settings.deadlineSeconds, {
   ledger, now: run.now,
   list: repo => listPullRequestHeads(repo, resolveReadOnlyToken(config, repo, run.env).token, run.api),
   fetch: run.fetch ?? ((repo, sha) => fetchPrHead({ repo, sha, root, token: resolveReadOnlyToken(config, repo, run.env).token })),
   async submit({ request, worktree, expectedCommit }) {
    const path = join(root, `${request.jobId}.request.json`);
    await saveJob(path, request);
    return await runBusCommand({ config: settings.busConfigFile, signer: settings.signerFile, request: path, worktree, stagingRoot: root,
     requestOutput: join(root, `${request.jobId}.bus.json`), expectedCommit }, { ...run.producer, ...(run.now && { now: run.now }) });
   },
  });
 } finally { ledger.close(); }
}

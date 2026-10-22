import { Database } from "bun:sqlite";
import { createHash, createPrivateKey } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import type { RangerConfig } from "../config.ts";
import { appChecksClient, openPullHeadsContaining, type AppChecks, type CheckConclusion, type CheckRunWrite, type GhApi } from "../github.ts";
import { resolveWriteToken } from "../identity.ts";
import { privateDirectory, syncDirectory } from "./artifacts.ts";
import { isOperatorPrivate, privateOperatorPath } from "./baseline.ts";
import { validateBusConfig } from "./bus-contract.ts";
import { openBusOutbox, type BusOutbox, type QueuedReceipt } from "./bus-outbox.ts";
import { validateJobIdentity, validateRemoteTestReceipt, type RemoteTestReceipt, type RemoteTestStatus } from "./contract.ts";

export const CHECK_NAME_PREFIX = "clawbox/";
export const checkNameFor = (profileId: string): string => `${CHECK_NAME_PREFIX}${profileId}`;

const CONCLUSIONS = {
 passed: "success",
 test_failed: "failure",
 infra_failed: "neutral",
 rejected: "neutral",
 timed_out: "timed_out",
 cancelled: "cancelled",
} as const satisfies Record<RemoteTestStatus, CheckConclusion>;

export type ReporterRefusalCode =
 | "not_in_outbox" | "unreadable" | "withheld" | "invalid_job" | "digest_mismatch"
 | "invalid_receipt" | "identity_mismatch" | "unsupported_repository";

/** The reader could not produce the receipt bytes; the reporter refuses rather than retries. */
export class UnreadableReceipt extends Error {
 override readonly name = "UnreadableReceipt";
}

export interface ReceiptReader {
 jobIds(): string[];
 read(jobId: string): Promise<QueuedReceipt | null>;
}

/** The App's checks surface plus the machine account's read of which open pull requests contain a commit. */
export interface ChecksClient extends AppChecks {
 openPullHeads(repo: string, commitDigest: string): Promise<string[]>;
}

export interface ReportedCheck {
 jobId: string;
 repo: string;
 headSha: string;
 checkName: string;
 checkRunId: number;
 conclusion: CheckConclusion;
 digest: string;
}

export interface RefusalRecord {
 jobId: string;
 code: ReporterRefusalCode;
 attempts: number;
}

/** Local, private record of what was written and what was refused. A job is acknowledged only once it is in `reported`. */
export class ReporterLedger {
 constructor(private db: Database, private now: () => number) {
  db.run("PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
  db.run(`CREATE TABLE IF NOT EXISTS reported (jobid TEXT PRIMARY KEY, repo TEXT NOT NULL, head_sha TEXT NOT NULL, check_name TEXT NOT NULL,
    check_run_id INTEGER NOT NULL, conclusion TEXT NOT NULL, digest TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS refusals (jobid TEXT NOT NULL, code TEXT NOT NULL, attempts INTEGER NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (jobid, code));`);
 }

 close() { this.db.close(); }

 reported(jobId: string): ReportedCheck | null {
  const row = this.db.query("SELECT jobid, repo, head_sha, check_name, check_run_id, conclusion, digest FROM reported WHERE jobid=?").get(jobId) as
   { jobid: string; repo: string; head_sha: string; check_name: string; check_run_id: number; conclusion: CheckConclusion; digest: string } | null;
  return row && { jobId: row.jobid, repo: row.repo, headSha: row.head_sha, checkName: row.check_name, checkRunId: row.check_run_id, conclusion: row.conclusion, digest: row.digest };
 }

 record(check: ReportedCheck) {
  this.db.transaction(() => {
   this.db.query("INSERT OR REPLACE INTO reported VALUES(?,?,?,?,?,?,?,?)")
    .run(check.jobId, check.repo, check.headSha, check.checkName, check.checkRunId, check.conclusion, check.digest, this.now());
   this.db.query("DELETE FROM refusals WHERE jobid=?").run(check.jobId);
  }).immediate();
 }

 refuse(jobId: string, code: ReporterRefusalCode) {
  const at = this.now();
  this.db.query("INSERT INTO refusals VALUES(?,?,1,?,?) ON CONFLICT(jobid, code) DO UPDATE SET attempts=attempts+1, last=excluded.last").run(jobId, code, at, at);
 }

 refusals(): RefusalRecord[] {
  return (this.db.query("SELECT jobid, code, attempts FROM refusals ORDER BY first, jobid").all() as { jobid: string; code: ReporterRefusalCode; attempts: number }[])
   .map(r => ({ jobId: r.jobid, code: r.code, attempts: r.attempts }));
 }
}

export async function openReporterLedger(root: string, now: () => number = Date.now): Promise<ReporterLedger> {
 const destination = await privateOperatorPath(root);
 try { await mkdir(destination, { mode: 0o700 }); await syncDirectory(dirname(destination)); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
 await privateDirectory(destination);
 const path = join(await realpath(destination), "check-reporter.sqlite");
 const created = await open(path, "a", 0o600);
 try { await created.sync(); } finally { await created.close(); }
 await chmod(path, 0o600);
 return new ReporterLedger(new Database(path, { strict: true }), now);
}

export type ReportOutcome =
 | { kind: "reported"; jobId: string; checkRunId: number; created: boolean; conclusion: CheckConclusion; superseded: boolean }
 | { kind: "refused"; jobId: string; code: ReporterRefusalCode };

export interface ReporterDeps {
 reader: ReceiptReader;
 github: ChecksClient;
 ledger: ReporterLedger;
}

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const GITHUB_REPOSITORY = /^github:github\.com\/([A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

function summaryOf(receipt: RemoteTestReceipt, digest: string, superseded: boolean): string {
 const { identity, evidence } = receipt;
 const lines = [
  `**Outcome:** ${receipt.status}`,
  `**Receipt digest:** ${digest}`,
  `**Profile:** ${identity.profileId}`,
  `**Commit:** ${identity.commitDigest}`,
  `**Tree:** ${identity.treeDigest}`,
  `**Lock:** ${identity.lockDigest}`,
  `**Image:** ${identity.imageDigest}`,
  `**Test exit code:** ${receipt.exitCode ?? "none"}`,
 ];
 if (evidence) lines.push(`**Duration:** ${evidence.durationMs} ms`);
 if (superseded) lines.push("", "The pull request head has moved since this job was submitted. This result is for an older commit and is not evidence for the current head.");
 return lines.join("\n");
}

function checkWrite(receipt: RemoteTestReceipt, digest: string, superseded: boolean): CheckRunWrite {
 const name = checkNameFor(receipt.identity.profileId);
 const conclusion = superseded ? "neutral" : CONCLUSIONS[receipt.status];
 return {
  name,
  headSha: receipt.identity.commitDigest,
  conclusion,
  title: `${name}: ${receipt.status}${superseded ? " (superseded)" : ""}`,
  summary: summaryOf(receipt, digest, superseded),
  externalId: receipt.identity.jobId,
  ...(receipt.evidence && { startedAtMs: receipt.evidence.startedAt }),
  completedAtMs: receipt.completedAt,
 };
}

/**
 * Turn one terminal receipt in the outbox into one check run on the receipt's own commit.
 * Every identity, digest and readability check fails closed into a locally recorded
 * refusal that writes nothing to GitHub. A GitHub, token or storage failure throws and
 * leaves the job unacknowledged, so a later run replays it. A second delivery finds the
 * existing check run by repository, commit and name and updates it.
 */
export async function processReceipt(deps: ReporterDeps, jobId: string): Promise<ReportOutcome> {
 const { reader, github, ledger } = deps;
 const refuse = (code: ReporterRefusalCode): ReportOutcome => { ledger.refuse(jobId, code); return { kind: "refused", jobId, code }; };

 let queued: QueuedReceipt | null;
 try { queued = await reader.read(jobId); }
 catch (e) { if (e instanceof UnreadableReceipt) return refuse("unreadable"); throw e; }
 if (queued === null) return refuse("not_in_outbox");
 if (queued.state === "withheld") return refuse("withheld");
 if (queued.receiptBytes === null) return refuse("unreadable");

 const parsedJob = (() => { try { return validateJobIdentity(queued.job); } catch { return null; } })();
 if (parsedJob === null) return refuse("invalid_job");
 if (parsedJob.jobId !== jobId || queued.jobId !== jobId) return refuse("identity_mismatch");

 const digest = sha256(queued.receiptBytes);
 if (digest !== queued.evidence) return refuse("digest_mismatch");

 let receipt: RemoteTestReceipt;
 try { receipt = validateRemoteTestReceipt(JSON.parse(queued.receiptBytes), parsedJob); }
 catch (e) { return refuse(e instanceof ZodError || e instanceof SyntaxError ? "invalid_receipt" : "identity_mismatch"); }

 const repo = GITHUB_REPOSITORY.exec(parsedJob.repositoryId)?.[1];
 if (repo === undefined) return refuse("unsupported_repository");

 const heads = await github.openPullHeads(repo, parsedJob.commitDigest);
 const superseded = heads.length > 0 && !heads.includes(parsedJob.commitDigest);
 const write = checkWrite(receipt, digest, superseded);
 const existing = await github.findCheckRun(repo, write.headSha, write.name);
 const checkRunId = existing ?? await github.createCheckRun(repo, write);
 if (existing !== null) await github.updateCheckRun(repo, existing, write);
 ledger.record({ jobId, repo, headSha: write.headSha, checkName: write.name, checkRunId, conclusion: write.conclusion, digest });
 return { kind: "reported", jobId, checkRunId, created: existing === null, conclusion: write.conclusion, superseded };
}

export interface ReportSummary {
 reported: Extract<ReportOutcome, { kind: "reported" }>[];
 refused: Extract<ReportOutcome, { kind: "refused" }>[];
 failed: { jobId: string; message: string }[];
}

/** Process one named job, or every outbox receipt not yet acknowledged. A failing job never blocks the others; callers exit non-zero on `failed`. */
export async function reportReceipts(deps: ReporterDeps, only?: string): Promise<ReportSummary> {
 const summary: ReportSummary = { reported: [], refused: [], failed: [] };
 const jobIds = only === undefined ? deps.reader.jobIds().filter(id => deps.ledger.reported(id) === null) : [only];
 for (const jobId of jobIds) {
  try {
   const outcome = await processReceipt(deps, jobId);
   if (outcome.kind === "reported") summary.reported.push(outcome); else summary.refused.push(outcome);
  } catch (e) {
   summary.failed.push({ jobId, message: e instanceof Error ? e.message.slice(0, 400) : String(e) });
  }
 }
 return summary;
}

export function outboxReceiptReader(outbox: BusOutbox): ReceiptReader {
 return {
  jobIds: () => outbox.receiptJobIds(),
  async read(jobId) {
   try { return await outbox.queuedReceipt(jobId); }
   catch (e) { if (e instanceof SyntaxError) throw new UnreadableReceipt("Stored outbox record is unreadable"); throw e; }
  },
 };
}

export interface CheckReporterRun {
 job?: string;
 env?: NodeJS.ProcessEnv;
 api?: GhApi;
 now?: () => number;
 pullHeads?: (repo: string, commitDigest: string) => Promise<string[]>;
}

async function readAppKey(path: string): Promise<string> {
 const file = await privateOperatorPath(path, true);
 if (!isOperatorPrivate(await stat(file))) throw Error("GitHub App key file must be operator-owned without group/world access");
 const pem = await readFile(file, "utf8");
 createPrivateKey(pem);
 return pem;
}

/**
 * Load the operator-local configuration and report. Throws, before any GitHub call,
 * when the opt-in block, the key, the bus configuration or the outbox is missing or
 * invalid. The App key path, App id and installation ids come only from that block.
 */
export async function runCheckReporter(config: RangerConfig, run: CheckReporterRun = {}): Promise<ReportSummary> {
 const settings = config.checkReporter;
 if (settings === undefined) throw Error("checkReporter is not configured");
 const privateKeyPem = await readAppKey(settings.privateKeyFile);
 const bus = validateBusConfig(JSON.parse(await readFile(await privateOperatorPath(settings.outbox.busConfigFile, true), "utf8")));
 const outbox = await openBusOutbox({ bus, root: settings.outbox.root, jobsRoot: settings.outbox.jobsRoot, executorId: settings.outbox.executorId, ...(run.now && { now: run.now }) });
 try {
  const ledger = await openReporterLedger(settings.stateRoot, run.now);
  try {
   const app = appChecksClient({ appId: settings.appId, privateKeyPem, installations: settings.installations, ...(run.api && { api: run.api }), ...(run.now && { now: run.now }) });
   const openPullHeads = run.pullHeads ?? ((repo, sha) => openPullHeadsContaining(repo, sha, resolveWriteToken(config, repo, run.env).token, run.api));
   return await reportReceipts({ reader: outboxReceiptReader(outbox), github: { ...app, openPullHeads }, ledger }, run.job);
  } finally { ledger.close(); }
 } finally { outbox.close(); }
}

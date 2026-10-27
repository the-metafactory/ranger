import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runCmd } from "../src/exec.ts";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { appChecksClient, type CheckRunWrite, type GhApi } from "../src/github.ts";
import { persistExecution } from "../src/remote-test/artifacts.ts";
import { validateBusConfig } from "../src/remote-test/bus-contract.ts";
import { openBusOutbox, openBusOutboxReader, type QueuedReceipt } from "../src/remote-test/bus-outbox.ts";
import {
 ReporterLedger, UnreadableReceipt, processReceipt, reportReceipts, runCheckReporter, sshReceiptReader,
 type ChecksClient, type ReceiptReader, type ReporterDeps, type ReporterRefusalCode,
} from "../src/remote-test/check-reporter.ts";
import { REMOTE_TEST_STATUSES, type RemoteTestJob, type RemoteTestReceipt, type RemoteTestStatus } from "../src/remote-test/contract.ts";
import { openJobLedger } from "../src/remote-test/job-ledger.ts";
import { getSshReceipt, listSshReceipts, type SshInvocation, type SshRunner } from "../src/remote-test/ssh-client.ts";
import { SSH_LIMITS, SshRequestSchema } from "../src/remote-test/ssh-protocol.ts";
import { serveSshResponse } from "../src/remote-test/ssh-server.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const COMMIT = "a".repeat(40);
const REPOSITORY = "github:github.com/example/repo";

function job(overrides: Partial<RemoteTestJob> = {}): RemoteTestJob {
 return { version: 1, jobId: randomUUID(), correlationId: randomUUID(), repositoryId: REPOSITORY, commitDigest: COMMIT, treeDigest: "b".repeat(40), bundleDigest: digest("a"), profileId: "unit", profileDigest: digest("a"), lockDigest: digest("c"), imageDigest: digest("d"), platform: "linux-arm64", deadline: 20_000, generation: 1, ...overrides };
}
const exitFor = (status: RemoteTestStatus) => status === "passed" ? 0 : status === "test_failed" ? 1 : null;
function receiptFor(j: RemoteTestJob, status: RemoteTestStatus = "passed", completedAt = 10_000): RemoteTestReceipt {
 return { version: 1, identity: j, executorId: "fixture", status, exitCode: exitFor(status), completedAt };
}
const bytesOf = (receipt: RemoteTestReceipt) => JSON.stringify(receipt) + "\n";
function queued(j: RemoteTestJob, receipt: RemoteTestReceipt = receiptFor(j), over: Partial<QueuedReceipt> = {}): QueuedReceipt {
 const bytes = bytesOf(receipt);
 return { jobId: j.jobId, job: j, evidence: sha256(bytes), state: "pending", receiptBytes: bytes, ...over };
}

function fakeReader(records: QueuedReceipt[], unreadable: string[] = [], revoked = new Set<string>()): ReceiptReader {
 return {
  jobIds: () => Promise.resolve(records.map(r => r.jobId)),
  authorized: (id) => Promise.resolve(!revoked.has(id)),
  read: (id) => {
   if (unreadable.includes(id)) throw new UnreadableReceipt("injected");
   return Promise.resolve(records.find(r => r.jobId === id) ?? null);
  },
 };
}

interface FakeChecks extends ChecksClient {
 creates: { repo: string; write: CheckRunWrite }[];
 updates: { repo: string; id: number; write: CheckRunWrite }[];
 heads: Map<string, string[]>;
 fail: { find?: Error; create?: Error };
}
function fakeChecks(): FakeChecks {
 const runs = new Map<string, number>();
 let next = 100;
 const key = (repo: string, sha: string, name: string) => `${repo}\n${sha}\n${name}`;
 const self: FakeChecks = {
  creates: [], updates: [], heads: new Map(), fail: {},
  openPullHeads: (repo, sha) => Promise.resolve(self.heads.get(`${repo}@${sha}`) ?? []),
  findCheckRun: (repo, sha, name) => self.fail.find ? Promise.reject(self.fail.find) : Promise.resolve(runs.get(key(repo, sha, name)) ?? null),
  createCheckRun: (repo, write) => {
   if (self.fail.create) return Promise.reject(self.fail.create);
   const id = next++;
   runs.set(key(repo, write.headSha, write.name), id);
   self.creates.push({ repo, write });
   return Promise.resolve(id);
  },
  updateCheckRun: (repo, id, write) => { self.updates.push({ repo, id, write }); return Promise.resolve(); },
 };
 return self;
}

function deps(records: QueuedReceipt[], github: ChecksClient = fakeChecks(), unreadable: string[] = [], revoked = new Set<string>()): ReporterDeps & { github: FakeChecks } {
 return { reader: fakeReader(records, unreadable, revoked), github: github as FakeChecks, ledger: new ReporterLedger(new Database(":memory:", { strict: true }), () => 1_000) };
}

test("a passed receipt whose identity equals the job creates exactly one success check on the receipt commit", async () => {
 const j = job(), d = deps([queued(j)]);
 const outcome = await processReceipt(d, j.jobId);
 expect(outcome).toMatchObject({ kind: "reported", created: true, conclusion: "success", superseded: false });
 expect(d.github.creates).toHaveLength(1);
 expect(d.github.updates).toHaveLength(0);
 const { repo, write } = d.github.creates[0];
 expect(repo).toBe("example/repo");
 expect(write).toMatchObject({ name: "clawbox/unit", headSha: COMMIT, conclusion: "success", externalId: j.jobId, completedAtMs: 10_000 });
 expect(write.summary).toContain("**Outcome:** passed");
 expect(write.summary).toContain(`**Receipt digest:** ${sha256(bytesOf(receiptFor(j)))}`);
 expect(d.ledger.reported(j.jobId)).toMatchObject({ checkName: "clawbox/unit", headSha: COMMIT, conclusion: "success" });
});

test("only a passed receipt concludes success; failure and infra failure carry the outcome and digest", async () => {
 const expected = { passed: "success", test_failed: "failure", infra_failed: "neutral", rejected: "neutral", timed_out: "timed_out", cancelled: "cancelled" } as const;
 for (const status of REMOTE_TEST_STATUSES) {
  const j = job(), receipt = receiptFor(j, status), d = deps([queued(j, receipt)]);
  await processReceipt(d, j.jobId);
  const { write } = d.github.creates[0];
  expect(write.conclusion).toBe(expected[status]);
  expect(write.summary).toContain(`**Outcome:** ${status}`);
  expect(write.summary).toContain(sha256(bytesOf(receipt)));
  expect(write.conclusion === "success").toBe(status === "passed");
 }
});

test("a superseded generation concludes neutral on the old commit and writes nothing on the new head", async () => {
 const j = job(), newHead = "f".repeat(40), d = deps([queued(j)]);
 d.github.heads.set(`example/repo@${COMMIT}`, [newHead]);
 const outcome = await processReceipt(d, j.jobId);
 expect(outcome).toMatchObject({ kind: "reported", conclusion: "neutral", superseded: true });
 expect(d.github.creates.map(c => c.write.headSha)).toEqual([COMMIT]);
 expect(d.github.creates[0].write.summary).toContain("head has moved");
 expect(d.github.creates[0].write.title).toContain("superseded");
});

test("an open pull request still headed at the commit keeps the real conclusion", async () => {
 const j = job(), d = deps([queued(j)]);
 d.github.heads.set(`example/repo@${COMMIT}`, ["f".repeat(40), COMMIT]);
 expect(await processReceipt(d, j.jobId)).toMatchObject({ conclusion: "success", superseded: false });
});

const identityFields: (keyof RemoteTestJob)[] = ["commitDigest", "treeDigest", "profileId", "profileDigest", "lockDigest", "imageDigest", "bundleDigest", "generation", "repositoryId"];
test("any receipt identity field that differs from the submitted job is refused without a write", async () => {
 const swapped: Partial<RemoteTestJob> = {
  commitDigest: "9".repeat(40), treeDigest: "8".repeat(40), profileId: "other", profileDigest: digest("9"), lockDigest: digest("9"),
  imageDigest: digest("9"), bundleDigest: digest("9"), generation: 2, repositoryId: "github:github.com/example/other",
 };
 for (const field of identityFields) {
  const j = job(), d = deps([queued(j, receiptFor({ ...j, [field]: swapped[field] }))]);
  expect(await processReceipt(d, j.jobId)).toEqual({ kind: "refused", jobId: j.jobId, code: "identity_mismatch" });
  expect(d.github.creates).toHaveLength(0);
  expect(d.github.updates).toHaveLength(0);
  expect(d.ledger.reported(j.jobId)).toBeNull();
  expect(d.ledger.refusals()).toEqual([{ jobId: j.jobId, code: "identity_mismatch", attempts: 1 }]);
 }
});

test("unreadable, unauthenticated, withheld, malformed and absent receipts are refused and recorded", async () => {
 const cases: [string, (j: RemoteTestJob) => { records: QueuedReceipt[]; unreadable?: string[]; id?: string }, ReporterRefusalCode][] = [
  ["bytes missing", j => ({ records: [queued(j, receiptFor(j), { receiptBytes: null })] }), "unreadable"],
  ["reader fails", j => ({ records: [queued(j)], unreadable: [j.jobId] }), "unreadable"],
  ["digest differs from the outbox evidence", j => ({ records: [queued(j, receiptFor(j), { evidence: digest("0") })] }), "digest_mismatch"],
  ["receipt rewritten after enqueue", j => ({ records: [queued(j, receiptFor(j), { evidence: sha256(bytesOf(receiptFor(j, "test_failed"))) })] }), "digest_mismatch"],
  ["withheld event", j => ({ records: [queued(j, receiptFor(j), { state: "withheld" })] }), "withheld"],
  ["not in the outbox", () => ({ records: [] }), "not_in_outbox"],
  ["stored job malformed", j => ({ records: [queued(j, receiptFor(j), { job: { ...j, commitDigest: "short" } })] }), "invalid_job"],
  ["stored job is another job", j => ({ records: [queued(j, receiptFor(j), { job: { ...j, jobId: randomUUID() } })] }), "identity_mismatch"],
  ["receipt not JSON", j => ({ records: [queued(j, receiptFor(j), { receiptBytes: "{", evidence: sha256("{") })] }), "invalid_receipt"],
  ["passed with a nonzero exit", j => ({ records: [queued(j, { ...receiptFor(j), exitCode: 1 })] }), "invalid_receipt"],
  ["not a GitHub repository", j => { const g = { ...j, repositoryId: "gitlab:gitlab.example/group/project" }; return { records: [queued(g)] }; }, "unsupported_repository"],
 ];
 for (const [label, build, code] of cases) {
  const j = job(), { records, unreadable } = build(j), id = records[0]?.jobId ?? j.jobId, d = deps(records, fakeChecks(), unreadable);
  const outcome = await processReceipt(d, id);
  expect({ label, outcome }).toEqual({ label, outcome: { kind: "refused", jobId: id, code } });
  expect(d.github.creates).toHaveLength(0);
  expect(d.ledger.reported(id)).toBeNull();
  expect(d.ledger.refusals().map(r => r.code)).toEqual([code]);
 }
});

test("a repeated refusal is counted, not duplicated", async () => {
 const j = job(), d = deps([queued(j, receiptFor(j), { evidence: digest("0") })]);
 await processReceipt(d, j.jobId);
 await processReceipt(d, j.jobId);
 expect(d.ledger.refusals()).toEqual([{ jobId: j.jobId, code: "digest_mismatch", attempts: 2 }]);
});

test("the same receipt delivered twice updates the existing check run instead of creating a second", async () => {
 const j = job(), d = deps([queued(j)]);
 const first = await processReceipt(d, j.jobId), second = await processReceipt(d, j.jobId);
 expect(first).toMatchObject({ kind: "reported", created: true });
 expect(second).toMatchObject({ kind: "reported", created: false });
 expect(d.github.creates).toHaveLength(1);
 expect(d.github.updates).toHaveLength(1);
 expect(d.github.updates[0].id).toBe((first as { checkRunId: number }).checkRunId);
 expect(d.github.updates[0].write).toEqual(d.github.creates[0].write);
});

test("two jobs for the same commit and profile share one check run key", async () => {
 const a = job(), b = job(), d = deps([queued(a), queued(b)]);
 await processReceipt(d, a.jobId);
 await processReceipt(d, b.jobId);
 expect(d.github.creates).toHaveLength(1);
 expect(d.github.updates).toHaveLength(1);
});

test("an older job retried after a newer job reported is acknowledged without overwriting the newer result", async () => {
 const older = job(), newer = job(), github = fakeChecks();
 const d = deps([queued(older, receiptFor(older, "passed", 10_000)), queued(newer, receiptFor(newer, "test_failed", 20_000))], github);
 github.fail.create = new Error("GitHub unavailable");
 expect((await reportReceipts(d, older.jobId)).failed).toHaveLength(1);
 github.fail = {};
 expect((await reportReceipts(d, newer.jobId)).reported).toMatchObject([{ jobId: newer.jobId, conclusion: "failure", created: true }]);

 const retry = await reportReceipts(d);
 expect(retry.failed).toEqual([]);
 expect(retry.reported).toEqual([]);
 expect(retry.stale).toEqual([{ kind: "stale", jobId: older.jobId, newerJobId: newer.jobId }]);
 expect(github.creates).toHaveLength(1);
 expect(github.updates).toHaveLength(0);
 expect(d.ledger.reported(older.jobId)).toMatchObject({ stale: true });
 expect(d.ledger.owner("example/repo", COMMIT, "clawbox/unit")).toMatchObject({ jobId: newer.jobId, conclusion: "failure" });
 expect((await reportReceipts(d)).stale).toEqual([]);
});

test("a newer job still replaces an older job's result on the same check run", async () => {
 const older = job(), newer = job(), d = deps([queued(older, receiptFor(older, "test_failed", 10_000)), queued(newer, receiptFor(newer, "passed", 20_000))]);
 await processReceipt(d, older.jobId);
 expect(await processReceipt(d, newer.jobId)).toMatchObject({ kind: "reported", created: false, conclusion: "success" });
 expect(d.github.updates.map(u => u.write.conclusion)).toEqual(["success"]);
});

test("a receipt whose ledger authorization was revoked after enqueue is refused without a write", async () => {
 const j = job(), d = deps([queued(j)], fakeChecks(), [], new Set([j.jobId]));
 expect(await processReceipt(d, j.jobId)).toEqual({ kind: "refused", jobId: j.jobId, code: "revoked" });
 expect(d.github.creates).toHaveLength(0);
 expect(d.github.updates).toHaveLength(0);
 expect(d.ledger.reported(j.jobId)).toBeNull();
 expect(d.ledger.refusals()).toEqual([{ jobId: j.jobId, code: "revoked", attempts: 1 }]);
});

test("a GitHub failure writes no acknowledgement and a later run replays the receipt", async () => {
 const j = job(), github = fakeChecks(), d = deps([queued(j)], github);
 github.fail.create = new Error("token request failed");
 const first = await reportReceipts(d);
 expect(first.failed).toEqual([{ jobId: j.jobId, message: "token request failed" }]);
 expect(first.reported).toEqual([]);
 expect(github.creates).toHaveLength(0);
 expect(d.ledger.reported(j.jobId)).toBeNull();
 expect(d.ledger.refusals()).toEqual([]);
 github.fail = {};
 const second = await reportReceipts(d);
 expect(second.failed).toEqual([]);
 expect(second.reported.map(r => r.jobId)).toEqual([j.jobId]);
 expect(github.creates).toHaveLength(1);
});

test("a batch skips acknowledged receipts, keeps going past a failure and reports refusals", async () => {
 const done = job(), broken = job(), refused = job(), fresh = job({ commitDigest: "e".repeat(40) });
 const records = [queued(done), queued(broken, receiptFor(broken), { receiptBytes: null }), queued(refused, receiptFor(refused), { evidence: digest("0") }), queued(fresh)];
 const github = fakeChecks(), d = deps(records, github);
 await processReceipt(d, done.jobId);
 const before = github.creates.length;
 const summary = await reportReceipts(d);
 expect(summary.reported.map(r => r.jobId)).toEqual([fresh.jobId]);
 expect(summary.refused.map(r => [r.jobId, r.code])).toEqual([[broken.jobId, "unreadable"], [refused.jobId, "digest_mismatch"]]);
 expect(github.creates.length - before).toBe(1);
 expect((await reportReceipts(d, done.jobId)).reported).toHaveLength(1);
 expect(github.updates).toHaveLength(1);
});

test("the App client mints a verifiable RS256 JWT, one installation token per owner, and writes with the installation token", async () => {
 const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
 const pem = privateKey.export({ type: "pkcs8", format: "pem" });
 const calls: { token: string; args: string[] }[] = [];
 const api: GhApi = (token, args) => {
  calls.push({ token, args });
  if (args[0] === "app/installations/77/access_tokens") return Promise.resolve({ token: "ghs_installation", expires_at: new Date(5_000_000 + 3_600_000).toISOString() });
  if (args[0]?.includes("/check-runs?")) return Promise.resolve([{ check_runs: [{ id: 4, name: "clawbox/unit", app: { id: 9 } }, { id: 8, name: "clawbox/unit", app: { id: 9 } }, { id: 99, name: "clawbox/unit", app: { id: 10 } }] }]);
  if (args[0] === "repos/Example/repo/check-runs") return Promise.resolve({ id: 321 });
  return Promise.resolve(null);
 };
 const client = appChecksClient({ appId: 9, privateKeyPem: pem, installations: { Example: 77 }, api, now: () => 5_000_000 });
 const write: CheckRunWrite = { name: "clawbox/unit", headSha: COMMIT, conclusion: "success", title: "t", summary: "s", externalId: "e", startedAtMs: 1_000, completedAtMs: 2_000 };

 expect(await client.findCheckRun("Example/repo", COMMIT, "clawbox/unit")).toBe(8);
 expect(await client.createCheckRun("Example/repo", write)).toBe(321);
 await client.updateCheckRun("Example/repo", 8, write);

 const [mint, find, create, update] = calls;
 const [header, payload, signature] = mint.token.split(".") as [string, string, string];
 expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
 expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 5_000 - 60, exp: 5_000 + 540, iss: 9 });
 expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
 expect(mint.args).toEqual(["app/installations/77/access_tokens", "--method", "POST"]);
 expect(calls.filter(c => c.args[0]?.startsWith("app/"))).toHaveLength(1);
 expect([find, create, update].map(c => c.token)).toEqual(["ghs_installation", "ghs_installation", "ghs_installation"]);
 expect(create.args).toContain("head_sha=" + COMMIT);
 expect(create.args).toContain("conclusion=success");
 expect(create.args).toContain("output[summary]=s");
 expect(update.args.slice(0, 3)).toEqual(["repos/Example/repo/check-runs/8", "--method", "PATCH"]);
 expect(update.args).not.toContain("head_sha=" + COMMIT);
});

test("a refused installation token request or a missing installation throws before any check write", async () => {
 const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
 const pem = privateKey.export({ type: "pkcs8", format: "pem" });
 const calls: string[] = [];
 const api: GhApi = (_token, args) => { calls.push(args[0]); return args[0].startsWith("app/") ? Promise.reject(new Error("401")) : Promise.resolve({ id: 1 }); };
 const refused = appChecksClient({ appId: 9, privateKeyPem: pem, installations: { example: 77 }, api });
 const write: CheckRunWrite = { name: "clawbox/unit", headSha: COMMIT, conclusion: "success", title: "t", summary: "s", externalId: "e", completedAtMs: 2_000 };
 await expect(refused.createCheckRun("example/repo", write)).rejects.toThrow("401");
 expect(calls).toEqual(["app/installations/77/access_tokens"]);
 const missing = appChecksClient({ appId: 9, privateKeyPem: pem, installations: { other: 5 }, api });
 await expect(missing.createCheckRun("example/repo", write)).rejects.toThrow(/no GitHub App installation/);
 expect(calls).toHaveLength(1);

 const garbled = appChecksClient({ appId: 9, privateKeyPem: "not a key", installations: { example: 77 }, api });
 await expect(garbled.findCheckRun("example/repo", COMMIT, "clawbox/unit")).rejects.toThrow();
 expect(calls).toHaveLength(1);
});

const PROFILE = { version: 1 as const, profileId: "unit", profileDigest: digest("a"), lockDigest: digest("c"), imageDigest: digest("d"), platform: "linux-arm64" as const, commands: [["bun", "test"]] as [string, ...string[]][] };

async function readFileBytes(path: string) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

async function operatorFixture() {
 const home = await mkdtemp(join(tmpdir(), "check-reporter-")); roots.push(home);
 const jobsRoot = join(home, "jobs"), outboxRoot = join(home, "outbox"), stateRoot = join(home, "state");
 await mkdir(jobsRoot, { mode: 0o700 });
 const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
 const keyFile = join(home, "app.pem"), busFile = join(home, "bus.json"), sshFile = join(home, "ssh.json"), configFile = join(home, "ranger.yaml");
 await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
 const sshConfig = { target: "executor", remoteCli: "/opt/ranger/src/cli.ts", remoteConfig: "/etc/ranger/executor.json", executorId: "fixture", profiles: [PROFILE] };
 const executorConfig = { executorId: "fixture", jobsRoot, outboxRoot, profiles: [{ profile: PROFILE, lockFile: "bun.lock", imageReference: `localhost/runtime@${PROFILE.imageDigest}` }] };
 await writeFile(sshFile, JSON.stringify(sshConfig), { mode: 0o600 });
 const bus = validateBusConfig({
  version: 1, target: { domain: "clawbox", account: "ci" }, routing: { classification: "local", principal: "jc", stack: "clawbox" },
  streams: { request: { stream: "CI_TEST_REQUESTS", durable: "ranger-ci" }, result: { stream: "CI_TEST_RESULTS" } },
  transport: { servers: ["nats://127.0.0.1:4222"], credentialsFile: "/operator/ci.creds" }, ssh: { configFile: sshFile },
  execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 60, progressIntervalSeconds: 10, maxDeliver: 3 },
  registry: { file: "/operator/registry.json" },
  issuers: [{ issuer: "did:myelin:ranger-ci", bindings: [{ repositoryId: REPOSITORY, profileId: "unit", profileDigest: digest("a") }] }],
 });
 await writeFile(busFile, JSON.stringify(bus), { mode: 0o600 });
 const yaml = (extra: object = {}) => stringify({
  maps: [{ repo: "example/repo", root: 1 }],
  checkReporter: { appId: 9, privateKeyFile: keyFile, installations: { example: 77 }, sshConfigFile: sshFile, stateRoot, ...extra },
 });
 const load = async (extra?: object): Promise<RangerConfig> => { await writeFile(configFile, yaml(extra)); await chmod(configFile, 0o600); return loadConfig(configFile, {}).config; };
 const ledger = await openJobLedger(jobsRoot, "fixture", () => 10_000);
 const enqueue = async (j: RemoteTestJob, status: RemoteTestStatus = "passed") => {
  const admitted = ledger.admit(j);
  if (admitted.kind !== "admitted") throw Error("not admitted");
  ledger.launch(j, admitted.token);
  const receipt = await persistExecution(join(jobsRoot, ".artifacts"), receiptFor(j, status),
   { startedAt: 9_000, log: Buffer.from("log\n"), truncated: false, outputState: "captured", resources: { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null } }, { now: () => 10_000 });
  ledger.complete(j, admitted.token, receipt);
  const outbox = await openBusOutbox({ bus, root: outboxRoot, jobsRoot, executorId: "fixture", now: () => 12_345 });
  try { await outbox.enqueueTerminal(j); } finally { outbox.close(); }
  return receipt;
 };
 const sent: { args: string[]; request: Record<string, unknown> }[] = [];
 const ssh = (fail: (request: Record<string, unknown>) => boolean = () => false): SshRunner => async (invocation: SshInvocation) => {
  const chunks: Buffer[] = [];
  for await (const chunk of invocation.input) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  sent.push({ args: invocation.args, request });
  if (fail(request)) return { code: 255, stdout: "" };
  return { code: 0, stdout: JSON.stringify(await serveSshResponse((async function* () { for (const chunk of chunks) yield chunk; })(), executorConfig)) + "\n" };
 };
 return { home, load, enqueue, stateRoot, ledger, jobsRoot, outboxRoot, sshConfig, executorConfig, sent, ssh, close: () => { ledger.close(); } };
}

test("the reporter reads receipts over the fixed SSH path and writes one check through the App client with synthetic keys", async () => {
 const f = await operatorFixture();
 try {
  const j = job(), receipt = await f.enqueue(j), config = await f.load();
  const requests: string[][] = [];
  const api: GhApi = (token, args) => {
   requests.push([token === "ghs_fake" ? "installation" : "other", ...args]);
   if (args[0]?.startsWith("app/")) return Promise.resolve({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
   if (args[0]?.includes("/check-runs?")) return Promise.resolve([{ check_runs: [] }]);
   return Promise.resolve({ id: 555 });
  };
  const summary = await runCheckReporter(config, { ssh: { runner: f.ssh() }, api, pullHeads: () => Promise.resolve([]) });
  expect(summary.failed).toEqual([]);
  expect(summary.reported).toMatchObject([{ jobId: j.jobId, checkRunId: 555, conclusion: "success", created: true }]);
  const create = requests.find(r => r.includes("repos/example/repo/check-runs"))!;
  expect(create).toContain("head_sha=" + COMMIT);
  expect(create).toContain("name=clawbox/unit");
  expect(create.some(a => a.includes(sha256(bytesOf(receipt))))).toBe(true);
  expect(create[0]).toBe("installation");

  const again = await runCheckReporter(config, { ssh: { runner: f.ssh() }, api, pullHeads: () => Promise.resolve([]) });
  expect(again.reported).toEqual([]);
  expect(requests.filter(r => r.includes("repos/example/repo/check-runs"))).toHaveLength(1);
 } finally { f.close(); }
});

test("a job cancelled in the ledger after its terminal receipt was enqueued writes no check", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  f.ledger.cancel(j);
  const config = await f.load(), writes: string[] = [];
  const api: GhApi = (_token, args) => {
   if (args[0]?.startsWith("app/")) return Promise.resolve({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
   if (args.includes("POST") || args.includes("PATCH")) writes.push(args[0]);
   return Promise.resolve(args[0]?.includes("/check-runs?") ? [{ check_runs: [] }] : { id: 1 });
  };
  const summary = await runCheckReporter(config, { ssh: { runner: f.ssh() }, api, pullHeads: () => Promise.resolve([]) });
  expect(summary.reported).toEqual([]);
  expect(summary.refused).toEqual([{ kind: "refused", jobId: j.jobId, code: "revoked" }]);
  expect(writes).toEqual([]);
 } finally { f.close(); }
});

test("a failing installation token request is reported as failed, writes no check and leaves the receipt for replay", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  const config = await f.load(), writes: string[] = [];
  let tokenOk = false;
  const api: GhApi = (_token, args) => {
   if (args[0]?.startsWith("app/")) return tokenOk ? Promise.resolve({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : Promise.reject(new Error("installation token request failed"));
   if (args.includes("POST") || args.includes("PATCH")) writes.push(args[0]);
   return Promise.resolve(args[0]?.includes("/check-runs?") ? [{ check_runs: [] }] : { id: 1 });
  };
  const failed = await runCheckReporter(config, { ssh: { runner: f.ssh() }, api, pullHeads: () => Promise.resolve([]) });
  expect(failed.failed).toHaveLength(1);
  expect(failed.reported).toEqual([]);
  expect(writes).toEqual([]);
  tokenOk = true;
  const replay = await runCheckReporter(config, { ssh: { runner: f.ssh() }, api, pullHeads: () => Promise.resolve([]) });
  expect(replay.reported.map(r => r.jobId)).toEqual([j.jobId]);
  expect(writes).toEqual(["repos/example/repo/check-runs"]);
 } finally { f.close(); }
});

test("missing or unusable App configuration throws before any outbox read or GitHub call", async () => {
 const f = await operatorFixture();
 try {
  const config = await f.load();
  const calls: string[] = [];
  const api: GhApi = (_t, args) => { calls.push(args[0]); return Promise.resolve(null); };
  await expect(runCheckReporter({ ...config, checkReporter: undefined }, { api })).rejects.toThrow("checkReporter is not configured");
  await expect(runCheckReporter(await f.load({ privateKeyFile: join(f.home, "missing.pem") }), { api })).rejects.toThrow();
  const loose = join(f.home, "loose.pem");
  await writeFile(loose, "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n", { mode: 0o644 });
  await expect(runCheckReporter(await f.load({ privateKeyFile: loose }), { api })).rejects.toThrow(/operator-owned/);
  await chmod(loose, 0o600);
  await expect(runCheckReporter(await f.load({ privateKeyFile: loose }), { api })).rejects.toThrow();
  expect(calls).toEqual([]);
 } finally { f.close(); }
});

test("the opt-in config block is optional and rejects relative paths, unknown keys and an empty installation map", async () => {
 const f = await operatorFixture();
 try {
  const path = join(f.home, "plain.yaml");
  await writeFile(path, stringify({ maps: [{ repo: "example/repo", root: 1 }] }));
  expect(loadConfig(path, {}).config.checkReporter).toBeUndefined();
  await expect(f.load({ privateKeyFile: "relative.pem" })).rejects.toThrow(/absolute path/);
  await expect(f.load({ installations: {} })).rejects.toThrow(/at least one installation/);
  await expect(f.load({ appId: 0 })).rejects.toThrow();
  await expect(f.load({ token: "ghp_inline" })).rejects.toThrow();
  await expect(f.load({ outbox: { root: "/o", jobsRoot: "/j", executorId: "fixture", busConfigFile: "/b" } })).rejects.toThrow();
  await expect(f.load({ sshConfigFile: "relative.json" })).rejects.toThrow(/absolute path/);
 } finally { f.close(); }
});

test("the CLI exits non-zero when the checkReporter block is missing", async () => {
 const f = await operatorFixture();
 try {
  const path = join(f.home, "plain.yaml");
  await writeFile(path, stringify({ maps: [{ repo: "example/repo", root: 1 }] }));
  const result = await runCmd(process.execPath, [join(import.meta.dir, "..", "src", "cli.ts"), "remote-test", "report-checks", "--config", path]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("checkReporter is not configured");
 } finally { f.close(); }
});

const apiFor = (writes: string[], tokenOk = () => true): GhApi => (_token, args) => {
 if (args[0]?.startsWith("app/")) return tokenOk() ? Promise.resolve({ token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) : Promise.reject(new Error("installation token request failed"));
 if (args.includes("POST") || args.includes("PATCH")) writes.push(args[0]);
 return Promise.resolve(args[0]?.includes("/check-runs?") ? [{ check_runs: [] }] : { id: 1 });
};
const noHeads = () => Promise.resolve([]);

test("report-checks lists and retrieves receipts only through the receipt-only SSH operations and sends no credential", async () => {
 const f = await operatorFixture();
 try {
  const a = job(), b = job({ commitDigest: "e".repeat(40) });
  await f.enqueue(a); await f.enqueue(b, "test_failed");
  const writes: string[] = [];
  const summary = await runCheckReporter(await f.load(), { ssh: { runner: f.ssh() }, api: apiFor(writes), pullHeads: noHeads });
  expect(summary.failed).toEqual([]);
  expect(summary.reported.map(r => [r.jobId, r.conclusion])).toEqual([[a.jobId, "success"], [b.jobId, "failure"]]);
  expect(f.sent.map(s => s.request.operation)).toEqual(["receipt-list", "receipt-get", "receipt-get", "receipt-get", "receipt-get"]);
  for (const { request, args } of f.sent) {
   expect(request.version).toBe(4);
   expect(Object.keys(request).sort()).toEqual(request.operation === "receipt-get" ? ["jobId", "operation", "version"] : ["operation", "version"]);
   expect(SshRequestSchema.safeParse(request).success).toBe(true);
   expect(args.slice(-2)[0]).toBe("executor");
   expect(args.slice(-1)[0]).toBe("'/opt/ranger/src/cli.ts' 'remote-test' 'serve-stdio' '--config' '/etc/ranger/executor.json'");
   expect(JSON.stringify(request)).not.toMatch(/BEGIN|ghs_|token|appId/i);
  }
  expect(writes).toEqual(["repos/example/repo/check-runs", "repos/example/repo/check-runs"]);
 } finally { f.close(); }
});

test("the receipt operations are read-only: the outbox store and receipt files are byte-identical afterwards", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  const store = join(f.outboxRoot, "outbox.sqlite"), exported = join(f.outboxRoot, "receipts", j.jobId + ".json");
  const before = [await readFileBytes(store), await readFileBytes(exported)];
  await runCheckReporter(await f.load(), { ssh: { runner: f.ssh() }, api: apiFor([]), pullHeads: noHeads });
  expect([await readFileBytes(store), await readFileBytes(exported)]).toEqual(before);
  await expect(openBusOutboxReader({ root: join(f.home, "absent"), jobsRoot: f.jobsRoot, executorId: "fixture" })).rejects.toThrow();
  await expect(Bun.file(join(f.home, "absent")).exists()).resolves.toBe(false);
  await expect(openBusOutboxReader({ root: f.outboxRoot, jobsRoot: f.jobsRoot, executorId: "other" })).rejects.toThrow(/different executor/);
 } finally { f.close(); }
});

test("a receipt file rewritten on the executor host after enqueue is a digest mismatch and writes no check", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j, "test_failed");
  await writeFile(join(f.outboxRoot, "receipts", j.jobId + ".json"), bytesOf(receiptFor(j, "passed")), { mode: 0o600 });
  const writes: string[] = [];
  const summary = await runCheckReporter(await f.load(), { ssh: { runner: f.ssh() }, api: apiFor(writes), pullHeads: noHeads });
  expect(summary.refused).toEqual([{ kind: "refused", jobId: j.jobId, code: "digest_mismatch" }]);
  expect(summary.reported).toEqual([]);
  expect(writes).toEqual([]);
 } finally { f.close(); }
});

test("a missing receipt file is refused as unreadable and an unknown job as not in the outbox, with no write", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  await rm(join(f.outboxRoot, "receipts", j.jobId + ".json"));
  const writes: string[] = [];
  const config = await f.load(), run = { ssh: { runner: f.ssh() }, api: apiFor(writes), pullHeads: noHeads };
  expect((await runCheckReporter(config, run)).refused).toEqual([{ kind: "refused", jobId: j.jobId, code: "unreadable" }]);
  const unknown = randomUUID();
  expect((await runCheckReporter(config, { ...run, job: unknown })).refused).toEqual([{ kind: "refused", jobId: unknown, code: "not_in_outbox" }]);
  expect(writes).toEqual([]);
 } finally { f.close(); }
});

test("a job cancelled on the executor host after enqueue is reported revoked through the receipt reply", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  f.ledger.cancel(j);
  const writes: string[] = [];
  const summary = await runCheckReporter(await f.load(), { ssh: { runner: f.ssh() }, api: apiFor(writes), pullHeads: noHeads });
  expect(summary.refused).toEqual([{ kind: "refused", jobId: j.jobId, code: "revoked" }]);
  expect(writes).toEqual([]);
 } finally { f.close(); }
});

test("an SSH failure leaves the receipt unacknowledged and the next run replays it", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  const config = await f.load(), writes: string[] = [];
  const run = (runner: SshRunner, extra: object = {}) => ({ ssh: { runner }, api: apiFor(writes), pullHeads: noHeads, ...extra });
  await expect(runCheckReporter(config, run(f.ssh(r => r.operation === "receipt-list")))).rejects.toThrow(/SSH receipt lookup failed/);
  const retrieval = await runCheckReporter(config, run(f.ssh(r => r.operation === "receipt-get")));
  expect(retrieval.failed).toEqual([{ jobId: j.jobId, message: "SSH receipt lookup failed" }]);
  expect(retrieval.refused).toEqual([]);
  expect(writes).toEqual([]);
  let gets = 0;
  const flaky = f.ssh(r => r.operation === "receipt-get" && ++gets === 2);
  const midway = await runCheckReporter(config, run(flaky));
  expect(midway.failed).toHaveLength(1);
  expect(writes).toEqual([]);
  const replay = await runCheckReporter(config, run(f.ssh()));
  expect(replay.reported.map(r => r.jobId)).toEqual([j.jobId]);
  expect(writes).toEqual(["repos/example/repo/check-runs"]);
  expect((await runCheckReporter(config, run(f.ssh()))).reported).toEqual([]);
 } finally { f.close(); }
});

test("a GitHub or token failure after a successful retrieval writes no acknowledgement and replays over SSH", async () => {
 const f = await operatorFixture();
 try {
  const j = job(); await f.enqueue(j);
  const config = await f.load(), writes: string[] = [];
  let tokenOk = false;
  const run = { ssh: { runner: f.ssh() }, api: apiFor(writes, () => tokenOk), pullHeads: noHeads };
  expect((await runCheckReporter(config, run)).failed).toHaveLength(1);
  tokenOk = true;
  expect((await runCheckReporter(config, run)).reported.map(r => r.jobId)).toEqual([j.jobId]);
  expect(writes).toEqual(["repos/example/repo/check-runs"]);
 } finally { f.close(); }
});

test("the receipt listing is read in pages until the receiver reports no more", async () => {
 const f = await operatorFixture();
 try {
  const ids: string[] = [randomUUID(), randomUUID(), randomUUID()], seen: unknown[] = [];
  const runner: SshRunner = async ({ input }) => {
   let text = ""; for await (const chunk of input) text += Buffer.from(chunk).toString("utf8");
   const request = JSON.parse(text) as { after?: string }; seen.push(request.after);
   const index = request.after === undefined ? 0 : ids.indexOf(request.after) + 1;
   return { code: 0, stdout: JSON.stringify({ version: 4, executorId: "fixture", jobIds: ids.slice(index, index + 2), more: index + 2 < ids.length }) + "\n" };
  };
  expect(await sshReceiptReader(f.sshConfig, { runner }).jobIds()).toEqual(ids);
  expect(seen).toEqual([undefined, ids[1]]);
 } finally { f.close(); }
});

test("a receipt reply from another executor, for another job, malformed or oversized is refused by the client", async () => {
 const f = await operatorFixture();
 try {
  const j = job(), id = j.jobId, good = { jobId: id, job: j, evidence: digest("1"), state: "pending" as const, receiptBytes: "{}", authorized: true };
  const reply = (body: unknown): SshRunner => async () => ({ code: 0, stdout: typeof body === "string" ? body : JSON.stringify(body) + "\n" });
  const get = (runner: SshRunner) => getSshReceipt({ config: f.sshConfig, jobId: id }, { runner });
  expect(await get(reply({ version: 4, executorId: "fixture", receipt: good }))).toEqual(good);
  expect(await get(reply({ version: 4, executorId: "fixture", receipt: null }))).toBeNull();
  await expect(get(reply({ version: 4, executorId: "someone-else", receipt: good }))).rejects.toThrow(/another executor/);
  await expect(get(reply({ version: 4, executorId: "fixture", receipt: { ...good, jobId: randomUUID() } }))).rejects.toThrow(/another job/);
  await expect(get(reply({ version: 4, executorId: "fixture", receipt: { ...good, extra: 1 } }))).rejects.toThrow(/invalid/);
  await expect(get(reply({ version: 4, executorId: "fixture", receipt: { ...good, receiptBytes: "x".repeat(SSH_LIMITS.receiptBytes + 1) } }))).rejects.toThrow(/invalid/);
  await expect(get(reply({ version: 4, executorId: "fixture", jobIds: [], more: false }))).rejects.toThrow(/invalid/);
  await expect(get(reply({ version: 4, error: "receiver_failed" }))).rejects.toThrow(/refused/);
  await expect(get(reply("{"))).rejects.toThrow(/invalid/);
  await expect(get(async () => ({ code: 1, stdout: JSON.stringify({ version: 4, executorId: "fixture", receipt: good }) }))).rejects.toThrow(/failed/);
  await expect(listSshReceipts({ config: f.sshConfig }, { runner: reply({ version: 4, executorId: "fixture", receipt: null }) })).rejects.toThrow(/invalid/);
  await expect(listSshReceipts({ config: f.sshConfig }, { runner: reply({ version: 4, executorId: "fixture", jobIds: new Array(SSH_LIMITS.receiptPage + 1).fill("a"), more: false }) })).rejects.toThrow(/invalid/);
 } finally { f.close(); }
});

test("the receiver refuses receipt operations it was not configured for, with a payload, or for another executor", async () => {
 const f = await operatorFixture();
 try {
  const frame = (body: string, request: object = { version: 4, operation: "receipt-list" }) => (async function* () { yield Buffer.from(JSON.stringify(request) + "\n" + body); })();
  const j = job(); await f.enqueue(j);
  const { outboxRoot: _unset, ...unconfigured } = f.executorConfig;
  expect(await serveSshResponse(frame(""), unconfigured)).toEqual({ version: 4, error: "receiver_failed" });
  expect(await serveSshResponse(frame("payload"), f.executorConfig)).toEqual({ version: 4, error: "receiver_failed" });
  expect(await serveSshResponse(frame("", { version: 4, operation: "receipt-list", after: randomUUID() }), f.executorConfig)).toEqual({ version: 4, error: "receiver_failed" });
  expect(await serveSshResponse(frame("", { version: 4, operation: "receipt-list" }), f.executorConfig)).toEqual({ version: 4, executorId: "fixture", jobIds: [j.jobId], more: false });
  expect(await serveSshResponse(frame("", { version: 4, operation: "receipt-get", jobId: randomUUID() }), f.executorConfig)).toEqual({ version: 4, executorId: "fixture", receipt: null });
  expect(await serveSshResponse(frame("", { version: 4, operation: "receipt-get", job: {} }), f.executorConfig)).toEqual({ version: 1, error: "receiver_failed" });
  expect(await serveSshResponse(frame("", { version: 3, operation: "receipt-list" }), f.executorConfig)).toMatchObject({ error: "receiver_failed" });
 } finally { f.close(); }
});

test("the outbox reader pages receipt IDs in queue order and a full page reports more", async () => {
 const f = await operatorFixture();
 try {
  const a = job(), b = job({ commitDigest: "e".repeat(40) }), c = job({ commitDigest: "d".repeat(40) });
  await f.enqueue(a); await f.enqueue(b); await f.enqueue(c);
  const reader = await openBusOutboxReader({ root: f.outboxRoot, jobsRoot: f.jobsRoot, executorId: "fixture" });
  try {
   expect(reader.receiptJobIdPage(undefined, 2)).toEqual({ jobIds: [a.jobId, b.jobId], more: true });
   expect(reader.receiptJobIdPage(b.jobId, 2)).toEqual({ jobIds: [c.jobId], more: false });
   expect(reader.receiptJobIdPage(c.jobId, 2)).toEqual({ jobIds: [], more: false });
   expect(() => reader.receiptJobIdPage(randomUUID(), 2)).toThrow(/cursor/);
  } finally { reader.close(); }
 } finally { f.close(); }
});

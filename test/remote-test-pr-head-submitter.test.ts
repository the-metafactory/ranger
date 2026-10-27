import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { runCmd } from "../src/exec.ts";
import { listPullRequestHeads, type PullRequestHead } from "../src/github.ts";
import { type BusRunOutcome, type BusRequestRecord } from "../src/remote-test/bus-producer.ts";
import { type ProfileManifest, type RemoteTestJob } from "../src/remote-test/contract.ts";
import { stageSource } from "../src/remote-test/source.ts";
import { JobLedger } from "../src/remote-test/job-ledger.ts";
import { createReviewedProfile, MYELIN_REPOSITORY } from "../src/remote-test/profiles.ts";
import { fetchPrHead, openPrSubmissionLedger, PR_LEDGER_VERSION, PrSubmissionLedger, runPrHeadSubmitter, scanAndSubmitPrHeads,
 type PrHeadScanDeps } from "../src/remote-test/pr-head-submitter.ts";

const repo = "the-metafactory/myelin", sha = "a".repeat(40), nextSha = "b".repeat(40), now = 1_800_000_000_000;
const digest = `sha256:${"a".repeat(64)}`;
const profile = createReviewedProfile({ profileId: "myelin-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"],
  sidecars: [{ kind: "nats", imageReference: `nats@${digest}` }] } });
const otherProfile = createReviewedProfile({ ...profile, profileId: "other-v1", reviewed: profile.reviewed });
const bindings = [{ repo, profile }];
const pr = (extra: Partial<PullRequestHead> = {}): PullRequestHead => ({ number: 1, state: "open", headRepository: repo, baseRepository: repo, headSha: sha, ...extra });
const apiRow = (extra = {}) => ({ number: 1, state: "open", head: { sha, repo: { full_name: repo } }, base: { repo: { full_name: repo } }, ...extra });
const submitted: BusRunOutcome = { status: "submitted", eventId: "event", stream: "REQUESTS", seq: 1, duplicate: false };

describe("PR head scan and durable tuple ledger", () => {
 let root: string, ledger: PrSubmissionLedger, deps: PrHeadScanDeps;
 let prs: PullRequestHead[], calls: Parameters<PrHeadScanDeps["submit"]>[0][], fetched: string[], released: number;
 beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ranger-pr-heads-")));
  ledger = await openPrSubmissionLedger(root, () => now);
  prs = [pr()]; calls = []; fetched = []; released = 0;
  deps = { ledger, now: () => now, list: async () => prs,
   fetch: async (_repo, head) => { fetched.push(head); return { worktree: "/fixture/clean", release: async () => { released++; } }; },
   submit: async input => { calls.push(input); return submitted; },
  };
 });
 afterEach(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });
 const scan = (selected = bindings, repos = [repo]) => scanAndSubmitPrHeads(repos, selected, 660, deps);

 test("submits the full exact head once, including duplicate PR and map entries, across ledger reopen", async () => {
  prs = [pr(), pr({ number: 2 })];
  expect((await scan(bindings, [repo, repo])).map(e => e.code)).toEqual(["submitted", "duplicate"]);
  expect(calls).toHaveLength(1); expect(calls[0].expectedCommit).toBe(sha);
  expect(calls[0].request).toMatchObject({ repositoryId: MYELIN_REPOSITORY, profileId: profile.profileId, profileDigest: profile.profileDigest, generation: 1 });
  expect(calls[0].request).not.toHaveProperty("commitDigest");
  ledger.close(); ledger = await openPrSubmissionLedger(root, () => now); deps.ledger = ledger;
  expect((await scan()).map(e => e.code)).toEqual(["duplicate", "duplicate"]);
  expect(calls).toHaveLength(1); expect(fetched).toEqual([sha]); expect(released).toBe(1);
  expect((await stat(join(root, "pr-submissions.sqlite"))).mode & 0o077).toBe(0);
  expect(ledger.events().map(e => e.code)).toEqual(["submitted"]);
 });

 test("head movement preserves correlation, advances generation and supersedes through the existing execution ledger", async () => {
  await scan(); prs = [pr({ headSha: nextSha })]; await scan();
  expect(calls).toHaveLength(2);
  expect(calls[1].request.correlationId).toBe(calls[0].request.correlationId);
  expect(calls[1].request.generation).toBe(2); expect(calls[1].expectedCommit).toBe(nextSha);
  const execution = new JobLedger(new Database(":memory:"), root, "fixture", () => now);
  try {
   const jobs = calls.map(call => ({ ...call.request, commitDigest: call.expectedCommit, treeDigest: "c".repeat(40), bundleDigest: digest }));
   expect(execution.admit(jobs[0]).kind).toBe("admitted");
   expect(execution.admit(jobs[1]).kind).toBe("busy");
   expect(execution.status(jobs[0])).toMatchObject({ kind: "terminal", receipt: { status: "cancelled" } });
  } finally { execution.close(); }
  expect((await scan())[0].code).toBe("duplicate");
 });

 test("fork, missing repository, closed and merged PRs never fetch or submit, regardless of draft status", async () => {
  prs = [pr({ headRepository: "someone/myelin" }), pr({ headRepository: null }), pr({ baseRepository: "someone/myelin" }), pr({ state: "closed" }), pr({ state: "merged" })];
  expect((await scan()).map(e => e.code)).toEqual(["fork", "fork", "fork", "closed", "closed"]);
  expect(calls).toHaveLength(0); expect(fetched).toHaveLength(0); expect(ledger.events()).toHaveLength(5);
 });

 test("skip reasons retain only the latest 1000 records across scans", async () => {
  prs = Array.from({ length: 1100 }, (_, i) => pr({ number: i + 1, state: "closed" }));
  expect(await scan()).toHaveLength(1100);
  expect(ledger.events()).toHaveLength(1000);
  expect(ledger.events()[0]).toMatchObject({ pr: 101, code: "closed" });
  prs = [pr({ number: 1101, headRepository: "someone/myelin" })];
  await scan();
  expect(ledger.events()).toHaveLength(1000);
  expect(ledger.events()[0].pr).toBe(102);
  expect(ledger.events().at(-1)).toMatchObject({ pr: 1101, code: "fork" });
 });

 test("a duplicate-only rescan makes no durable database writes", async () => {
  await scan();
  const observer = new Database(join(root, "pr-submissions.sqlite"), { readonly: true });
  try {
   const before = observer.query("PRAGMA data_version").get();
   expect((await scan())[0].code).toBe("duplicate");
   expect(observer.query("PRAGMA data_version").get()).toEqual(before);
  } finally { observer.close(); }
 });

 test("no binding, malformed SHA, list failure and unsupported forge are journaled without submission", async () => {
  expect((await scan([]))[0].code).toBe("no_reviewed_binding");
  prs = [pr({ headSha: "main" })]; expect((await scan())[0].code).toBe("invalid_head");
  deps.list = async () => { throw Error("private details"); };
  expect((await scan())[0].code).toBe("list_failed");
  expect((await scan(bindings, ["gitlab:example.invalid/group/repo"]))[0].code).toBe("unsupported_repository");
  expect(calls).toHaveLength(0); expect(JSON.stringify(ledger.events())).not.toContain("private details");
 });

 test("fetch failure never claims the tuple or falls back to a branch", async () => {
  deps.fetch = async (_repo, head) => { expect(head).toBe(sha); throw Error("missing object"); };
  expect((await scan())[0].code).toBe("fetch_failed");
  expect(calls).toHaveLength(0); expect(ledger.has(repo, sha, profile.profileId)).toBe(false);
 });

 test.each(["uncertain", "refused", "not_staged", "submission_failed"] as const)("%s publication retains the durable claim without automatic replacement", async status => {
  deps.submit = async input => {
   calls.push(input);
   if (status === "submission_failed") throw Error("private failure");
   if (status === "not_staged") return { status, reason: "invalid_response" };
   if (status === "refused") return { status, eventId: "stable", reason: "publisher_unavailable" };
   return { status, eventId: "stable", reason: "timeout" };
  };
  expect((await scan())[0].code).toBe(status); expect((await scan())[0].code).toBe("duplicate");
  expect(calls).toHaveLength(1); expect(released).toBe(1);
 });

 test("concurrent scans claim only one request", async () => {
  const results = await Promise.all([scan(), scan()]);
  expect(results.flat().map(e => e.code).sort()).toEqual(["duplicate", "submitted"]); expect(calls).toHaveLength(1);
 });

 test("separate profiles and repositories have separate tuple identities", async () => {
  await scan([{ repo, profile }, { repo, profile: otherProfile }]);
  expect(calls).toHaveLength(2);
  expect(calls.map(c => c.request.profileId)).toEqual(["myelin-v1", "other-v1"]);
  expect(fetched).toEqual([sha]); expect(released).toBe(1);
  const otherRepo = "example/another";
  deps.list = async () => [pr({ headRepository: otherRepo, baseRepository: otherRepo })];
  await scan([{ repo: otherRepo, profile }], [otherRepo]);
  expect(calls).toHaveLength(3); expect(calls[2].request.repositoryId).toBe(`github:github.com/${otherRepo}`);
 });

 test("a failed profile submission preserves the shared source until other profiles finish", async () => {
  deps.submit = async input => {
   expect(released).toBe(0); calls.push(input);
   if (input.request.profileId === profile.profileId) throw Error("private failure");
   return submitted;
  };
  expect((await scan([{ repo, profile }, { repo, profile: otherProfile }])).map(e => e.code)).toEqual(["submission_failed", "submitted"]);
  expect(calls.map(call => call.worktree)).toEqual(["/fixture/clean", "/fixture/clean"]);
  expect(fetched).toEqual([sha]); expect(released).toBe(1);
 });

 test("an unavailable head is fetched once and abandons every profile claim for a later retry", async () => {
  const selected = [{ repo, profile }, { repo, profile: otherProfile }];
  deps.fetch = async (_repo, head) => { fetched.push(head); throw Error("unavailable"); };
  expect((await scan(selected)).map(e => e.code)).toEqual(["fetch_failed", "fetch_failed"]);
  expect(fetched).toEqual([sha]); expect(calls).toHaveLength(0);
  expect(ledger.has(repo, sha, profile.profileId)).toBe(false);
  expect(ledger.has(repo, sha, otherProfile.profileId)).toBe(false);
  expect((await scan(selected)).map(e => e.code)).toEqual(["fetch_failed", "fetch_failed"]);
  expect(fetched).toEqual([sha, sha]);
 });

 test("slow older-head fetch cannot supersede a newer generation published first", async () => {
  let releaseFetch: () => void = () => undefined;
  let enteredFetch: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { enteredFetch = resolve; });
  const waiting = new Promise<void>(resolve => { releaseFetch = resolve; });
  deps.fetch = async (_repo, head) => {
   if (head === sha) { enteredFetch(); await waiting; }
   return { worktree: "/fixture/clean", release: async () => undefined };
  };
  const older = scan(); await entered;
  prs = [pr({ headSha: nextSha })]; await scan(); releaseFetch(); await older;
  expect(calls.map(call => [call.expectedCommit, call.request.generation])).toEqual([[nextSha, 2], [sha, 1]]);
  const db = new Database(join(root, "pr-submissions.sqlite"), { readonly: true });
  try { expect(db.query("SELECT sha,superseded FROM requests ORDER BY sha").all()).toEqual([{ sha, superseded: 1 }, { sha: nextSha, superseded: 0 }]); }
  finally { db.close(); }
  const execution = new JobLedger(new Database(":memory:"), root, "fixture", () => now);
  try {
   const [newer, stale] = calls.map(call => ({ ...call.request, commitDigest: call.expectedCommit, treeDigest: "c".repeat(40), bundleDigest: digest }));
   const admitted = execution.admit(newer);
   expect(admitted.kind).toBe("admitted");
   expect(execution.admit(stale)).toMatchObject({ kind: "terminal", receipt: { status: "cancelled", identity: stale } });
   expect(execution.status(stale)).toMatchObject({ kind: "terminal", receipt: { status: "cancelled" } });
   expect(execution.status(newer)).toMatchObject({ kind: "active" });
   if (admitted.kind !== "admitted") throw Error("newer head must be admitted");
   expect(execution.allowed(newer, admitted.token)).toBe(true);
   expect(() => execution.launch(stale, admitted.token)).toThrow("launch fence");
  } finally { execution.close(); }
 });

 const ledgerVersion = (version?: number) => {
  const db = new Database(join(root, "pr-submissions.sqlite"));
  try {
   if (version !== undefined) db.run(`PRAGMA user_version=${version}`);
   return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally { db.close(); }
 };

 test("a fresh ledger records the current schema version", () => {
  expect(PR_LEDGER_VERSION).toBe(1); expect(ledgerVersion()).toBe(PR_LEDGER_VERSION);
 });

 test("an unversioned ledger from the current schema is adopted with its claims", async () => {
  ledger.claim(repo, 1, sha, profile, now + 660_000);
  ledger.close(); expect(ledgerVersion(0)).toBe(0);
  ledger = await openPrSubmissionLedger(root, () => now); deps.ledger = ledger;
  expect(ledgerVersion()).toBe(PR_LEDGER_VERSION); expect(ledger.has(repo, sha, profile.profileId)).toBe(true);
  expect((await scan())[0].code).toBe("duplicate"); expect(calls).toHaveLength(0);
 });

 test("an unknown ledger version is refused and left untouched", async () => {
  ledger.close(); ledgerVersion(PR_LEDGER_VERSION + 1);
  await expect(openPrSubmissionLedger(root, () => now)).rejects.toThrow(`Unsupported PR submission ledger version ${PR_LEDGER_VERSION + 1}`);
  expect(ledgerVersion()).toBe(PR_LEDGER_VERSION + 1);
 });

 test("durable claim left by an interrupted scan is never silently resubmitted", async () => {
  ledger.claim(repo, 1, sha, profile, now + 660_000);
  ledger.close(); ledger = await openPrSubmissionLedger(root); deps.ledger = ledger;
  expect((await scan())[0].code).toBe("duplicate"); expect(calls).toHaveLength(0);
 });
});

describe("PR listing, opt-in config and production producer integration", () => {
 let root: string;
 beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "ranger-pr-producer-"))); });
 afterEach(async () => { await rm(root, { recursive: true, force: true }); });
 const writeJson = (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value), { mode: 0o600 });
 const config = async (settings?: unknown) => {
  await writeJson("ranger.json", { maps: [{ repo, root: 1 }], auth: { defaultTokenEnv: "RANGER_READ_TOKEN" }, ...(settings === undefined ? {} : { prHeadSubmitter: settings }) });
  return loadConfig(join(root, "ranger.json"), {}).config;
 };
 const settings = () => ({ busConfigFile: join(root, "bus.json"), signerFile: join(root, "signer.json"), stateRoot: join(root, "state"), deadlineSeconds: 660 });
 async function privateConfig(profiles: ProfileManifest[] = [profile], profileDigest = profile.profileDigest, authorized = true, repositoryId = MYELIN_REPOSITORY) {
  const issuer = "did:mf:ranger", account = `A${"C".repeat(55)}`;
  await writeJson("bus.json", { version: 1, target: { domain: "fixture", account },
   routing: { classification: "local", principal: "fixture", stack: "private" },
   streams: { request: { stream: "REQUESTS", durable: "EXECUTOR" }, result: { stream: "RESULTS" } },
   transport: { servers: ["tls://bus.example.invalid:4222"], credentialsFile: join(root, "bus.creds") },
   ssh: { configFile: join(root, "ssh.json") }, registry: { file: join(root, "registry.json") },
   execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 60, maxDeliver: 3 },
   issuers: [{ issuer: authorized ? issuer : "did:mf:other", bindings: [{ repositoryId, profileId: profile.profileId, profileDigest }] }] });
  await writeJson("ssh.json", { target: "fixture", remoteCli: "/reviewed/ranger", remoteConfig: "/private/executor.json", executorId: "fixture", profiles });
  await writeJson("signer.json", { version: 1, issuer, seed: Buffer.alloc(32, 1).toString("base64") });
  const jwt = ["e30", Buffer.from(JSON.stringify({ iss: account, sub: `U${"A".repeat(55)}`, nats: { type: "user" } })).toString("base64url"), "sig"].join(".");
  await writeFile(join(root, "bus.creds"), `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nSU${"A".repeat(56)}\n------END USER NKEY SEED------\n`, { mode: 0o600 });
 }

 test("REST listing paginates all open PRs and preserves repository identity and terminal states; drafts are eligible", async () => {
  let args: string[] = [];
  const row = (draft: boolean, extra = {}) => apiRow({ draft, ...extra });
  const prs = await listPullRequestHeads(repo, "fixture", async (_token, argv) => { args = argv; return [[row(true)], [row(false), row(true, { state: "closed" }), row(false, { merged_at: "2026-01-01" }), row(false, { head: { sha, repo: null } })]]; });
  expect(args).toEqual([`repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--slurp"]);
  expect(prs).toEqual([pr(), pr(), pr({ state: "closed" }), pr({ state: "merged" }), pr({ headRepository: null })]);
 });

 test("missing producer configuration is a no-op on the actual CLI without credentials or private state", async () => {
  const loaded = await config(); expect(await runPrHeadSubmitter(loaded)).toEqual([]);
  const result = await runCmd("bun", ["src/cli.ts", "remote-test", "submit-pr-heads", "-c", join(root, "ranger.json")], { timeoutMs: 60_000 });
  expect(result.code).toBe(0); expect(result.stdout).toContain("0 submitted, 0 outcomes");
  expect(await readdir(root)).toEqual(["ranger.json"]);
 });

 test("opt-in paths must be absolute and unknown settings are refused", async () => {
  for (const field of ["busConfigFile", "signerFile", "stateRoot"]) await expect(config({ ...settings(), [field]: "relative" })).rejects.toThrow();
  await expect(config({ ...settings(), unexpected: true })).rejects.toThrow();
  expect((await config(settings())).prHeadSubmitter?.deadlineSeconds).toBe(660);
 });

 test("reviewed binding selects exact producer profile and persists the bus request before publication", async () => {
  await privateConfig(); const loaded = await config(settings()); let published = 0;
  const run = { env: { RANGER_READ_TOKEN: "read-fixture" }, now: () => now,
   api: async () => [[apiRow({ draft: true })]],
   fetch: async () => ({ worktree: "/fixture/clean", release: async () => undefined }),
   producer: {
    stage: async (input: { request: Record<string, unknown>; expectedCommit?: string }) => {
     expect(input.expectedCommit).toBe(sha);
     return { status: "staged" as const, executorId: "fixture", job: { ...input.request, commitDigest: sha, treeDigest: nextSha, bundleDigest: digest } as RemoteTestJob, source: { bundleDigest: digest, bundleBytes: 1 } };
    },
    publisher: async () => ({ publishDurable: async (envelope: any) => {
     published++;
     const job = envelope.payload.job as RemoteTestJob;
     const saved = JSON.parse(await readFile(join(root, "state", `${job.jobId}.bus.json`), "utf8")) as BusRequestRecord;
     expect(saved.job).toEqual(job); expect(job.commitDigest).toBe(sha); expect(job.profileDigest).toBe(profile.profileDigest);
     return { stream: "REQUESTS", seq: 1, domain: "fixture", duplicate: false };
    } }),
   },
  };
  expect((await runPrHeadSubmitter(loaded, run))[0].code).toBe("submitted");
  expect((await runPrHeadSubmitter(loaded, run))[0].code).toBe("duplicate"); expect(published).toBe(1);
 });

 test("missing issuer approval or mismatched profile bindings skip without fetching or publishing", async () => {
  for (const [authorized, selectedDigest] of [[false, profile.profileDigest], [true, `sha256:${"b".repeat(64)}`]] as const) {
   await privateConfig([profile], selectedDigest, authorized);
   const result = await runPrHeadSubmitter(await config(settings()), { env: { RANGER_READ_TOKEN: "fixture" },
    api: async () => [[apiRow()]],
    fetch: async () => { throw Error("must not fetch"); },
   });
   expect(result[0].code).toBe("no_reviewed_binding");
  }
 });

 test.each(["gitlab:example.invalid/group/repo", "github:enterprise.invalid/group/repo"])("unsupported binding %s is skipped without fetching or publishing", async repositoryId => {
  await privateConfig([profile], profile.profileDigest, true, repositoryId);
  const result = await runPrHeadSubmitter(await config(settings()), { env: { RANGER_READ_TOKEN: "fixture" },
   api: async () => [[apiRow()]],
   fetch: async () => { throw Error("must not fetch"); },
  });
  expect(result.map(event => event.code)).toEqual(["no_reviewed_binding"]);
 });

 test("an explicitly approved legacy V1 manifest does not require recipe metadata", async () => {
  const { reviewed: _reviewed, ...legacy } = profile;
  await privateConfig([legacy]); let fetched = false;
  const events = await runPrHeadSubmitter(await config(settings()), { env: { RANGER_READ_TOKEN: "fixture" }, now: () => now,
   api: async () => [[apiRow()]],
   fetch: async () => { fetched = true; throw Error("stop before transport"); },
  });
  expect(fetched).toBe(true); expect(events[0].code).toBe("fetch_failed");
 });

 test("immutable fetch uses only the full SHA, isolates credentials, and rejects mismatch without fallback", async () => {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const fetch = () => fetchPrHead({ repo, sha, root, token: "private-token" }, async (_command, args, options) => {
   calls.push({ args, env: options?.env });
   return { code: 0, stdout: args.includes("rev-parse") ? nextSha : "", stderr: "" };
  });
  await expect(fetch()).rejects.toThrow("mismatch");
  const transfer = calls.find(c => c.args.includes("fetch"))!;
  expect(transfer.args.slice(-2)).toEqual([`https://github.com/${repo}.git`, sha]);
  expect(transfer.env?.GIT_CONFIG_VALUE_0).toContain("AUTHORIZATION: basic");
  expect(calls.filter(c => !c.args.includes("fetch")).every(c => c.env?.GIT_CONFIG_VALUE_0 === undefined)).toBe(true);
  expect(await readdir(root)).toEqual([]);
  await expect(fetchPrHead({ repo, sha: "main", root, token: "fixture" })).rejects.toThrow();
 });

 test("real fetched detached source stages as an immutable bundle for its exact commit", async () => {
  const original = join(root, "original");
  const git = async (args: string[], cwd = root) => {
   const result = await runCmd("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, timeoutMs: 60_000 });
   expect(result.code).toBe(0); return result.stdout.trim();
  };
  await git(["init", "--template=", original]);
  await writeFile(join(original, "fixture.txt"), "exact source\n");
  await git(["add", "fixture.txt"], original); await git(["commit", "-m", "fixture"], original);
  await writeFile(join(original, "fixture.txt"), "new exact source\n");
  await git(["commit", "-am", "second fixture"], original);
  const commit = await git(["rev-parse", "HEAD"], original);
  const source = await fetchPrHead({ repo, sha: commit, root, token: "fixture" }, async (command, args, options) => {
   const local = args.map(arg => arg === `https://github.com/${repo}.git` ? original : arg);
   return await runCmd(command, local, options);
  });
  try {
   const staged = await stageSource({ worktree: source.worktree, stagingRoot: root, jobId: "6c7e8091-1234-4234-8234-123456789abc", commitDigest: commit });
   expect(staged.manifest.commitDigest).toBe(commit);
   expect(staged.manifest.treeDigest).toBe(await git(["rev-parse", "HEAD^{tree}"], original));
   expect((await stat(staged.bundlePath)).size).toBeGreaterThan(0);
  } finally { await source.release(); }
 });

 test.each(["staging_refused", "wrong_commit"] as const)("%s from the real producer never publishes and journals the failure", async failure => {
  await privateConfig(); let publishes = 0;
  const result = await runPrHeadSubmitter(await config(settings()), {
   env: { RANGER_READ_TOKEN: "fixture" }, now: () => now,
   api: async () => [[apiRow()]],
   fetch: async () => ({ worktree: "/fixture/clean", release: async () => undefined }),
   producer: {
    stage: async ({ request }) => failure === "staging_refused" ? { status: "refused", reason: "receiver_failed" } : {
     status: "staged", executorId: "fixture", job: { ...request, commitDigest: nextSha, treeDigest: nextSha, bundleDigest: digest } as RemoteTestJob,
     source: { bundleDigest: digest, bundleBytes: 1 },
    },
    publisher: async () => { publishes++; throw Error("must not publish"); },
   },
  });
  expect(result[0].code).toBe(failure === "staging_refused" ? "not_staged" : "submission_failed"); expect(publishes).toBe(0);
  const ledger = await openPrSubmissionLedger(join(root, "state"));
  try { expect(ledger.events()).toEqual(result); } finally { ledger.close(); }
 });
});

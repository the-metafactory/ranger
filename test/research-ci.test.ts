import { expect, test } from "bun:test";
import type { CheckRun, CommitStatus, WorkflowRun, PullRequest } from "../src/github.ts";
import { FencedError } from "../src/journal.ts";
import { researchCi, type ResearchGitHubPort } from "../src/research-ci.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const PR: PullRequest = {
 number: 31, state: "open", merged: false, draft: true, title: "research",
 headRef: "research/survey", headSha: SHA, baseRef: "main", mergeable: null,
 mergeableState: "draft", mergeCommitSha: null, mergedBy: null,
 url: "https://github.com/acme/widgets/pull/31", author: "ivy-bot",
};
const GREEN: CheckRun = { id: 901, name: "test", status: "completed", conclusion: "success" };

const WORKFLOW: WorkflowRun = { ...GREEN, id: 501, workflowId: 10, event: "pull_request", attempt: 1 };

const seq = <T>(xs: T[]) => { let i = 0; return () => xs[Math.min(i++, xs.length - 1)]!; };

function setup(opts: { runs?: CheckRun[][]; workflows?: WorkflowRun[][]; statuses?: CommitStatus[][]; prs?: PullRequest[]; existing?: boolean; timeoutMs?: number; settleMs?: number } = {}) {
 let creates = 0;
 const nextPr = seq(opts.prs ?? [PR]);
 const nextRuns = seq(opts.runs ?? [[GREEN]]);
 const nextWorkflows = seq(opts.workflows ?? [[WORKFLOW]]);
 const nextStatuses = seq(opts.statuses ?? [[]]);
 let now = 0;
 const sleeps: number[] = [];
 const queried: string[] = [];
 const fences: string[] = [];
 const recorded: number[] = [];
 const github: ResearchGitHubPort = {
  findPrByHead: async () => opts.existing ? PR : null,
  createDraftPr: async (_repo, body, token) => {
   expect(token).toBe("machine");
   expect(body).toMatchObject({ head: PR.headRef, base: PR.baseRef });
   expect(body.title).toBe("Research findings for node #25");
   creates++;
   return PR;
  },
  getPr: async () => nextPr(),
  checkRunsFor: async (_repo, sha) => {
   queried.push(sha);
   return nextRuns();
  },
  workflowRunsFor: async () => nextWorkflows(),
  commitStatusesFor: async () => nextStatuses(),
 };
 const input: Parameters<typeof researchCi>[0] = {
  repo: "acme/widgets", branch: PR.headRef, base: "main", sha: SHA, nodeId: "25",
  token: "machine", pr: opts.existing ? PR : null, github, pollMs: 10,
  settleMs: opts.settleMs ?? 0,
  clock: { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } },
  timeoutMs: opts.timeoutMs ?? 100,
  fence: (action) => { fences.push(action); }, recordPr: (pr) => { recorded.push(pr.number); },
 };
 return { input, queried, fences, recorded, sleeps, creates: () => creates, elapsed: () => now };
}

test("completed checks wait for queued workflows even before their jobs register", async () => {
 const s = setup({ workflows: [[{ ...WORKFLOW, status: "queued", conclusion: null }], [WORKFLOW]] });
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.queried).toHaveLength(2);
});

test("a failed workflow blocks an otherwise green check", async () => {
 const s = setup({ workflows: [[{ ...WORKFLOW, conclusion: "failure" }]] });
 await expect(researchCi(s.input)).rejects.toThrow("research CI failed");
});

test("pending external commit status delays evidence", async () => {
 const status = { id: 601, context: "external-ci", state: "pending" };
 const s = setup({ statuses: [[status], [{ ...status, state: "success" }]] });
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.queried).toHaveLength(2);
});

for (const state of ["failure", "error", "unknown"]) {
 test(`external commit status ${state} blocks green checks`, async () => {
  const s = setup({ statuses: [[{ id: 601, context: "external-ci", state }]] });
  await expect(researchCi(s.input)).rejects.toThrow("external-ci=");
 });
}

test("a late registered failed job prevents evidence during settling", async () => {
 const s = setup({ settleMs: 30, runs: [[GREEN], [GREEN], [GREEN, { ...GREEN, id: 902, conclusion: "failure" }]] });
 await expect(researchCi(s.input)).rejects.toThrow("research CI failed");
 expect(s.queried).toHaveLength(3);
});

test("a new completed workflow resets the settling window", async () => {
 const extra = { ...WORKFLOW, id: 502, workflowId: 11 };
 const s = setup({ settleMs: 30, workflows: [[WORKFLOW], [WORKFLOW, extra]] });
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.elapsed()).toBe(40);
});

test("a late pending status resets settling until it succeeds", async () => {
 const status = { id: 601, context: "external-ci", state: "pending" };
 const s = setup({ settleMs: 30, timeoutMs: 200, statuses: [[], [status], [{ ...status, state: "success" }]] });
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.elapsed()).toBe(50);
});

test("long-running CI backs off but confirms green after only the settling window", async () => {
 const queued = { ...WORKFLOW, status: "queued", conclusion: null };
 const s = setup({ workflows: [[queued], [queued], [queued], [queued], [queued], [WORKFLOW]],
  settleMs: 30_000, timeoutMs: 300_000 });
 s.input.pollMs = 10_000;
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.sleeps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 10_000, 10_000, 10_000]);
 expect(s.elapsed()).toBe(220_000);
});

test("reports check and external status failures together", async () => {
 const s = setup({ runs: [[{ ...GREEN, conclusion: "failure" }]],
  statuses: [[{ id: 601, context: "external-ci", state: "error" }]] });
 await expect(researchCi(s.input)).rejects.toThrow("test=failure, external-ci=error");
});

test("production settling duration is 30 seconds at the reset poll interval", async () => {
 const s = setup({ timeoutMs: 60_000 });
 delete s.input.settleMs;
 delete s.input.pollMs;
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.elapsed()).toBe(30_000);
 expect(s.queried).toHaveLength(4);
});

test("settling cannot outlive the CI deadline", async () => {
 const s = setup({ settleMs: 30, timeoutMs: 20 });
 await expect(researchCi(s.input)).rejects.toThrow("wait expired");
});

test("opens a draft, waits through empty and running checks, then returns a head-bound citation", async () => {
 const s = setup({ runs: [[], [{ ...GREEN, status: "in_progress", conclusion: null }], [GREEN]] });
 expect(await researchCi(s.input)).toMatchObject({ ci: `901@${SHA}`, pr: PR });
 expect(s.creates()).toBe(1);
 expect(s.recorded).toEqual([31]);
 expect(s.queried).toEqual([SHA, SHA, SHA]);
 expect(s.fences).toContain("open research PR");
 expect(s.fences).toContain("confirm research head");
});

test("reuses the recorded draft without creating another PR", async () => {
 const s = setup({ existing: true });
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.creates()).toBe(0);
});

for (const runs of [[], [{ ...GREEN, status: "queued", conclusion: null }], [GREEN, { ...GREEN, id: 902, status: "in_progress", conclusion: null }]]) {
 test(`pending CI cannot return evidence: ${JSON.stringify(runs)}`, async () => {
  const s = setup({ runs: [runs], timeoutMs: 0 });
  await expect(researchCi(s.input)).rejects.toThrow("wait expired");
 });
}

for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null]) {
 test(`failed CI cannot return evidence: ${conclusion}`, async () => {
  const s = setup({ runs: [[GREEN, { ...GREEN, id: 902, conclusion }]] });
  await expect(researchCi(s.input)).rejects.toThrow("research CI failed");
 });
}

for (const runs of [[{ ...GREEN, conclusion: "neutral" }], [{ ...GREEN, conclusion: "skipped" }], [{ ...GREEN, id: 0 }]]) {
 test(`no citable success: ${JSON.stringify(runs)}`, async () => {
  const s = setup({ runs: [runs] });
  await expect(researchCi(s.input)).rejects.toThrow("no successful check run");
 });
}

test("waits for GitHub to reflect the pushed SHA and never reads old-head CI", async () => {
 const s = setup({ prs: [{ ...PR, headSha: OTHER }, PR] });
 expect((await researchCi(s.input)).ci).toBe(`901@${SHA}`);
 expect(s.queried).toEqual([SHA]);
});

test("head mismatch times out without querying CI", async () => {
 const s = setup({ prs: [{ ...PR, headSha: OTHER }], timeoutMs: 0 });
 await expect(researchCi(s.input)).rejects.toThrow("wait expired");
 expect(s.queried).toEqual([]);
});

test("a head move during the CI read invalidates the evidence", async () => {
 const s = setup({ prs: [PR, { ...PR, headSha: OTHER }] });
 await expect(researchCi(s.input)).rejects.toThrow("refusing stale evidence");
});

for (const patch of [{ state: "closed" as const }, { merged: true }, { draft: false }, { baseRef: "other" }, { headRef: "other" }]) {
 test(`declined or changed PR parks: ${JSON.stringify(patch)}`, async () => {
  const s = setup({ prs: [{ ...PR, ...patch }] });
  await expect(researchCi(s.input)).rejects.toThrow("must remain an open draft");
  expect(s.queried).toEqual([]);
 });
}

test("a superseded generation cannot create the evidence PR", async () => {
 const s = setup();
 s.input.fence = () => { throw new FencedError("superseded"); };
 await expect(researchCi(s.input)).rejects.toThrow(FencedError);
 expect(s.creates()).toBe(0);
});

import { expect, test } from "bun:test";
import type { CheckRun, PullRequest } from "../src/github.ts";
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

function setup(opts: { runs?: CheckRun[][]; prs?: PullRequest[]; existing?: boolean; timeoutMs?: number } = {}) {
 let creates = 0;
 let reads = 0;
 let checks = 0;
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
  getPr: async () => {
   const prs = opts.prs ?? [PR];
   return prs[Math.min(reads++, prs.length - 1)]!;
  },
  checkRunsFor: async (_repo, sha) => {
   queried.push(sha);
   const runs = opts.runs ?? [[GREEN]];
   return runs[Math.min(checks++, runs.length - 1)]!;
  },
 };
 const input: Parameters<typeof researchCi>[0] = {
  repo: "acme/widgets", branch: PR.headRef, base: "main", sha: SHA, nodeId: "25",
  token: "machine", pr: opts.existing ? PR : null, github, pollMs: 0,
  timeoutMs: opts.timeoutMs ?? 100,
  fence: (action) => { fences.push(action); }, recordPr: (pr) => { recorded.push(pr.number); },
 };
 return { input, queried, fences, recorded, creates: () => creates };
}

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

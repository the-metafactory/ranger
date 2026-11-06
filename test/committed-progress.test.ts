import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { FencedError, Journal } from "../src/journal.ts";
import { runNode } from "../src/worker.ts";
import { checkpointNode, nodeCheckpoint, preserveNodeProgress, progressRemote, reconcileNodeProgress } from "../src/node-progress.ts";
import type { ImplementContext } from "../src/implement.ts";
import { implementWorker, restoreEnv, rig, type Rig } from "./implement-rig.ts";
import { eligibleCodexReading } from "./fixtures/substrate-readings.ts";

const rigs: Rig[] = [];
afterEach(() => { for (const r of rigs.splice(0)) { r.journal.close(); rmSync(r.dir, { recursive: true, force: true }); } restoreEnv(); });
async function fixture() {
 const r = await rig({ test: "test ! -f src/feature.ts" });
 rigs.push(r);
 return r;
}
async function git(cwd: string, args: string[]): Promise<string> {
 const result = await runCmd("git", args, { cwd });
 if (result.code !== 0) throw new Error(result.stderr);
 return result.stdout.trim();
}
function context(r: Rig): ImplementContext {
 const row = r.journal.getWorker("20", "acme/widgets");
 if (row?.worktree == null) throw new Error("missing worktree");
 return { ...r.ctx, canonical: r.ctx.map.canonical!, worktree: row.worktree,
  node: JSON.parse(readFileSync(join(r.dir, "data/acme__widgets-node-20.json"), "utf8")),
  rootNode: JSON.parse(readFileSync(join(r.dir, "data/acme__widgets-node-1.json"), "utf8")),
  readOnlyToken: "ghp_read", generation: row.generation, branch: "node/20-add-the-feature-module", ratify: "auto",
  workerRun: async () => ({ code: 0, stdout: "", stderr: "" }), sessionJournal: join(r.dir, "session.sqlite") };
}

test("failed supervisor tests preserve exact committed work without PR or passing evidence", async () => {
 const r = await fixture();
 expect((await runNode("20", r.ctx)).status).toBe("failed");
 const ctx = context(r);
 const checkpoint = nodeCheckpoint(ctx);
 const sha = await git(ctx.worktree, ["rev-parse", "HEAD"]);
 expect(checkpoint).toMatchObject({ repo: "acme/widgets", nodeId: "20", branch: ctx.branch, sha, preservedSha: sha, phase: "implement" });
 expect(checkpoint?.evidence).toEqual([{ sha, kind: "tests", result: "failed", detail: "supervisor local tests exited 1" }]);
 expect(await r.github.sha(ctx.branch)).toBe(sha);
 expect(r.github.prs.size).toBe(0);
 expect(r.journal.listNodeEvents("acme/widgets", "20").some(event => event.kind === "progress-preserved" && event.detail?.includes(sha))).toBe(true);
});

test("a fresh clone and journal recover the exact failed-test commit and run the outstanding gate", async () => {
 const r = await fixture();
 expect((await runNode("20", r.ctx)).status).toBe("failed");
 const original = context(r);
 const sha = await git(original.worktree, ["rev-parse", "HEAD"]);
 r.journal.close();
 renameSync(r.canonical, `${r.canonical}-unavailable`);
 const fresh = join(r.dir, "fresh-canonical");
 await git(r.dir, ["clone", r.origin, fresh]);
 const journal = new Journal(join(r.dir, "fresh.sqlite"));
 r.journal = journal;
 r.ctx.journal = journal;
 r.ctx.map.canonical = fresh;
 r.ctx.workerCommand = [implementWorker, "noop"];
 let gateRuns = 0;
 r.ctx.map.commands.test = "test -f src/feature.ts";
 r.ctx.shellRun = async (command, options) => {
  if (command === "test -f src/feature.ts") gateRuns++;
  return runCmd("/bin/sh", ["-c", command], options);
 };
 journal.upsertWorker({ nodeId: "20", repo: "acme/widgets", root: 1, status: "claimed", lane: "implement" });
 expect(journal.nodeProgress("acme/widgets", "20")).toBeNull();
 const resumed = await runNode("20", r.ctx);
 expect(resumed.status).toBe("awaiting-merge");
 expect(gateRuns).toBeGreaterThan(0);
 const recovered = context(r);
 expect(await git(recovered.worktree, ["rev-parse", "HEAD"])).toBe(sha);
 expect(nodeCheckpoint(recovered)).toMatchObject({ sha, preservedSha: sha });
 expect(nodeCheckpoint(recovered)?.evidence.every(evidence => evidence.sha === sha)).toBe(true);
});

test("push rejection parks with explicit durability failure and local recovery", async () => {
 const r = await fixture();
 r.ctx.shellRun = async (command, options) => {
  if (command === "test ! -f src/feature.ts") renameSync(r.origin, `${r.origin}-unavailable`);
  return { code: 1, stdout: "", stderr: "required test failed" };
 };
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status).toBe("parked");
 expect(outcome.detail).toContain("durability failure");
 expect(outcome.detail).toContain("not confirmed recoverable on another machine");
 expect(outcome.detail).toContain("local recovery:");
 const checkpoint = nodeCheckpoint(context(r));
 expect(checkpoint?.preservedSha).toBeNull();
 expect(checkpoint?.durabilityError).toContain("durability failure");
 expect(r.github.prs.size).toBe(0);
});

test("checkpoint and preservation repeat without regressing evidence, phase or SHA", async () => {
 const r = await fixture();
 await runNode("20", r.ctx);
 const ctx = context(r);
 await checkpointNode(ctx, { evidence: { sha: await git(ctx.worktree, ["rev-parse", "HEAD"]), kind: "tests", result: "passed", detail: "checked" } });
 r.journal.updateWorker("20", "acme/widgets", { phase: "review" });
 await checkpointNode(ctx);
 const before = nodeCheckpoint(ctx);
 expect(await preserveNodeProgress(ctx)).toBeNull();
 r.journal.updateWorker("20", "acme/widgets", { phase: "implement" });
 expect(await preserveNodeProgress(ctx)).toBeNull();
 expect(nodeCheckpoint(ctx)).toEqual(before);
 const base = await git(ctx.worktree, ["rev-parse", "origin/main"]);
 await expect(checkpointNode(ctx, { sha: base })).rejects.toThrow("saved progress was retained");
 expect(nodeCheckpoint(ctx)).toEqual(before);
});

test("new committed SHA drops old evidence and stale generation cannot change checkpoint", async () => {
 const r = await fixture();
 await runNode("20", r.ctx);
 const ctx = context(r);
 const before = nodeCheckpoint(ctx)!;
 writeFileSync(join(ctx.worktree, "another.txt"), "new progress");
 await git(ctx.worktree, ["add", "another.txt"]);
 await git(ctx.worktree, ["commit", "-m", "new progress"]);
 const next = await checkpointNode(ctx);
 expect(next.sha).not.toBe(before.sha);
 expect(next.evidence).toEqual([]);
 await expect(checkpointNode(ctx, { evidence: before.evidence[0] })).rejects.toThrow("cannot certify checkpoint");
 r.journal.beginGeneration("20", "acme/widgets");
 await expect(checkpointNode(ctx)).rejects.toThrow("superseded");
 expect(nodeCheckpoint(ctx)).toEqual(next);
});

test("divergent checkpoint and worktree retain both sides and refuse reconciliation", async () => {
 const r = await fixture();
 await runNode("20", r.ctx);
 const ctx = context(r);
 const saved = nodeCheckpoint(ctx)!;
 await git(ctx.worktree, ["reset", "--hard", "origin/main"]);
 writeFileSync(join(ctx.worktree, "other.txt"), "other work");
 await git(ctx.worktree, ["add", "other.txt"]);
 await git(ctx.worktree, ["commit", "-m", "divergent work"]);
 const other = await git(ctx.worktree, ["rev-parse", "HEAD"]);
 await expect(reconcileNodeProgress(ctx, saved.sha)).rejects.toThrow("diverges from checkpoint");
 expect(await git(ctx.worktree, ["rev-parse", "HEAD"])).toBe(other);
 expect(nodeCheckpoint(ctx)).toEqual(saved);
});

test("restart reconciles a push that completed before checkpoint persistence", async () => {
 const r = await fixture();
 await runNode("20", r.ctx);
 let ctx = context(r);
 writeFileSync(join(ctx.worktree, "recovered.txt"), "committed before crash");
 await git(ctx.worktree, ["add", "recovered.txt"]);
 await git(ctx.worktree, ["commit", "-m", "progress before crash"]);
 const sha = await git(ctx.worktree, ["rev-parse", "HEAD"]);
 const save = r.journal.saveNodeProgress.bind(r.journal);
 const interrupted = spyOn(r.journal, "saveNodeProgress").mockImplementation((repo, node, generation, expected, value) => {
  if (JSON.parse(value).preservedSha === sha) throw new FencedError("simulated process crash after push");
  return save(repo, node, generation, expected, value);
 });
 await expect(preserveNodeProgress(ctx)).rejects.toThrow("simulated process crash");
 interrupted.mockRestore();
 expect(await r.github.sha(ctx.branch)).toBe(sha);
 expect(nodeCheckpoint(ctx)?.preservedSha).not.toBe(sha);
 const path = r.journal.path;
 r.journal.close();
 r.journal = new Journal(path);
 r.ctx.journal = r.journal;
 r.journal.beginGeneration("20", "acme/widgets");
 ctx = context(r);
 await reconcileNodeProgress(ctx, await progressRemote(ctx));
 expect(nodeCheckpoint(ctx)).toMatchObject({ sha, preservedSha: sha, phase: "implement", evidence: [] });
});

test("resume tests and publishes a local descendant before reviewing the stale PR head", async () => {
 const r = await rig({}); rigs.push(r);
 expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
 const before = context(r);
 const old = nodeCheckpoint(before)!.sha;
 writeFileSync(join(before.worktree, "finish.txt"), "finish fix");
 await git(before.worktree, ["add", "finish.txt"]);
 await git(before.worktree, ["commit", "-m", "finish fix before park"]);
 const sha = await git(before.worktree, ["rev-parse", "HEAD"]);
 r.journal.updateWorker("20", "acme/widgets", { status: "parked", pid: null, phase: "review" });
 r.ctx.workerCommand = [implementWorker, "noop"];
 const reviewed: string[] = [];
 r.ctx.reviewer = async (_repo, pr) => {
  const live = await r.github.getPr("acme/widgets", pr);
  reviewed.push(live.headSha);
  return { verdict: "approved", commitId: live.headSha, blockers: 0, majors: 0, nits: 0, body: "Approved", summary: "Approved" };
 };
 expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
 expect(await r.github.sha(before.branch)).toBe(sha);
 expect(reviewed).toEqual([sha]);
 expect(r.journal.listNodeEvents("acme/widgets", "20").some(event => event.kind === "pushed" && event.detail?.includes(old) && event.detail.includes(sha))).toBe(true);
 expect(nodeCheckpoint(context(r))?.evidence.every(evidence => evidence.sha === sha)).toBe(true);
});

for (const graphClosed of [false, true]) test(`a merged PR preserves newer local progress before closure cleanup (graph closed: ${graphClosed})`, async () => {
 const r = await rig({}); rigs.push(r);
 expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
 const ctx = context(r);
 const old = nodeCheckpoint(ctx)!.sha;
 await r.github.merge(1);
 await git(r.origin, ["update-ref", "-d", `refs/heads/${ctx.branch}`]);
 writeFileSync(join(ctx.worktree, "not-merged.txt"), "new work after merged head");
 await git(ctx.worktree, ["add", "not-merged.txt"]);
 await git(ctx.worktree, ["commit", "-m", "new committed progress"]);
 const sha = await git(ctx.worktree, ["rev-parse", "HEAD"]);
 if (graphClosed) {
  const path = join(r.dir, "data/acme__widgets-node-20.json");
  const node = JSON.parse(readFileSync(path, "utf8"));
  node.status = "closed";
  writeFileSync(path, JSON.stringify(node));
 }
 r.journal.updateWorker("20", "acme/widgets", { status: "parked", pid: null });
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status).toBe("parked");
 expect(outcome.detail).toContain("additional committed progress");
 expect(outcome.detail).toContain(old);
 expect(outcome.detail).toContain(sha);
 expect(await r.github.sha(ctx.branch)).toBe(sha);
 expect(await git(ctx.worktree, ["rev-parse", "HEAD"])).toBe(sha);
 expect(nodeCheckpoint(context(r))?.preservedSha).toBe(sha);
});

for (const remoteFails of [false, true]) test(`committed substrate-cap progress survives handoff (remote fails: ${remoteFails})`, async () => {
 const r = await rig({}); rigs.push(r);
 r.ctx.substrate = "claude";
 delete r.ctx.workerCommand;
 r.ctx.substrateReaders = { claude: async () => { throw new Error("unavailable"); }, codex: eligibleCodexReading };
 let calls = 0;
 let committed = "";
 r.ctx.worker = async (prompt, options) => {
  calls++;
  if (calls !== 1) throw new Error("preserved commit must be adopted without another coding session");
  const built = await runCmd(implementWorker, ["build", prompt], options);
  expect(built.code).toBe(0);
  committed = await git(options.cwd!, ["rev-parse", "HEAD"]);
  if (remoteFails) renameSync(r.origin, `${r.origin}-unavailable`);
  return { code: 1, stdout: `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${Math.floor(Date.now() / 1000) + 3600}}}\n`, stderr: "" };
 };
 const outcome = await runNode("20", r.ctx);
 expect(calls).toBe(1);
 expect(await git(context(r).worktree, ["rev-parse", "HEAD"])).toBe(committed);
 if (remoteFails) {
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("durability failure");
  expect(r.journal.listNodeEvents("acme/widgets", "20").some(event => event.kind === "substrate-capped")).toBe(false);
 } else {
  expect(outcome.status).toBe("awaiting-merge");
  expect(await r.github.sha(context(r).branch)).toBe(committed);
  expect(r.journal.deadmanCount()).toBe(0);
 }
});

test("a green command that edits source records no passing SHA gate", async () => {
 const r = await rig({ test: "echo changed >> README.md" }); rigs.push(r);
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status).toBe("failed");
 expect(outcome.detail).toContain("no exact-SHA test evidence was accepted");
 const checkpoint = nodeCheckpoint(context(r));
 expect(checkpoint?.evidence.some(evidence => evidence.kind === "tests" && evidence.result === "passed")).toBe(false);
 expect(checkpoint?.evidence.some(evidence => evidence.kind === "tests-gate" && evidence.result === "passed")).toBe(false);
 expect(r.github.prs.size).toBe(0);
});

test("a valid timeout retry replaces unknown evidence with an accepted exact-SHA gate", async () => {
 const r = await rig({}); rigs.push(r);
 let timedOut = false;
 r.ctx.shellRun = async (command, options) => {
  if (!timedOut && command === "test -f src/feature.ts") {
   timedOut = true;
   return { code: -1, stdout: "", stderr: "supervisor timeout", timedOut: true };
  }
  return runCmd("/bin/sh", ["-c", command], options);
 };
 expect((await runNode("20", r.ctx)).status).toBe("awaiting-merge");
 const checkpoint = nodeCheckpoint(context(r));
 if (checkpoint === null) throw new Error("missing accepted checkpoint");
 expect(checkpoint.evidence).toContainEqual({ sha: checkpoint.sha, kind: "tests-gate", result: "passed", detail: "test -f src/feature.ts" });
 expect(checkpoint.evidence.some(evidence => evidence.kind === "tests" && evidence.result === "passed")).toBe(true);
});

test("an unreadable checkpoint parks with local recovery instead of losing the durability failure", async () => {
 const r = await fixture();
 await runNode("20", r.ctx);
 r.journal.setHealth("node-progress:acme/widgets#20", "{invalid-json");
 r.journal.updateWorker("20", "acme/widgets", { status: "parked", pid: null });
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status).toBe("parked");
 expect(outcome.detail).toContain("durability failure");
 expect(outcome.detail).toContain("local recovery:");
 expect(r.journal.nodeProgress("acme/widgets", "20")).toBe("{invalid-json");
});

async function researchFixture(scenario: "findings" | "outage" | "restricted-file") {
 const r = await rig({}); rigs.push(r);
 const path = join(r.dir, "data/acme__widgets-node-20.json");
 const node = JSON.parse(readFileSync(path, "utf8"));
 node.node.kind = "research";
 node.node.probes = [{ type: "git-ref-exists", ref: "research/progress-20" }];
 writeFileSync(path, JSON.stringify(node));
 let sha = "";
 r.ctx.worker = async (_prompt, options) => {
  const cwd = options.cwd!;
  writeFileSync(join(cwd, "findings.md"), "# Research progress\n\nCommitted findings before worker failure.\n");
  if (scenario === "restricted-file") writeFileSync(join(cwd, "unauthorized.ts"), "export const unauthorized = true;\n");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", "research progress before failure"]);
  sha = await git(cwd, ["rev-parse", "HEAD"]);
  if (scenario === "outage") renameSync(r.origin, `${r.origin}-unavailable`);
  return { code: 1, stdout: "", stderr: "worker interrupted after commit" };
 };
 return Object.assign(r, { committed: () => sha });
}

for (const scenario of ["findings", "outage", "restricted-file"] as const) test(`research failure preserves only findings through its existing policy (${scenario})`, async () => {
 const r = await researchFixture(scenario);
 const outcome = await runNode("20", r.ctx);
 const sha = r.committed();
 const raw = r.journal.nodeProgress("acme/widgets", "20");
 if (raw === null) throw new Error("research checkpoint missing");
 const checkpoint = JSON.parse(raw);
 expect(checkpoint).toMatchObject({ sha, branch: "research/progress-20", phase: "research", evidence: [] });
 expect(r.github.prs.size).toBe(0);
 if (scenario === "findings") {
  expect(outcome.status).toBe("failed");
  expect(await r.github.sha("research/progress-20")).toBe(sha);
  expect(checkpoint.preservedSha).toBe(sha);
 } else {
  expect(outcome.status).toBe("parked");
  expect(outcome.detail).toContain("durability failure");
  expect(outcome.detail).toContain("local recovery:");
  if (scenario === "restricted-file") {
   expect(outcome.detail).toContain("only findings.md");
   expect(await r.github.sha("research/progress-20")).toBe("");
  }
  expect(checkpoint.preservedSha).toBeNull();
 }
});

test("a fresh research clone and journal recover preserved findings and run CI without another worker", async () => {
 const r = await researchFixture("findings");
 expect((await runNode("20", r.ctx)).status).toBe("failed");
 const sha = r.committed();
 r.journal.close();
 renameSync(r.canonical, `${r.canonical}-unavailable`);
 const fresh = join(r.dir, "fresh-research");
 await git(r.dir, ["clone", r.origin, fresh]);
 const journal = new Journal(join(r.dir, "fresh-research.sqlite"));
 r.journal = journal;
 r.ctx.journal = journal;
 r.ctx.map.canonical = fresh;
 r.ctx.researchCiTiming = { settleMs: 0, pollMs: 1, timeoutMs: 1000 };
 let workers = 0;
 r.ctx.worker = async () => { workers++; throw new Error("recovered findings must not rerun coding"); };
 journal.upsertWorker({ nodeId: "20", repo: "acme/widgets", root: 1, status: "claimed", lane: "research" });
 const outcome = await runNode("20", r.ctx);
 expect(workers).toBe(0);
 expect(r.github.prs.size).toBe(1);
 expect(journal.listNodeEvents("acme/widgets", "20").some(event => event.kind === "ci-passed")).toBe(true);
 expect(JSON.parse(journal.nodeProgress("acme/widgets", "20") ?? "{}")).toMatchObject({ sha, preservedSha: sha, phase: "close" });
 expect(outcome.detail).not.toContain("durability failure");
});

test("research draft resume preserves and checks its local descendant before CI", async () => {
 const r = await researchFixture("findings");
 expect((await runNode("20", r.ctx)).status).toBe("failed");
 const branch = "research/progress-20";
 const draft = await r.github.createDraftPr("acme/widgets", { head: branch, base: "main", title: "Findings", body: "Findings" });
 r.journal.updateWorker("20", "acme/widgets", { prNumber: draft.iid, status: "parked", pid: null });
 const worktree = r.journal.getWorker("20", "acme/widgets")!.worktree!;
 writeFileSync(join(worktree, "findings.md"), "# Updated committed findings\n");
 await git(worktree, ["add", "findings.md"]);
 await git(worktree, ["commit", "-m", "additional findings before park"]);
 const sha = await git(worktree, ["rev-parse", "HEAD"]);
 r.ctx.researchCiTiming = { settleMs: 0, pollMs: 1, timeoutMs: 1000 };
 r.ctx.worker = async () => { throw new Error("research resume must recover committed findings"); };
 const checked: string[] = [];
 const verdict = r.github.ciVerdictFor.bind(r.github);
 const ci = spyOn(r.github, "ciVerdictFor").mockImplementation(async (repo, head, token, purpose) => {
  checked.push(head);
  expect(await r.github.sha(branch)).toBe(sha);
  return verdict(repo, head, token, purpose);
 });
 try {
  const outcome = await runNode("20", r.ctx);
  expect(outcome.detail).not.toContain("durability failure");
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.every(head => head === sha)).toBe(true);
  expect(JSON.parse(r.journal.nodeProgress("acme/widgets", "20") ?? "{}").evidence).toContainEqual(expect.objectContaining({ sha, kind: "research-ci", result: "passed" }));
  expect(await r.github.sha(branch)).toBe(sha);
  expect(JSON.parse(r.journal.nodeProgress("acme/widgets", "20") ?? "{}")).toMatchObject({ sha, preservedSha: sha });
  expect(r.github.prs.size).toBe(1);
 } finally { ci.mockRestore(); }
});

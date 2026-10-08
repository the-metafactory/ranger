import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCi } from "../src/ci-policy.ts";
import { runCmd } from "../src/exec.ts";
import type { ChangeRequest, CiVerdict, ForgePort, MergeState } from "../src/forge.ts";
import { githubMergeState } from "../src/github.ts";
import { githubCiVerdict } from "../src/github-ci.ts";
import { mergeGateNow } from "../src/merge-desk.ts";
import { evaluateMergeGate } from "../src/merge-gate.ts";
import { loadConfig } from "../src/config.ts";
import { baseConfigLines } from "./support.ts";

const SHA = "a".repeat(40);
const GREEN: CiVerdict = { state: "green", runId: 17, runUrl: "https://example.test/jobs/17", runName: "test", snapshot: "stable" };
const PR: ChangeRequest = {
 iid: 7, state: "open", draft: false, headRef: "node/121", headSha: SHA,
 baseRef: "main", mergeState: "mergeable", webUrl: "https://example.test/change/7",
 author: "ivy-bot", title: "Node 121", mergeCommitSha: null, mergedBy: null,
};

describe("GitHub merge-state normalisation", () => {
 for (const state of ["clean", "blocked", "unstable", "behind", "draft", "has_hooks"]) {
  test(`${state} preserves the existing mergeability mapping`, () => {
   expect(githubMergeState(true, state)).toBe("mergeable");
   expect(githubMergeState(false, state)).toBe("conflict");
   expect(githubMergeState(null, state)).toBe("pending");
  });
 }
 test("dirty always conflicts; unknown or null means still computing", () => {
  expect(githubMergeState(null, "dirty")).toBe("conflict");
  expect(githubMergeState(true, "dirty")).toBe("conflict");
  expect(githubMergeState(true, "unknown")).toBe("pending");
  expect(githubMergeState(true, undefined)).toBe("pending");
  expect(githubMergeState(null, "unknown")).toBe("pending");
 });
 for (const mergeable of [true, null]) {
  test(`an unfamiliar value is unknown with mergeable=${mergeable}`, () => {
   const mergeState = githubMergeState(mergeable, "future-github-state");
   expect(mergeState).toBe("unknown");
   for (const ci of [GREEN, { state: "pending", reason: "no runs" } as const]) {
    expect(evaluateMergeGate({ pr: { ...PR, mergeState }, ci, expectedBase: "main", verdictSha: SHA, verdictBlockers: 0 }))
     .toEqual({ status: "fail", check: "mergeable", reason: "merge state is unknown" });
   }
  });
 }
});

/** A complete fake ForgePort: unexpected calls throw rather than reaching a forge. */
function fakeForge(ci: CiVerdict, mergeState: MergeState = "mergeable"): ForgePort {
 const unexpected = async (): Promise<never> => { throw new Error("unexpected forge call"); };
 return {
  findPrByHead: unexpected, createDraftPr: unexpected, updatePrBody: unexpected,
  markReady: unexpected, mergePr: unexpected, issueLabels: unexpected, postComment: unexpected,
  getPr: async () => ({ ...PR, mergeState }),
  ciVerdictFor: async (repo, sha, token) => {
   expect([repo, sha, token]).toEqual(["acme/widgets", SHA, "machine"]);
   return ci;
  },
  listComments: async () => [{ id: 1, author: "ivy-bot", body: `<!-- ranger:review round=1 sha=${SHA} blockers=0 majors=0 nits=0 -->` }],
 };
}

test("merge gate and CI policy use only neutral fake-port verdicts", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-forge-port-"));
 try {
  const path = join(dir, "ranger.yaml");
  writeFileSync(path, baseConfigLines(dir).join("\n"));
  const map = loadConfig(path).config.maps[0]!;
  for (const ci of [GREEN, { state: "red", reason: "CI failed: lint=failure" }, { state: "pending", reason: "still running" }] as CiVerdict[]) {
   const forge = fakeForge(ci);
   const policy = classifyCi(await forge.ciVerdictFor(map.repo, SHA, "machine"));
   const gate = await mergeGateNow(forge, map, PR.iid, "machine", "ivy-bot");
   expect(gate.status).toBe(policy.status);
   if (ci.state === "green") expect(gate).toEqual({ status: "pass", ciCheckRunId: 17, headSha: SHA });
   else expect(gate).toEqual({ status: ci.state === "red" ? "fail" : "pending", check: "ci-green", reason: ci.reason });
  }
  for (const state of ["unknown", "blocked", "needs-rebase"] as const) {
   expect(await mergeGateNow(fakeForge(GREEN, state), map, PR.iid, "machine", "ivy-bot"))
    .toEqual({ status: "fail", check: "mergeable", reason: `merge state is ${state}` });
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("GitHub CI classification order and the close citation policy stay unchanged", () => {
 const success = { id: 17, name: "test", status: "completed", conclusion: "success" };
 const failed = { ...success, id: 18, conclusion: "failure" };
 const running = { ...success, id: 19, status: "queued", conclusion: null };
 expect(githubCiVerdict("acme/widgets", [failed, running]).state).toBe("pending");
 expect(githubCiVerdict("acme/widgets", [failed, running], "research").state).toBe("red");
 expect(githubCiVerdict("acme/widgets", [success, failed], "close")).toMatchObject({ state: "green", runId: 17 });
 expect(githubCiVerdict("acme/widgets", [success, failed], "merge").state).toBe("red");
 expect(githubCiVerdict("acme/widgets", [success, { ...success, conclusion: "neutral" }, { ...success, conclusion: "skipped" }]))
  .toMatchObject({ state: "green", runId: 17 });
 for (const purpose of ["merge", "close", "research"] as const) {
  expect(githubCiVerdict("acme/widgets", [success], purpose))
   .toMatchObject({ state: "green", runId: 17, runUrl: "https://github.com/acme/widgets/runs/17" });
 }
});

test("real GitHub getPr maps an unfamiliar mergeable_state before the gate runs", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gh-change-"));
 try {
  writeFileSync(join(dir, "gh"), '#!/usr/bin/env bun\nif (process.env.GH_TOKEN !== "machine") process.exit(95);\nconsole.log(process.env.PR_RESPONSE);\n', { mode: 0o755 });
  const result = await runCmd(process.execPath, ["-e", `
import { getPr } from ${JSON.stringify(join(import.meta.dir, "..", "src", "github.ts"))};
console.log(JSON.stringify(await getPr("acme/widgets", 7, "machine")));
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PR_RESPONSE: JSON.stringify({
   number: 7, state: "open", merged: false, draft: false, mergeable: true, mergeable_state: "future-github-state",
   head: { ref: PR.headRef, sha: SHA }, base: { ref: "main" }, html_url: PR.webUrl, user: { login: PR.author },
  }) } });
  expect(result.code).toBe(0);
  const pr = JSON.parse(result.stdout) as ChangeRequest;
  expect(pr).toMatchObject({ iid: 7, state: "open", mergeState: "unknown", webUrl: PR.webUrl, author: PR.author });
  expect(pr).not.toHaveProperty("mergeableState");
  expect(pr).not.toHaveProperty("mergeable");
  expect(evaluateMergeGate({ pr, ci: GREEN, expectedBase: "main", verdictSha: SHA, verdictBlockers: 0 }))
   .toEqual({ status: "fail", check: "mergeable", reason: "merge state is unknown (mergeable=true, state=future-github-state)" });
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

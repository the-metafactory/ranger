import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

const SHA = "a".repeat(40);
const UPDATED = "b".repeat(40);
const BASE = "c".repeat(40);
const pr = (head = SHA, base = "main") => ({ number: 7, head: { sha: head }, base: { ref: base }, mergeable: true, mergeable_state: "behind" });
const commit = { sha: UPDATED, parents: [{ sha: SHA }, { sha: BASE }] };
interface Reply { args: string[]; body: unknown; status?: number; code?: number }
const readPr = (head = SHA, base = "main"): Reply => ({ args: ["repos/acme/widgets/pulls/7"], body: pr(head, base) });
const request = (status = 202, message = "Updating pull request branch."): Reply => ({
 args: ["repos/acme/widgets/pulls/7/update-branch", "--method", "PUT", "-f", `expected_head_sha=${SHA}`, "--include"],
 body: { message }, status, code: status >= 400 ? 1 : 0,
});
const readCommit = (body: unknown = commit): Reply => ({ args: [`repos/acme/widgets/commits/${UPDATED}`], body });
const compare = (status = "identical", base = "main"): Reply => ({ args: [`repos/acme/widgets/compare/${encodeURIComponent(base)}...${BASE}`], body: { status } });

async function update(replies: Reply[]) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gh-update-"));
 try {
  writeFileSync(join(dir, "replies.json"), JSON.stringify(replies));
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const path = process.env.UPDATE_REPLIES;
const replies = JSON.parse(readFileSync(path, "utf8"));
const reply = replies.shift();
const args = process.argv.slice(2);
appendFileSync(process.env.UPDATE_CALLS, JSON.stringify(args) + "\\n");
if (process.env.GH_TOKEN !== "machine" || !reply || JSON.stringify(args) !== JSON.stringify(["api", ...reply.args])) {
 console.error("unexpected gh request: " + JSON.stringify(args)); process.exit(95);
}
writeFileSync(path, JSON.stringify(replies));
if (reply.status) process.stdout.write("HTTP/2.0 " + reply.status + " Status\\r\\nContent-Type: application/json\\r\\n\\r\\n");
console.log(JSON.stringify(reply.body));
process.exit(reply.code ?? 0);
`, { mode: 0o755 });
  const result = await runCmd(process.execPath, ["-e", `
import { rebasePr } from ${JSON.stringify(join(import.meta.dir, "..", "src", "github.ts"))};
const sleeps = [];
try {
 const outcome = await rebasePr("acme/widgets", 7, ${JSON.stringify(SHA)}, "machine", { polls: 2, intervalMs: 1500, sleep: async (ms) => { sleeps.push(ms); } });
 console.log(JSON.stringify({ outcome, sleeps }));
} catch (e) { console.error(e.message); process.exit(1); }
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, UPDATE_REPLIES: join(dir, "replies.json"), UPDATE_CALLS: join(dir, "calls.jsonl") } });
  const remaining = JSON.parse(readFileSync(join(dir, "replies.json"), "utf8")) as Reply[];
  const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  expect(remaining).toEqual([]);
  return { ...result, calls };
 } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("node #319 — GitHub update-branch port", () => {
 for (const status of ["identical", "behind"]) {
  test(`a merge of the gated head with a base ancestor (${status}) is confirmed`, async () => {
   const r = await update([readPr(), request(), readPr(), readPr(UPDATED), readCommit(), compare(status)]);
   expect(r.code).toBe(0);
   expect(JSON.parse(r.stdout)).toEqual({ outcome: { status: "head-moved", headSha: UPDATED, requested: true }, sleeps: [1500, 1500] });
   expect(r.calls.filter((args) => args.includes("PUT"))).toHaveLength(1);
  });
 }
 test("an update observed on the first poll is confirmed", async () => {
  const r = await update([readPr(), request(), readPr(UPDATED), readCommit(), compare()]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).sleeps).toEqual([1500]);
  expect(JSON.parse(r.stdout).outcome.status).toBe("head-moved");
 });
 test("a head that already moved makes no write", async () => {
  const r = await update([readPr(UPDATED)]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).outcome).toMatchObject({ status: "unconfirmed", reason: expect.stringContaining("before ranger asked") });
  expect(r.calls).toHaveLength(1);
 });
 test("422 preserves GitHub's message without polling or retrying the write", async () => {
  const r = await update([readPr(), request(422, "Expected head sha didn't match current head sha")]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ outcome: { status: "unconfirmed", reason: "Expected head sha didn't match current head sha" }, sleeps: [] });
  expect(r.calls).toHaveLength(2);
 });
 test("an unchanged head exhausts the bounded wait as requested pending", async () => {
  const r = await update([readPr(), request(), readPr(), readPr()]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ outcome: { status: "pending", requested: true, reason: "GitHub is still updating PR #7 after 2 checks" }, sleeps: [1500, 1500] });
 });
 for (const body of [
  null, {}, { sha: UPDATED, parents: [] },
  { sha: UPDATED, parents: [{ sha: SHA }] },
  { sha: UPDATED, parents: [{ sha: SHA }, { sha: BASE }, { sha: "d".repeat(40) }] },
  { sha: UPDATED, parents: [{ sha: BASE }, { sha: SHA }] },
  { sha: UPDATED, parents: [{ sha: SHA }, {}] },
  { ...commit, sha: "d".repeat(40) },
 ]) {
  test(`a moved head without the exact two-parent proof is unconfirmed: ${JSON.stringify(body)}`, async () => {
   const r = await update([readPr(), request(), readPr(UPDATED), readCommit(body)]);
   expect(r.code).toBe(0);
   expect(JSON.parse(r.stdout).outcome.status).toBe("unconfirmed");
  });
 }
 for (const status of ["ahead", "diverged", "unknown"]) {
  test(`a second parent ${status} of the base is unconfirmed`, async () => {
   const r = await update([readPr(), request(), readPr(UPDATED), readCommit(), compare(status)]);
   expect(r.code).toBe(0);
   expect(JSON.parse(r.stdout).outcome.status).toBe("unconfirmed");
  });
 }
 test("a retargeted PR cannot confirm the update", async () => {
  const r = await update([readPr(), request(), readPr(UPDATED, "other")]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).outcome.status).toBe("unconfirmed");
 });
 test("a base branch containing a slash is encoded in the comparison", async () => {
  const r = await update([readPr(SHA, "release/next"), request(), readPr(UPDATED, "release/next"), readCommit(), compare("behind", "release/next")]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).outcome.status).toBe("head-moved");
 });
 for (const status of [200, 403, 500]) {
  test(`an unexpected HTTP ${status} is a fault and the update is not retried`, async () => {
   const r = await update([readPr(), request(status)]);
   expect(r.code).toBe(1);
   expect(r.stderr).toContain(`expected HTTP 202, got ${status}`);
   expect(r.calls).toHaveLength(2);
  });
 }
});

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openJobLedger } from "../src/remote-test/job-ledger.ts";
import type { RemoteTestJob } from "../src/remote-test/contract.ts";
import { runCmd } from "../src/exec.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = `sha256:${"a".repeat(64)}`;
function job(): RemoteTestJob { return { version: 1, jobId: randomUUID(), correlationId: randomUUID(), repositoryId: "github:github.com/example/repo", commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: digest, profileId: "unit", profileDigest: digest, lockDigest: digest, imageDigest: digest, platform: "linux-arm64", deadline: 20_000, generation: 1 }; }
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "remote-ledger-")); roots.push(root);
 let clock = 10_000;
 const ledger = await openJobLedger(root, "fixture", () => clock);
 return { root, ledger, tick: (n: number) => { clock = n; }, now: () => clock };
}
test("independent SQLite callers admit exactly one execution and reject conflicting tuples", async () => {
 const f = await fixture(), other = await openJobLedger(f.root, "fixture", f.now), j = job();
 try {
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => (i % 2 ? other : f.ledger).admit(j))));
  expect(outcomes.filter(o => o.kind === "admitted")).toHaveLength(1);
  expect(outcomes.filter(o => o.kind === "active")).toHaveLength(19);
  const original = f.ledger.status(j);
  expect(() => other.admit({ ...j, treeDigest: "c".repeat(40) })).toThrow("identity conflict");
  expect(f.ledger.status(j)).toEqual(original);
  expect((await stat(join(f.root, ".execution", "ledger.sqlite"))).mode & 0o777).toBe(0o600);
 } finally { other.close(); f.ledger.close(); }
});
test("terminal duplicates reuse the durable exact receipt after restart", async () => {
 const f = await fixture(), j = job(), a = f.ledger.admit(j);
 if (a.kind !== "admitted") throw Error();
 f.ledger.launch(j, a.token);
 const receipt = f.ledger.complete(j, a.token, { version: 1, identity: j, executorId: "fixture", status: "passed", exitCode: 0, completedAt: f.now() });
 f.ledger.close();
 const reopened = await openJobLedger(f.root, "fixture", f.now);
 try { expect(reopened.admit(j)).toEqual({ kind: "terminal", receipt }); } finally { reopened.close(); }
});
test("completed outcomes retain their original status and time after the execution deadline", async () => {
 for (const status of ["passed", "test_failed"] as const) {
  const f = await fixture(), j = job(), a = f.ledger.admit(j); if (a.kind !== "admitted") throw Error();
  f.ledger.launch(j, a.token);
  const receipt = f.ledger.complete(j, a.token, { version: 1, identity: j, executorId: "fixture", status, exitCode: status === "passed" ? 0 : 1, completedAt: f.now() });
  f.tick(j.deadline + 1);
  expect(f.ledger.status(j)).toEqual({ kind: "terminal", receipt }); expect(f.ledger.admit(j)).toEqual({ kind: "terminal", receipt });
  f.ledger.cancel(j); const cancelled = f.ledger.status(j); if (cancelled?.kind !== "terminal") throw Error(); expect(cancelled.receipt.status).toBe("cancelled");
  f.ledger.close();
 }
});
test("real concurrent processes race one SQLite admission, not one JavaScript connection", async () => {
 const f = await fixture(), j = job();
 try {
  const modulePath = new URL("../src/remote-test/job-ledger.ts", import.meta.url).pathname;
  const program = `import {openJobLedger} from ${JSON.stringify(modulePath)}; const ledger=await openJobLedger(process.argv[1],"fixture",()=>10000); try { console.log(JSON.stringify(ledger.admit(JSON.parse(process.argv[2])))); } finally {ledger.close();}`;
  const results = await Promise.all(Array.from({ length: 8 }, () => runCmd(process.execPath, ["-e", program, f.root, JSON.stringify(j)])));
  for (const result of results) expect(result.code).toBe(0);
  const admissions = results.map(r => JSON.parse(r.stdout));
  expect(admissions.filter(a => a.kind === "admitted")).toHaveLength(1);
  expect(admissions.filter(a => a.kind === "active")).toHaveLength(7);
 } finally { f.ledger.close(); }
});
test("ledger refuses a linked database instead of opening an unrelated supervisor journal", async () => {
 const f = await fixture(); f.ledger.close();
 await rm(join(f.root, ".execution", "ledger.sqlite"));
 await symlink(join(f.root, "supervisor.sqlite"), join(f.root, ".execution", "ledger.sqlite"));
 await expect(openJobLedger(f.root, "fixture", f.now)).rejects.toThrow();
 expect(await stat(join(f.root, "supervisor.sqlite")).catch(() => null)).toBeNull();
});
test("cancel before admission is durable, fences the generation and never launches", async () => {
 const f = await fixture(), j = job(); f.ledger.cancel(j); f.ledger.close();
 const reopened = await openJobLedger(f.root, "fixture", f.now);
 try {
  expect(reopened.admit(j).kind).toBe("terminal");
  expect(reopened.admit({ ...j, jobId: randomUUID() }).kind).toBe("terminal");
 } finally { reopened.close(); }
});
test("cancellation, expiry and supersession fence launch and late success", async () => {
 for (const reason of ["cancel", "expire", "supersede"] as const) {
  const f = await fixture(), j = job(), a = f.ledger.admit(j); if (a.kind !== "admitted") throw Error();
  if (reason === "cancel") f.ledger.cancel(j);
  if (reason === "expire") f.tick(j.deadline);
  if (reason === "supersede") f.ledger.admit({ ...j, jobId: randomUUID(), generation: 2 });
  expect(() => f.ledger.launch(j, a.token)).toThrow();
  expect(f.ledger.complete(j, a.token, { version: 1, identity: j, executorId: "fixture", status: "passed", exitCode: 0, completedAt: 10_000 }).status).not.toBe("passed");
  f.ledger.close();
 }
});
test("restart removes labelled containers before one fresh infrastructure retry; old tokens cannot finish", async () => {
 const f = await fixture(), j = job(), a = f.ledger.admit(j); if (a.kind !== "admitted") throw Error();
 f.ledger.launch(j, a.token);
 let containers = [{ id: "a".repeat(64), ledgerId: f.ledger.id, jobId: j.jobId, token: a.token }];
 const removed: string[] = [];
 const adapters = { list: async () => containers, remove: async (id: string) => { removed.push(id); containers = []; }, cleanup: async () => {} };
 await f.ledger.reconcile(adapters);
 expect(removed).toEqual(["a".repeat(64)]);
 const retry = f.ledger.admit(j); if (retry.kind !== "admitted") throw Error();
 expect(retry.attempt).toBe(2); expect(retry.token).not.toBe(a.token);
 expect(() => f.ledger.complete(j, a.token, { version: 1, identity: j, executorId: "fixture", status: "passed", exitCode: 0, completedAt: f.now() })).toThrow("attempt fence");
 await f.ledger.reconcile(adapters);
 const final = f.ledger.admit(j); expect(final.kind).toBe("terminal");
 if (final.kind === "terminal") expect(final.receipt.status).toBe("infra_failed");
 f.ledger.close();
});
test("failed reconciliation leaves a durable global fence and ignores foreign containers", async () => {
 const f = await fixture(), j = job(); f.ledger.admit(j);
 const containers = [{ id: "b".repeat(64), ledgerId: randomUUID(), jobId: j.jobId, token: randomUUID() }, { id: "a".repeat(64), ledgerId: f.ledger.id, jobId: j.jobId, token: j.jobId }];
 const removed: string[] = [];
 await expect(f.ledger.reconcile({ list: async () => containers, remove: async id => { removed.push(id); throw Error("engine unavailable"); }, cleanup: async () => {} })).rejects.toThrow();
 expect(removed).toEqual(["a".repeat(64)]);
 expect(() => f.ledger.admit(job())).toThrow("recovery fence"); f.ledger.close();
 const reopened = await openJobLedger(f.root, "fixture", f.now);
 try { expect(() => reopened.admit(job())).toThrow("recovery fence"); } finally { reopened.close(); }
});
test("test failures do not retry and cancelled interrupted work remains cancelled", async () => {
 const f = await fixture(), j = job(), a = f.ledger.admit(j); if (a.kind !== "admitted") throw Error();
 f.ledger.complete(j, a.token, { version: 1, identity: j, executorId: "fixture", status: "test_failed", exitCode: 1, completedAt: f.now() });
 await f.ledger.reconcile({ list: async () => [], remove: async () => {}, cleanup: async () => {} });
 expect(f.ledger.admit(j).kind).toBe("terminal");
 const k = job(); f.ledger.admit(k); f.ledger.cancel(k);
 await f.ledger.reconcile({ list: async () => [], remove: async () => {}, cleanup: async () => {} });
 const result = f.ledger.admit(k); if (result.kind !== "terminal") throw Error(); expect(result.receipt.status).toBe("cancelled");
 f.ledger.close();
});

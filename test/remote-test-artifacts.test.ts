import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_DEFAULTS, persistExecution, publishReceiptFile } from "../src/remote-test/artifacts.ts";
import type { RemoteTestReceipt } from "../src/remote-test/contract.ts";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function fixture() {
 const home = await mkdtemp(join(tmpdir(), "ranger-artifacts-")); roots.push(home);
 return { home, root: join(home, "artifacts") };
}
const id = (n = 1) => `6c7e8091-1234-4234-8234-${String(n).padStart(12, "0")}`;
function receipt(n = 1, completedAt = 1000): RemoteTestReceipt {
 return { version: 1, executorId: "fixture", status: "passed", exitCode: 0, completedAt,
  identity: { version: 1, jobId: id(n), correlationId: id(), repositoryId: "github:github.com/the-metafactory/ranger", commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: `sha256:${"c".repeat(64)}`, profileId: "unit-v1", profileDigest: `sha256:${"d".repeat(64)}`, lockDigest: `sha256:${"e".repeat(64)}`, imageDigest: `sha256:${"f".repeat(64)}`, platform: "linux-arm64", deadline: 100_000, generation: 1 } };
}
const observation = { startedAt: 500, log: Buffer.from("test output\n"), outputState: "captured" as const, truncated: false,
 resources: { state: "observed" as const, cpuTimeMicros: 120, peakMemoryBytes: 4096 } };
test("stores a complete checksummed private receipt and log, preserving every identity field", async () => {
 const f = await fixture(); const result = await persistExecution(f.root, receipt(), observation, { now: () => 1000 });
 expect(result.identity).toEqual(receipt().identity);
 expect(result.evidence!.durationMs).toBe(500);
 expect(result.evidence!.resources).toEqual(observation.resources);
 const log = await readFile(join(f.root, id(), "test.log"));
 expect(result.evidence!.output.artifact!.checksum).toBe(`sha256:${createHash("sha256").update(log).digest("hex")}`);
 expect(JSON.parse(await readFile(join(f.root, id(), "receipt.json"), "utf8"))).toEqual(result);
 for (const path of [f.root, join(f.root, id())]) expect((await stat(path)).mode & 0o777).toBe(0o700);
 for (const path of ["receipt.json", "test.log"]) expect((await stat(join(f.root, id(), path))).mode & 0o777).toBe(0o600);
});
test("publication is all-or-nothing on injected write, file sync, rename and directory sync failure", async () => {
 for (const failure of ["log-write", "receipt-write", "file-sync", "publish", "root-sync"] as const) {
  const f = await fixture();
  await expect(persistExecution(f.root, receipt(), observation, { now: () => 1000, fault: step => { if (step === failure) throw Error("injected IO failure"); } })).rejects.toThrow();
  expect(await stat(join(f.root, id())).catch(() => null)).toBeNull();
 }
});
test("terminal path stays absent until both complete files are synced", async () => {
 const f = await fixture(); let checked = false;
 await persistExecution(f.root, receipt(), observation, { now: () => 1000, fault: async step => {
  if (step === "publish") { checked = true; expect(await stat(join(f.root, id())).catch(() => null)).toBeNull(); }
 } }); expect(checked).toBe(true);
});
test("bounds log bytes and hashes retained bytes rather than discarded output", async () => {
 const f = await fixture(); const result = await persistExecution(f.root, receipt(), observation, { maxLogBytes: 4, now: () => 1000 });
 expect(await readFile(join(f.root, id(), "test.log"), "utf8")).toBe("test");
 expect(result.evidence!.output.artifact!.bytes).toBe(4); expect(result.evidence!.output.truncated).toBe(true);
});
test("skipped and unavailable output/resource observations are explicit", async () => {
 for (const state of ["skipped", "unavailable"] as const) {
  const f = await fixture(); const r = await persistExecution(f.root, { ...receipt(), status: "rejected", exitCode: null }, { startedAt: 500, log: Buffer.alloc(0), truncated: false, outputState: state, resources: { state, cpuTimeMicros: null, peakMemoryBytes: null } }, { now: () => 1000 });
  expect(r.evidence!.output).toEqual({ state, truncated: false, artifact: null });
  expect(await stat(join(f.root, id(), "test.log")).catch(() => null)).toBeNull();
 }
});
test("retention removes expired terminal statuses while leaving active state untouched", async () => {
 const f = await fixture();
 for (const [i, status] of ["passed", "test_failed", "timed_out"].entries()) await persistExecution(f.root, { ...receipt(i + 1), status: status as RemoteTestReceipt["status"], exitCode: status === "passed" ? 0 : 1 }, observation, { now: () => 1000 });
 const active = join(f.root, ".pending-active"); await mkdir(active); await writeFile(join(active, "state"), "active");
 await persistExecution(f.root, receipt(4, 4000), observation, { retentionMs: 2000, now: () => 4000 });
 for (const n of [1, 2, 3]) expect(await stat(join(f.root, id(n))).catch(() => null)).toBeNull();
 expect(await readFile(join(active, "state"), "utf8")).toBe("active");
});
test("aggregate cap evicts oldest completed jobs and refuses a single oversized receipt", async () => {
 const f = await fixture(); await persistExecution(f.root, receipt(), observation, { now: () => 1000 });
 const bytes = (await stat(join(f.root, id(), "receipt.json"))).size + observation.log.length;
 await persistExecution(f.root, receipt(2, 1001), observation, { maxArtifactBytes: bytes + 10, now: () => 1001 });
 expect(await stat(join(f.root, id())).catch(() => null)).toBeNull();
 await expect(persistExecution(f.root, receipt(3), observation, { maxArtifactBytes: 10, now: () => 1001 })).rejects.toThrow();
 expect(await stat(join(f.root, id(3))).catch(() => null)).toBeNull();
});
test("active bytes count against the cap and are never evicted to admit a result", async () => {
 const f = await fixture(); await mkdir(f.root, { mode: 0o700 }); await mkdir(join(f.root, ".pending-active")); await writeFile(join(f.root, ".pending-active", "log"), Buffer.alloc(2000));
 await expect(persistExecution(f.root, receipt(), observation, { maxArtifactBytes: 2000, now: () => 1000 })).rejects.toThrow();
 expect((await stat(join(f.root, ".pending-active", "log"))).size).toBe(2000);
});
test("rejects traversal, symlink stores/job paths, concurrent writes and duplicate terminal identity", async () => {
 const f = await fixture();
 await expect(persistExecution(f.root, { ...receipt(), identity: { ...receipt().identity, jobId: "../escape" } }, observation)).rejects.toThrow();
 await mkdir(f.root, { mode: 0o700 }); await symlink(f.home, join(f.root, id()));
 await expect(persistExecution(f.root, receipt(), observation)).rejects.toThrow(); await rm(join(f.root, id()));
 await mkdir(join(f.root, ".store-lock")); await expect(persistExecution(f.root, receipt(), observation)).rejects.toThrow(); await rm(join(f.root, ".store-lock"), { recursive: true });
 await persistExecution(f.root, receipt(), observation, { now: () => 1000 });
 await expect(persistExecution(f.root, receipt(), observation, { now: () => 1000 })).rejects.toThrow();
 const alias = join(f.home, "alias"); await symlink(f.root, alias); await expect(persistExecution(alias, receipt(2), observation)).rejects.toThrow();
});
test("defaults are seven days and ten GiB; private artifacts cannot be placed inside a repository", async () => {
 expect(ARTIFACT_DEFAULTS.retentionMs).toBe(7 * 24 * 60 * 60 * 1000); expect(ARTIFACT_DEFAULTS.maxArtifactBytes).toBe(10 * 1024 ** 3);
 const f = await fixture(); await mkdir(join(f.home, ".git")); await expect(persistExecution(f.root, receipt(), observation)).rejects.toThrow();
});
test("CLI receipt export is atomic, private, exclusive and fails closed on IO errors", async () => {
 const f = await fixture(); const path = join(f.home, "output.json");
 for (const failure of ["receipt-write", "file-sync", "publish", "root-sync"] as const) {
  await expect(publishReceiptFile(path, receipt(), step => { if (step === failure) throw Error("IO failure"); })).rejects.toThrow();
  expect(await stat(path).catch(() => null)).toBeNull();
 }
 await publishReceiptFile(path, receipt()); expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt());
 await expect(publishReceiptFile(path, receipt(2))).rejects.toThrow(); expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt());
 expect((await stat(path)).mode & 0o777).toBe(0o600);
});

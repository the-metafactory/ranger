import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployLockFile, deployMerged } from "../src/deploy.ts";
import * as exec from "../src/exec.ts";
import { gitCredential } from "../src/git-ops.ts";
import { tryAcquireLock } from "../src/lock.ts";
import { bootstrapWorktree, runNode } from "../src/worker.ts";
import { restoreEnv, rig, type Rig } from "./implement-rig.ts";

const fixtures: Rig[] = [];
const dirs: string[] = [];
afterEach(() => {
 for (const r of fixtures.splice(0)) {
  r.journal.close();
  rmSync(r.dir, { recursive: true, force: true });
 }
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
 restoreEnv();
});

async function mergedAndClosing(deploy?: string) {
 const r = await rig({ autonomy: "propose" });
 fixtures.push(r);
 const branch = "node/20-add-the-feature-module";
 const worktree = await bootstrapWorktree(r.canonical, "20", "add-the-feature-module", gitCredential("acme/widgets", r.ctx.token), branch);
 mkdirSync(join(worktree, "src"), { recursive: true });
 writeFileSync(join(worktree, "src", "feature.ts"), "export const merged = true;\n");
 await exec.runCmd("git", ["add", "src/feature.ts"], { cwd: worktree });
 await exec.runCmd("git", ["commit", "-qm", "the merged change"], { cwd: worktree });
 expect((await exec.runCmd("git", ["push", "origin", branch], { cwd: worktree })).code).toBe(0);
 await r.github.createDraftPr("acme/widgets", { head: branch, base: "main", title: "Feature", body: "Feature" });
 await r.github.merge(1);
 r.journal.updateWorker("20", "acme/widgets", { status: "failed", phase: "close", prNumber: 1, worktree });
 r.ctx.worker = async () => { throw new Error("close-only generation must not run a worker"); };
 if (deploy !== undefined) r.ctx.map.commands = { ...r.ctx.map.commands, deployTimeoutMin: 15, probeTimeoutMin: 30, testTimeoutMin: 20, deploy };
 return r;
}

const events = (r: Rig, kind: string) => r.journal.listEvents("acme/widgets", 200).filter((e) => e.kind === kind);

test("a merge ranger closes runs the map's deploy in the canonical checkout at the merged base, without forge tokens", async () => {
 process.env.GH_TOKEN = "machine-write-token";
 const out = join(tmpdir(), `ranger-deploy-${process.pid}-${Date.now()}.txt`);
 dirs.push(out);
 const r = await mergedAndClosing(`{ pwd -P; cat src/feature.ts; echo "token=\${GH_TOKEN:-none}"; } > ${out}`);
 const result = await runNode("20", r.ctx);
 expect(result.status).toBe("success");
 expect(readFileSync(out, "utf8")).toBe(`${realpathSync(r.canonical)}\nexport const merged = true;\ntoken=none\n`);
 expect(events(r, "deployed")).toHaveLength(1);
 expect(events(r, "deploy-failed")).toHaveLength(0);
 expect(r.announced.some((text) => text.includes("deployed") && text.includes("is live"))).toBe(true);
});

test("a failed deploy is journaled and announced, and the close stands", async () => {
 const r = await mergedAndClosing("echo 'arc upgrade: network down' >&2; exit 3");
 const result = await runNode("20", r.ctx);
 expect(result.status).toBe("success");
 expect(events(r, "closed")).toHaveLength(1);
 const failed = events(r, "deploy-failed");
 expect(failed).toHaveLength(1);
 expect(failed[0].detail).toContain("exited 3: arc upgrade: network down");
 expect(r.announced.some((text) => text.includes("deploy failed") && text.includes("network down"))).toBe(true);
});

test("a map without commands.deploy deploys nothing", async () => {
 const r = await mergedAndClosing();
 const result = await runNode("20", r.ctx);
 expect(result.status).toBe("success");
 expect(events(r, "deployed")).toHaveLength(0);
 expect(events(r, "deploy-failed")).toHaveLength(0);
});

test("deploys of one repo run one at a time", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-deploy-lock-"));
 dirs.push(dir);
 const journalPath = join(dir, "state.sqlite");
 let running = 0;
 let overlap = 0;
 const run = async () => {
  running++;
  overlap = Math.max(overlap, running);
  await new Promise((resolve) => setTimeout(resolve, 50));
  running--;
  return { code: 0, stdout: "", stderr: "" };
 };
 const request = { repo: "acme/widgets", command: "deploy", mergedCheckout: dir, timeoutMs: 5_000, journalPath, run };
 const results = await Promise.all([deployMerged(request), deployMerged(request), deployMerged(request)]);
 expect(results.map((r) => r.status)).toEqual(["deployed", "deployed", "deployed"]);
 expect(overlap).toBe(1);
});

test("a deploy that cannot get the repo's lock fails without running", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-deploy-lock-"));
 dirs.push(dir);
 const journalPath = join(dir, "state.sqlite");
 const lock = deployLockFile(journalPath, "acme/widgets");
 expect(tryAcquireLock(lock, JSON.stringify({ nonce: "other", pid: process.pid, startedAt: Date.now(), leaseUntil: Date.now() + 600_000 }))).toBe(true);
 let ran = false;
 const result = await deployMerged({ repo: "acme/widgets", command: "deploy", mergedCheckout: dir, timeoutMs: 1, journalPath,
  run: async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; } });
 expect(result.status).toBe("failed");
 expect(ran).toBe(false);
}, 120_000);

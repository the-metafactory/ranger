import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 const r = await mergedAndClosing(`{ git rev-parse HEAD; git status --porcelain --branch | head -1; cat src/feature.ts; echo "token=\${GH_TOKEN:-none}"; } > ${out}`);
 const result = await runNode("20", r.ctx);
 expect(result.status).toBe("success");
 const main = (await exec.runCmd("git", ["rev-parse", "main"], { cwd: r.canonical })).stdout.trim();
 expect(readFileSync(out, "utf8")).toBe(`${main}\n## HEAD (no branch)\nexport const merged = true;\ntoken=none\n`);
 expect((await exec.runCmd("git", ["worktree", "list"], { cwd: r.canonical })).stdout).not.toContain("ranger-deploy-");
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

async function gitRepo(): Promise<{ dir: string; canonical: string; journalPath: string; commit: (file: string) => Promise<string> }> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-deploy-"));
 dirs.push(dir);
 const canonical = join(dir, "canonical");
 mkdirSync(canonical);
 const git = async (...args: string[]) => (await exec.runCmd("git", args, { cwd: canonical })).stdout.trim();
 await git("init", "-q", "-b", "main");
 await git("config", "user.email", "t@example.com");
 await git("config", "user.name", "t");
 const commit = async (file: string) => {
  writeFileSync(join(canonical, file), file);
  await git("add", file);
  await git("commit", "-qm", file);
  return git("rev-parse", "HEAD");
 };
 await commit("first");
 return { dir, canonical, journalPath: join(dir, "state.sqlite"), commit };
}

const ok = async () => ({ code: 0, stdout: "", stderr: "" });

test("deploys of one repo run one at a time", async () => {
 const repo = await gitRepo();
 let running = 0;
 let overlap = 0;
 const run = async () => {
  running++;
  overlap = Math.max(overlap, running);
  await new Promise((resolve) => setTimeout(resolve, 50));
  running--;
  return ok();
 };
 const request = { repo: "acme/widgets", command: "deploy", canonical: repo.canonical, base: "main", timeoutMs: 5_000, journalPath: repo.journalPath, run };
 const results = await Promise.all([deployMerged(request), deployMerged(request), deployMerged(request)]);
 expect(results.map((r) => r.status)).toEqual(["deployed", "deployed", "deployed"]);
 expect(overlap).toBe(1);
});

test("a deploy runs the base's newest commit, whatever branch the canonical checkout has out", async () => {
 const repo = await gitRepo();
 const main = await repo.commit("merged");
 await exec.runCmd("git", ["checkout", "-qb", "someone-elses-branch"], { cwd: repo.canonical });
 await repo.commit("unmerged-work");
 let seen = "";
 const result = await deployMerged({ repo: "acme/widgets", command: "deploy", canonical: repo.canonical, base: "main", timeoutMs: 5_000, journalPath: repo.journalPath,
  run: async (_command, opts) => {
   seen = (await exec.runCmd("git", ["rev-parse", "HEAD"], { cwd: opts.cwd })).stdout.trim();
   return ok();
  } });
 expect(result).toMatchObject({ status: "deployed", sha: main });
 expect(seen).toBe(main);
});

test("a deploy that waited its turn deploys the base as it is then, never an older one", async () => {
 const repo = await gitRepo();
 const seen: string[] = [];
 let release!: () => void;
 const held = new Promise<void>((resolve) => { release = resolve; });
 const run = async (_command: string, opts: { cwd?: string }) => {
  seen.push((await exec.runCmd("git", ["rev-parse", "HEAD"], { cwd: opts.cwd })).stdout.trim());
  if (seen.length === 1) await held;
  return ok();
 };
 const request = { repo: "acme/widgets", command: "deploy", canonical: repo.canonical, base: "main", timeoutMs: 5_000, journalPath: repo.journalPath, run };
 const first = deployMerged(request);
 while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
 const second = deployMerged(request);
 const newest = await repo.commit("merged-meanwhile");
 release();
 await Promise.all([first, second]);
 expect(seen[1]).toBe(newest);
});

test("a deploy that cannot get the repo's lock fails without running", async () => {
 const repo = await gitRepo();
 const lock = deployLockFile(repo.journalPath, "acme/widgets");
 expect(tryAcquireLock(lock, JSON.stringify({ nonce: "other", pid: process.pid, startedAt: Date.now(), leaseUntil: Date.now() + 600_000 }))).toBe(true);
 let ran = false;
 const result = await deployMerged({ repo: "acme/widgets", command: "deploy", canonical: repo.canonical, base: "main", timeoutMs: 1, journalPath: repo.journalPath,
  run: async () => { ran = true; return ok(); } });
 expect(result.status).toBe("failed");
 expect(ran).toBe(false);
}, 120_000);

import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as exec from "../src/exec.ts";
import { gitCredential } from "../src/git-ops.ts";
import { workerLogOf } from "../src/serve.ts";
import { sessionPlan } from "../src/serve-parked.ts";
import { bootstrapWorktree, runNode } from "../src/worker.ts";
import { saveWorkerLog, workerLogFile } from "../src/worker-log.ts";
import { restoreEnv, rig, type Rig } from "./implement-rig.ts";

const fixtures: Rig[] = [];
afterEach(() => {
 for (const r of fixtures.splice(0)) {
  r.journal.close();
  rmSync(r.dir, { recursive: true, force: true });
 }
 restoreEnv();
});

async function closeOnly() {
 const r = await rig({ autonomy: "propose" });
 fixtures.push(r);
 const branch = "node/20-add-the-feature-module";
 const worktree = await bootstrapWorktree(r.canonical, "20", "add-the-feature-module", gitCredential("acme/widgets", r.ctx.token), branch);
 expect((await exec.runCmd("git", ["push", "origin", branch], { cwd: worktree })).code).toBe(0);
 await r.github.createDraftPr("acme/widgets", { head: branch, base: "main", title: "Feature", body: "Feature" });
 await r.github.merge(1);
 r.journal.updateWorker("20", "acme/widgets", { status: "failed", phase: "close", prNumber: 1, worktree });
 r.ctx.worker = async () => { throw new Error("close-only generation must not run a worker"); };
 return r;
}

test.each([0, 1])("close-only generation keeps complete stdout and stderr with exit %s", async code => {
 const r = await closeOnly();
 const stdout = `probe output begins\n${"passing test\n".repeat(1000)}probe output ends\n`;
 const stderr = `Close refused: probe failed\n${"diagnostic\n".repeat(1000)}(fail) the failing probe\n`;
 const realRun = exec.runCmd;
 const runner = spyOn(exec, "runCmd").mockImplementation(async (command, args, opts) =>
  command === "soma" && args[1] === "close" ? { code, stdout, stderr } : realRun(command, args, opts));
 try {
  const result = await runNode("20", r.ctx);
  expect(result.status).toBe(code === 0 ? "success" : "parked");
  const row = r.journal.getWorker("20", "acme/widgets");
  if (row === null) throw new Error("missing worker row");
  const log = workerLogFile(r.journal.path, "acme/widgets", "20", row.generation);
  expect(existsSync(log)).toBe(true);
  const text = readFileSync(log, "utf8");
  expect(text).toContain("soma graph close 20");
  expect(text).toContain(`exit ${code}`);
  expect(text).toContain(`----- stdout\n${stdout}`);
  expect(text).toContain(`----- stderr\n${stderr}`);
  expect(workerLogOf(r.ctx.config, "acme/widgets", "20")).toBe(log);
  if (code !== 0) {
   const parked = r.journal.listEvents("acme/widgets", 200).find(e => e.kind === "parked");
   expect(parked?.detail).toStartWith("close refused after merge:");
   expect(parked?.detail?.length).toBeLessThan(stdout.length);
  }
 } finally {
  runner.mockRestore();
 }
});

test("dashboard log lookup names only an existing file from this or an earlier generation", async () => {
 const r = await rig({});
 fixtures.push(r);
 r.journal.beginGeneration("20", "acme/widgets");
 r.journal.beginGeneration("20", "acme/widgets");
 const notice = () => sessionPlan({
  repo: "acme/widgets", nodeId: "20", reason: { class: "other", detail: "close refused" }, cwd: r.canonical,
  workerLog: workerLogOf(r.ctx.config, "acme/widgets", "20"),
 }).prompt;
 expect(workerLogOf(r.ctx.config, "acme/widgets", "20")).toBeNull();
 expect(notice()).not.toContain("worker's log");
 const previous = saveWorkerLog(r.journal.path, "acme/widgets", "20", 1, "build", { code: 0, stdout: "built", stderr: "" });
 saveWorkerLog(r.journal.path, "acme/widgets", "21", 2, "other node", { code: 0, stdout: "other", stderr: "" });
 const future = saveWorkerLog(r.journal.path, "acme/widgets", "20", 3, "future", { code: 0, stdout: "future", stderr: "" });
 expect(workerLogOf(r.ctx.config, "acme/widgets", "20")).toBe(previous);
 expect(notice()).toContain(`The worker's log is ${previous}.`);
 expect(workerLogOf(r.ctx.config, "acme/widgets", "99")).toBeNull();
 const current = workerLogFile(r.journal.path, "acme/widgets", "20", 2);
 mkdirSync(current);
 expect(workerLogOf(r.ctx.config, "acme/widgets", "20")).toBe(previous);
 rmSync(current, { recursive: true });
 mkdirSync(dirname(current), { recursive: true });
 writeFileSync(current, "current output");
 expect(workerLogOf(r.ctx.config, "acme/widgets", "20")).toBe(current);
 expect(existsSync(future)).toBe(true);
});

test("an unwritable close log leaves a log-failed event without changing the refusal", async () => {
 const r = await closeOnly();
 mkdirSync(join(r.dir, "logs"));
 writeFileSync(join(r.dir, "logs", "workers"), "cannot create a directory here");
 process.env.FAKE_SOMA_CLOSE_FAIL = "Close refused: probe failed";
 const result = await runNode("20", r.ctx);
 expect(result.status).toBe("parked");
 expect(result.detail).toContain("Close refused: probe failed");
 expect(workerLogOf(r.ctx.config, "acme/widgets", "20")).toBeNull();
 expect(result.detail).not.toContain(".log");
 const failed = r.journal.listEvents("acme/widgets", 200).find(e => e.kind === "log-failed");
 expect(failed?.detail).toContain("soma graph close 20");
});

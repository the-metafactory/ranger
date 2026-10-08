import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { compareShadow, createShadowTestBackend, readShadowCpu, runShadowMeasured, summarizeShadow, writeShadowReport, type ShadowComparison } from "../src/remote-test/shadow.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import type { RemoteTestJob, RemoteTestReceipt } from "../src/remote-test/contract.ts";
import type { TestBackend, TestRequest, TestResult } from "../src/remote-test/supervisor-backend.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const d = `sha256:${"a".repeat(64)}`;
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-shadow-"))); roots.push(root); await chmod(root, 0o700);
 const repo = join(root, "repo"); await mkdir(repo);
 const git = async (...args: string[]) => {
  const r = await runCmd("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  if (r.code) throw Error(r.stderr); return r.stdout.trim();
 };
 await git("init", "-q"); await writeFile(join(repo, "test.txt"), "fixture"); await git("add", "."); await git("commit", "-qm", "fixture");
 const request: TestRequest = { head: await git("rev-parse", "HEAD"), worktree: repo, repositoryId: "github:github.com/acme/widgets", generation: 1, correlationId: randomUUID() };
 const job: RemoteTestJob = { version: 1, jobId: randomUUID(), correlationId: request.correlationId, repositoryId: request.repositoryId, commitDigest: request.head, treeDigest: await git("rev-parse", "HEAD^{tree}"), bundleDigest: d, profileId: "unit-v1", profileDigest: d, lockDigest: d, imageDigest: d, platform: "linux-arm64", deadline: Date.now()+60_000, generation: 1 };
 const receipt: RemoteTestReceipt = { version: 1, identity: job, executorId: "fixture", status: "passed", exitCode: 0, completedAt: Date.now(), coverage: { requiredSkippedTests: 0 } };
 const path = join(root, "receipt.json"); await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
 const remote: TestResult = { result: { code: 0, stdout: "", stderr: "" }, evidence: { job, receipt, path, validUntil: Date.now()+60_000 } };
 const selection = { kind: "shadow" as const, reportRoot: root, stateRoot: root, configFile: path, profileId: "unit-v1", lockFile: "bun.lock", deadlineSeconds: 60 };
 return { root, repo, request, job, remote, selection, path };
}
const local = { code: 0, stdout: "original local", stderr: "original diagnostics", cpuTimeSeconds: 12.5 };
test("shadow executes local exactly once and never lets remote success upgrade local failure", async () => {
 const f = await fixture(); let calls=0; const reports: ShadowComparison[]=[];
 const backend = createShadowTestBackend(f.selection, { remote: { kind: "ssh", run: async (_r, forbidden) => { await expect(forbidden()).rejects.toThrow(); return f.remote; } }, write: async r => { reports.push(r); } });
 expect(backend.kind).toBe("local");
 const result = await backend.run(f.request, async () => { calls++; return { ...local, code: 7 }; });
 expect(calls).toBe(1); expect(result.result.code).toBe(7); expect(result.result.stdout).toBe(local.stdout); expect(result.evidence).toBeUndefined();
 expect(reports[0]!.parity).toBe("different"); expect(reports[0]!.local.laptopCpuSeconds).toBe(12.5);
 expect(reports[0]!.local.receipt!.identity).toEqual(reports[0]!.remote.receipt!.identity);
 expect(reports[0]!.remote.queueMs).toBeNull(); expect(reports[0]!.remote.transferMs).toBeNull();
});
test("missing mismatched failed interrupted and storage failures leave passing local authoritative and visible", async () => {
 for (const scenario of ["missing", "mismatch", "failure", "interrupt", "store"] as const) {
  const f = await fixture(), reports: ShadowComparison[] = [];
  const backend: TestBackend = { kind: "ssh", run: async () => {
   if (scenario === "interrupt") throw Error("secret endpoint");
   if (scenario === "missing") return { result: { code: 1, stdout: "", stderr: "" } };
   if (scenario === "mismatch") return { ...f.remote, evidence: { ...f.remote.evidence!, receipt: { ...f.remote.evidence!.receipt, identity: { ...f.job, generation: 2 } } } };
   if (scenario === "failure") { const receipt = { ...f.remote.evidence!.receipt, status: "test_failed" as const, exitCode: 1 }; await writeFile(f.path, JSON.stringify(receipt)); return { result: { code: 1, stdout: "", stderr: "" }, evidence: { ...f.remote.evidence!, receipt } }; }
   return f.remote;
  } };
  const result = await createShadowTestBackend(f.selection, { remote: backend, write: async r => { if (scenario === "store") throw Error("private path"); reports.push(r); } }).run(f.request, async () => local);
  expect(result.result.code).toBe(0); expect(result.evidence).toBeUndefined(); expect(result.result.stderr).toContain("Local gate authoritative"); expect(result.result.stderr).not.toContain("secret"); expect(result.result.stderr).not.toContain("private path");
  if (scenario === "failure") expect(reports[0]!.parity).toBe("different");
  else if (scenario === "store") expect(result.result.stderr).toContain("report unavailable");
  else expect(reports[0]!.parity).toBe("pending");
 }
});
test("correlation checks every immutable field and distinguishes coverage parity and pending", async () => {
 const f = await fixture();
 for (const field of Object.keys(f.job) as (keyof RemoteTestJob)[]) {
  const identity = { ...f.job, [field]: typeof f.job[field] === "number" ? Number(f.job[field])+1 : String(f.job[field])+"x" };
  const altered = { ...f.remote, evidence: { ...f.remote.evidence!, receipt: { ...f.remote.evidence!.receipt, identity } } };
  expect(compareShadow(f.request, local, 10, altered, 20).remote.state).toBe("invalid");
 }
 const same = compareShadow(f.request, local, 10, f.remote, 20, { laptopCpuSeconds: 5, requiredSkippedTests: 0 });
 expect(same.parity).toBe("same"); expect(same.coverageParity).toBe("same");
 expect(compareShadow(f.request, local, 10, f.remote, 20, { laptopCpuSeconds: null, requiredSkippedTests: 2 }).coverageParity).toBe("different");
 expect(compareShadow(f.request, local, 10, f.remote, 20).coverageParity).toBe("pending");
});
test("source changes during remote comparison refuse current gate", async () => {
 const f = await fixture();
 const result = await createShadowTestBackend(f.selection, { remote: { kind: "ssh", run: async () => { await writeFile(join(f.repo, "test.txt"), "mutated"); return f.remote; } }, write: async () => {} }).run(f.request, async () => local);
 expect(result.result.code).toBe(1); expect(result.result.stderr).toContain("source changed");
});
function jobs(job: RemoteTestJob) {
 return Array.from({ length: 10 }, () => ({ identity: { ...job, jobId: randomUUID() }, source: "measured", baselineLaptopCpuSeconds: 10, activatedLaptopCpuSeconds: 2, reservedHostRamBytes: 1024**3, unexpectedServiceRestarts: 0, oomEvents: 0, queueMs: 5, transferMs: 10, jobMs: 20 }));
}
test("ten measured jobs require 80 percent CPU savings, one GiB reserve and zero restart/OOM deltas", async () => {
 const f = await fixture(), data = { version: 1, jobs: jobs(f.job) };
 expect(summarizeShadow(data).status).toBe("passed");
 for (const [field, value] of [["activatedLaptopCpuSeconds", 3], ["reservedHostRamBytes", 1024**3-1], ["unexpectedServiceRestarts", 1], ["oomEvents", 1]] as const) {
  const copy = structuredClone(data); for (const job of copy.jobs) job[field] = value;
  expect(summarizeShadow(copy).status).toBe("failed");
 }
});
test("observed safety failures remain failed when the pilot or other metrics are incomplete", async () => {
 const f = await fixture();
 for (const field of ["reservedHostRamBytes", "unexpectedServiceRestarts", "oomEvents"] as const) {
  const values = jobs(f.job).slice(0, 2); values[0]![field] = field === "reservedHostRamBytes" ? 0 : 1;
  const incomplete = values.map((j, i) => i ? { ...j, [field]: null } : j);
  expect(summarizeShadow({ version: 1, jobs: incomplete }).status).toBe("failed");
 }
});
test("fixtures fewer jobs zero baselines and unavailable measurements cannot claim pilot success", async () => {
 const f = await fixture();
 for (const altered of [jobs(f.job).slice(0,9), jobs(f.job).map(j=>({...j, source:"fixture"})), jobs(f.job).map(j=>({...j,baselineLaptopCpuSeconds:0})), jobs(f.job).map(j=>({...j,oomEvents:null})), jobs(f.job).map(j=>({...j,activatedLaptopCpuSeconds:null}))]) expect(summarizeShadow({version:1,jobs:altered}).status).toBe("pending");
 const duplicate = jobs(f.job); duplicate[1]!.identity.jobId=duplicate[0]!.identity.jobId;
 expect(()=>summarizeShadow({version:1,jobs:duplicate})).toThrow("Duplicate");
 expect(()=>summarizeShadow({version:1,jobs:jobs(f.job).map(j=>({...j,activatedLaptopCpuSeconds:-1}))})).toThrow();
});
test("reports are exclusive private files outside repositories; summary command is opt-in and redacted", async () => {
 const f=await fixture(), path=join(f.root,"summary.json"), input=join(f.root,"input.json");
 await writeShadowReport(path,{ fixture: true }); expect((await stat(path)).mode&0o777).toBe(0o600);
 await expect(writeShadowReport(path,{})).rejects.toThrow();
 await expect(writeShadowReport(join(f.repo,"private.json"),{})).rejects.toThrow();
 await writeFile(input,JSON.stringify({version:1,jobs:jobs(f.job).map(j=>({...j,source:"fixture"}))}),{mode:0o600});
 const result=await runCmd("bun",["src/cli.ts","remote-test","shadow-summary","--input",input,"--output",join(f.root,"cli-summary.json")]);
 expect(result.code).toBe(0); expect(result.stdout).toContain("pending"); expect(result.stdout).not.toContain(f.root);
 expect(JSON.parse(await readFile(join(f.root,"cli-summary.json"),"utf8")).status).toBe("pending");
});
test("map shadow selector requires private report destination; unset stays local, SSH unchanged", async () => {
 const f=await fixture(), path=join(f.root,"ranger.yaml");
 const config=async(selection?:unknown)=>writeFile(path,JSON.stringify({version:1,maps:[{repo:"acme/widgets",root:1,...(selection?{testBackend:selection}:{})}]}));
 await config(); expect(loadConfig(path).config.maps[0]!.testBackend).toBeUndefined();
 await config(f.selection); expect(loadConfig(path).config.maps[0]!.testBackend!.kind).toBe("shadow");
 const {reportRoot,...missing}=f.selection; await config(missing); expect(()=>loadConfig(path)).toThrow(ConfigError);
 await config({...f.selection,reportRoot:"relative"}); expect(()=>loadConfig(path)).toThrow(ConfigError);
});
test("rejected production SSH evidence is invalid rather than missing", async () => {
 const f = await fixture();
 for (const refusal of ["invalid_receipt", "source_or_receipt_validation", "revoked"]) {
  const report = compareShadow(f.request, local, 10, { result: { code: 1, stdout: "", stderr: "redacted" }, refusal }, 20);
  expect(report.remote.state).toBe("invalid"); expect(report.remote.refusal).toBe(refusal);
 }
 expect(compareShadow(f.request, local, 10, { result: { code: 1, stdout: "", stderr: "" }, refusal: "no_terminal_receipt" }, 20).remote.state).toBe("missing");
});
test("real timer preserves CPU after unterminated test diagnostics", async () => {
 const raw = await runCmd("/usr/bin/time", ["-p", "/bin/sh", "-c", "printf no-newline >&2; exit 7"], { env: { PATH: process.env.PATH, LC_ALL: "C" } });
 const result = readShadowCpu(raw);
 expect(result.code).toBe(7); expect(result.cpuTimeSeconds).toBeGreaterThanOrEqual(0); expect(result.stderr).toBe("no-newline");
});
test("optional CPU timing preserves original local results and environment when unavailable", async () => {
 const run = (command: string) => runCmd("/bin/sh", ["-c", command], { env: { PATH: process.env.PATH, LC_ALL: "caller-locale", MARKER: "original" } });
 const command = 'printf "%s:%s" "$LC_ALL" "$MARKER"; exit 7';
 for (const available of [async () => false, async () => { throw Error("unavailable"); }]) {
  const result = await runShadowMeasured(command, run, available);
  expect(result.code).toBe(7); expect(result.stdout).toBe("caller-locale:original"); expect(result.cpuTimeSeconds).toBeUndefined();
 }
 const measured = await runShadowMeasured(command, run, async () => true);
 expect(measured.code).toBe(7); expect(measured.stdout).toBe("caller-locale:original"); expect(measured.cpuTimeSeconds).toBeGreaterThanOrEqual(0);
 const comma = readShadowCpu({ code: 3, stdout: "", stderr: "diagnosticsreal 1,5\nuser 0,5\nsys 0,1\n" });
 expect(comma.cpuTimeSeconds).toBeCloseTo(0.6); expect(comma.code).toBe(3); expect(comma.stderr).toBe("diagnostics");
});
test("real child CPU timer footer is observed; missing data stays pending without changing exit", async () => {
 const raw=await runCmd("/usr/bin/time",["-p","/bin/sh","-c","exit 7"],{env:{PATH:process.env.PATH,LC_ALL:"C"}});
 const measured=readShadowCpu(raw); expect(measured.code).toBe(7); expect(measured.cpuTimeSeconds).toBeGreaterThanOrEqual(0);
 expect(readShadowCpu({code:0,stdout:"",stderr:"no timing"}).cpuTimeSeconds).toBeUndefined();
});

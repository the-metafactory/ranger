import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCmd } from "../src/exec.ts";
import { stageSource } from "../src/remote-test/source.ts";
import { CONTAINER_BOOTSTRAP_FLAGS, containerProgram, executeRemoteTest, podmanLauncher, reconcileRemoteTests, type ExecutorLauncher } from "../src/remote-test/executor.ts";
import { openJobLedger } from "../src/remote-test/job-ledger.ts";
import { createReviewedProfile, MYELIN_REPOSITORY } from "../src/remote-test/profiles.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const id = "6c7e8091-1234-4234-8234-123456789abc";
async function fixture(reviewed = false, recipeChange?: "script" | "test-root") {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-executor-"))); roots.push(root);
 const repo = join(root, "repo"), staging = join(root, "staging"), jobsRoot = join(root, "jobs");
 for (const path of [repo, staging, jobsRoot]) await mkdir(path);
 async function git(args: string[]) { const r = await runCmd("git", args, { cwd: repo }); if (r.code) throw new Error(r.stderr); return r.stdout.trim(); }
 await git(["init", "--template="]); await writeFile(join(repo, "bun.lock"), "reviewed-lock\n");
 if (reviewed) await writeFile(join(repo, "package.json"), JSON.stringify({ name: "@the-metafactory/myelin", scripts: { test: recipeChange === "script" ? "bun run screenshots" : "bun test", typecheck: "bunx tsc --noEmit", lint: "eslint ." } }));
 if (recipeChange === "test-root") await writeFile(join(repo, "new-root.test.ts"), "import {test} from 'bun:test'; test('new',()=>{});\n");
 await git(["add", "."]); await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
 const source = await stageSource({ worktree: repo, stagingRoot: staging, jobId: id });
 const profile = reviewed ? createReviewedProfile({ profileId: "myelin-v1", lockDigest: sha("reviewed-lock\n"), imageDigest: sha("runtime"), reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"], sidecars: [{ kind: "nats", imageReference: `localhost/nats@${sha("nats")}` }] } }) : { version: 1 as const, profileId: "unit-v1", profileDigest: sha("approved profile"), lockDigest: sha("reviewed-lock\n"), imageDigest: sha("runtime"), platform: "linux-arm64" as const, commands: [["bun", "test"], ["bunx", "tsc", "--noEmit"]] as [string, ...string[]][] };
 const job = { ...source.manifest, jobId: id, correlationId: id, repositoryId: reviewed ? MYELIN_REPOSITORY : "github:github.com/the-metafactory/ranger", profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: Date.now() + 600_000, generation: 1 };
 const config = { executorId: "fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] };
 const calls: string[][] = [];
 let exitCode = 0, oom = false, block = false, controllers = ["cpu", "memory", "pids"], cleanupFail = false, started = false, extraMount = false, missingImage = false, malformed = false;
 let output = "";
 const launcher: ExecutorLauncher = async (args, options) => {
  calls.push([...args]); const command = args[1];
  if (command === "info") return { code: 0, stdout: JSON.stringify({ host: { os: "linux", arch: "arm64", cgroupVersion: "v2", cgroupControllers: controllers, security: { rootless: true } } }) };
  if (command === "image") return { code: missingImage ? 1 : 0, stdout: JSON.stringify([{ Digest: args.at(-1)!.split("@")[1], Os: "linux", Architecture: "arm64" }]) };
  if (command === "create") { const index = args.indexOf("--cidfile"), cid = args.includes("--entrypoint=/bin/sh") ? "b".repeat(64) : "a".repeat(64); await writeFile(args[index + 1]!, cid); return { code: 0, stdout: cid }; }
  if (command === "start" && args.at(-1) === "b".repeat(64)) return { code: 0, stdout: "b".repeat(64) };
  if (command === "inspect" && args.at(-1) === "b".repeat(64)) return { code: 0, stdout: JSON.stringify([{ Mounts: [{ Type: "tmpfs", Destination: "/data" }], State: { Status: "running", OOMKilled: false } }]) };
  if (command === "exec") return { code: 0, stdout: "usage_usec 10\n512\noom_kill 0\n" };
  if (command === "start") {
   started = true;
   options.onLog?.(Buffer.from(output));
   if (block) await new Promise<void>((_, reject) => { options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
   return { code: exitCode, logsAvailable: true, stdout: malformed ? "" : JSON.stringify({ status: exitCode ? "test_failed" : "passed", exitCode, resources: { state: "observed", cpuTimeMicros: 123, peakMemoryBytes: 456 }, ...(reviewed ? { coverage: { requiredSkippedTests: 0 } } : {}) }) + "\n" };
  }
  if (command === "inspect") return { code: 0, stdout: JSON.stringify([{ Mounts: [{ Type: "bind", Source: join(jobsRoot, id, "checkout"), Destination: "/work" }, ...(extraMount ? [{ Type: "bind", Source: "/private/credentials", Destination: "/secret" }] : [])], State: { Status: started ? "exited" : "created", ExitCode: exitCode, OOMKilled: oom } }]) };
  if (command === "rm" && cleanupFail) return { code: 1, stdout: "" };
  return { code: 0, stdout: "" };
 };
 return { root, source, job, config, profile, calls, launcher,
  setExit: (code: number, killed = false) => { exitCode = code; oom = killed; },
  block: () => { block = true; }, controllers: (c: string[]) => { controllers = c; }, cleanupFail: () => { cleanupFail = true; },
  extraMount: () => { extraMount = true; },
  missingImage: () => { missingImage = true; }, malformed: () => { malformed = true; },
  log: (text: string) => { output = text; },
  execute: (options = {}) => executeRemoteTest({ job, bundlePath: source.bundlePath, config }, { launcher, uid: 1000, gid: 1000, ...options }),
 };
}
test("executor stores attributed observations and bounded logs before returning passed", async () => {
 const f = await fixture(); f.log("test output is private");
 Object.assign(f.config, { artifacts: { maxLogBytes: 4 } });
 const r = await f.execute();
 expect(r.evidence!.resources).toEqual({ state: "observed", cpuTimeMicros: 123, peakMemoryBytes: 456 });
 expect(JSON.parse(await readFile(join(f.config.jobsRoot, ".artifacts", id, "receipt.json"), "utf8"))).toEqual(r);
 expect(await readFile(join(f.config.jobsRoot, ".artifacts", id, "test.log"), "utf8")).toBe("test");
 expect(r.evidence!.output.truncated).toBe(true);
 const calls = f.calls.length; expect(await f.execute()).toEqual(r); expect(f.calls.length).toBe(calls);
});
test("reviewed Myelin lane pins both images and isolates NATS with disposable data and aggregate budgets", async () => {
 const f = await fixture(true), receipt = await f.execute();
 expect(receipt.status).toBe("passed"); expect(receipt.coverage).toEqual({ requiredSkippedTests: 0 });
 expect(receipt.evidence!.resources).toEqual({ state: "observed", cpuTimeMicros: 133, peakMemoryBytes: 968 });
 const creates = f.calls.filter(c => c[1] === "create"); expect(creates).toHaveLength(2);
 const [nats, tests] = creates as [string[], string[]];
 expect(nats).toContain("--network=none"); expect(tests).toContain(`--network=container:${"b".repeat(64)}`);
 expect(nats).toContain("--cpus=0.25"); expect(tests).toContain("--cpus=1.75");
 expect(nats).toContain("--memory=268435456"); expect(tests).toContain("--memory=1342177280");
 expect(nats).toContain("--tmpfs=/data:rw,nosuid,nodev,size=134217728,mode=1777");
 expect(nats).not.toContain("--mount"); expect(nats.at(-1)).toContain("--jetstream");
 expect(creates.join(" ")).not.toMatch(/--publish|network=host|control-plane|GH_TOKEN|--pull=always/);
 expect(f.calls.filter(c => c[1] === "rm").map(c => c.at(-1))).toEqual(["a".repeat(64), "b".repeat(64)]);
 expect(await stat(join(f.config.jobsRoot, ".executor-lane")).catch(() => null)).toBeNull();
});
test("sidecar death, missing coverage and skipped required tests never pass", async () => {
 for (const failure of ["oom", "stopped", "coverage", "skips"] as const) {
  const f = await fixture(true);
  const launcher: ExecutorLauncher = async (argv, options) => {
   const result = await f.launcher(argv, options);
   if (argv[1] === "inspect" && argv.at(-1) === "b".repeat(64) && f.calls.some(c => c[1] === "start" && c.includes("--attach"))) {
    const inspected = JSON.parse(result.stdout); if (failure === "oom") inspected[0].State.OOMKilled = true;
    if (failure === "stopped") inspected[0].State.Status = "exited";
    return { ...result, stdout: JSON.stringify(inspected) };
   }
   if (argv[1] === "start" && argv.includes("--attach") && ["coverage", "skips"].includes(failure)) {
    const terminal = JSON.parse(result.stdout); if (failure === "coverage") delete terminal.coverage; else terminal.coverage.requiredSkippedTests = 3;
    return { ...result, stdout: JSON.stringify(terminal) };
   }
   return result;
  };
  expect((await f.execute({ launcher })).status).toBe("infra_failed"); expect(f.calls.filter(c => c[1] === "rm")).toHaveLength(2);
 }
});
test("uncertain sidecar creation and sidecar cleanup failure retain the lane", async () => {
 for (const failure of ["create", "cleanup"] as const) {
  const f = await fixture(true);
  const launcher: ExecutorLauncher = async (argv, options) => {
   if (failure === "create" && argv[1] === "create") return { code: 1, stdout: "" };
   if (failure === "cleanup" && argv[1] === "rm" && argv.at(-1) === "b".repeat(64)) return { code: 1, stdout: "" };
   return f.launcher(argv, options);
  };
  expect((await f.execute({ launcher })).status).toBe("infra_failed"); expect(await stat(join(f.config.jobsRoot, ".executor-lane"))).toBeDefined();
 }
});
test("changed repository scripts and uncovered test roots stop before container creation", async () => {
 for (const change of ["script", "test-root"] as const) {
  const f = await fixture(true, change); expect((await f.execute()).status).toBe("rejected");
  expect(f.calls.some(c => c[1] === "create")).toBe(false);
 }
});
test("executor storage failure and invalid clock cannot expose passed", async () => {
 const f = await fixture();
 await expect(f.execute({ artifactFault: () => { throw Error("storage failure"); } })).rejects.toThrow();
 expect(await stat(join(f.config.jobsRoot, ".artifacts", id)).catch(() => null)).toBeNull();
 const ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 try { expect(ledger.status(f.job)?.kind).toBe("interrupted"); expect(() => ledger.admit(f.job)).toThrow("recovery fence"); } finally { ledger.close(); }
 const g = await fixture(); let clock = Date.now();
 await expect(g.execute({ now: () => clock-- })).rejects.toThrow("durationMs");
 expect(await stat(join(g.config.jobsRoot, ".artifacts", id)).catch(() => null)).toBeNull();
});
test("concurrent executor duplicates report active and only one launches; completed duplicates replay after artifact retention", async () => {
 const f = await fixture();
 let release!: () => void;
 const ready = new Promise<void>(resolve => { release = resolve; });
 let atStart!: () => void; const started = new Promise<void>(resolve => { atStart = resolve; });
 const launcher: ExecutorLauncher = async (args, options) => {
  if (args[1] === "start") { atStart(); await ready; }
  return f.launcher(args, options);
 };
 const first = f.execute({ launcher }); await started;
 await expect(f.execute()).rejects.toThrow("active");
 const nextJob = { ...f.job, jobId: "7c7e8091-1234-4234-8234-123456789abc", correlationId: "7c7e8091-1234-4234-8234-123456789abc" };
 await expect(executeRemoteTest({ job: nextJob, bundlePath: f.source.bundlePath, config: f.config }, { launcher: f.launcher, uid: 1000, gid: 1000 })).rejects.toThrow("busy");
 const ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 try { expect(ledger.status(nextJob)).toBeNull(); } finally { ledger.close(); }
 release(); const receipt = await first;
 expect(f.calls.filter(c => c[1] === "create")).toHaveLength(1);
 await rm(join(f.config.jobsRoot, ".artifacts", id), { recursive: true });
 const count = f.calls.length; expect(await f.execute()).toEqual(receipt); expect(f.calls.length).toBe(count);
 const reopened = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 try { expect(reopened.admit(nextJob).kind).toBe("admitted"); } finally { reopened.close(); }
});
test("rowless passed evidence is retained as revoked without execution or a global recovery fence", async () => {
 const f = await fixture(), receipt = await f.execute();
 await rm(join(f.config.jobsRoot, ".execution"), { recursive: true }); // A previous producer left only its private artifact.
 const count = f.calls.length;
 await expect(f.execute()).rejects.toThrow("revoked"); expect(f.calls.length).toBe(count);
 await rm(join(f.config.jobsRoot, ".artifacts", id), { recursive: true });
 await expect(f.execute()).rejects.toThrow("revoked"); expect(f.calls.length).toBe(count);
 const ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 try {
  expect(ledger.status(f.job)).toEqual({ kind: "revoked", receipt });
  expect(ledger.admit({ ...f.job, jobId: "7c7e8091-1234-4234-8234-123456789abc", correlationId: "7c7e8091-1234-4234-8234-123456789abc" }).kind).toBe("admitted");
 } finally { ledger.close(); }
});
test("an interrupted publication never adopts loose passed evidence and terminates after the retry allowance", async () => {
 const f = await fixture(), historical = await f.execute();
 const artifact = join(f.config.jobsRoot, ".artifacts", id, "receipt.json");
 // Model the durable boundary: artifact bytes exist, but the attempt never
 // committed a terminal ledger receipt before process death.
 await rm(join(f.config.jobsRoot, ".execution"), { recursive: true });
 const ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 try {
  ledger.admit(f.job);
  const launcher: ExecutorLauncher = async () => ({ code: 0, stdout: "" });
  await reconcileRemoteTests(f.config, { launcher });
  const count = f.calls.length;
  await expect(f.execute()).rejects.toThrow("receipt already exists");
  expect(ledger.status(f.job)).toEqual({ kind: "interrupted", attempt: 2 });
  expect(() => ledger.admit(f.job)).toThrow("recovery fence");
  await reconcileRemoteTests(f.config, { launcher });
  const final = await f.execute(); expect(final.status).toBe("infra_failed");
  expect(f.calls.length).toBe(count);
  expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual(historical);
 } finally { ledger.close(); }
});
test("durable cancellation before start and during artifact publication never exposes success", async () => {
 for (const duringStorage of [false, true]) {
  const f = await fixture(), ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
  try {
   const launcher: ExecutorLauncher = async (args, options) => {
    const result = await f.launcher(args, options);
    if (!duringStorage && args[1] === "inspect" && !f.calls.some(c => c[1] === "start")) ledger.cancel(f.job);
    return result;
   };
   const receipt = await f.execute({ launcher, artifactFault: (step: string) => { if (duringStorage && step === "publish") ledger.cancel(f.job); } });
   expect(receipt.status).toBe("cancelled");
   if (!duringStorage) expect(f.calls.some(c => c[1] === "start")).toBe(false);
   expect((await f.execute()).status).toBe("cancelled");
  } finally { ledger.close(); }
 }
});
test("recovery adapter removes only labelled ledger containers and safely clears the interrupted workspace", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 const admitted = ledger.admit(f.job); if (admitted.kind !== "admitted") throw Error();
 ledger.launch(f.job, admitted.token);
 const lane = join(f.config.jobsRoot, ".executor-lane"); await mkdir(lane, { mode: 0o700 });
 await writeFile(join(lane, "owner.json"), JSON.stringify({ ledgerId: ledger.id, jobId: id, token: admitted.token }), { mode: 0o600 });
 let present = true; const calls: string[][] = [];
 const launcher: ExecutorLauncher = async argv => {
  calls.push([...argv]);
  if (argv[1] === "ps") return { code: 0, stdout: present ? "b".repeat(64) + "\n" + "a".repeat(64) + "\n" : "" };
  if (argv[1] === "inspect") return { code: 0, stdout: JSON.stringify([{ Id: argv.at(-1), Config: { Labels: { "ranger.remote-test.ledger": ledger.id, "ranger.remote-test.job": id, "ranger.remote-test.attempt": admitted.token, ...(argv.at(-1) === "b".repeat(64) ? { "ranger.remote-test.role": "nats" } : {}) } } }]) };
  if (argv[1] === "rm") { present = false; return { code: 0, stdout: "" }; }
  throw Error("Unexpected command");
 };
 try {
  await reconcileRemoteTests(f.config, { launcher });
  expect(calls.find(c => c[1] === "ps")).toContain(`label=ranger.remote-test.ledger=${ledger.id}`);
  expect(calls.filter(c => c[1] === "rm").map(c => c.at(-1))).toEqual(["a".repeat(64), "b".repeat(64)]);
  expect(await stat(lane).catch(() => null)).toBeNull();
  const receipt = await f.execute(); expect(receipt.status).toBe("passed");
 } finally { ledger.close(); }
});
test("recovery refuses a retained lane without owner metadata and preserves admission fence", async () => {
 const f = await fixture(), ledger = await openJobLedger(f.config.jobsRoot, f.config.executorId);
 try {
  ledger.admit(f.job);
  const lane = join(f.config.jobsRoot, ".executor-lane"); await mkdir(lane, { mode: 0o700 });
  await expect(reconcileRemoteTests(f.config, { launcher: async () => ({ code: 0, stdout: "" }) })).rejects.toThrow();
  expect(await stat(lane)).toBeDefined(); expect(() => ledger.admit(f.job)).toThrow("recovery fence");
 } finally { ledger.close(); }
});
test("failed lane removal persists infra_failed and retains the lane before exposing a terminal result", async () => {
 const f = await fixture();
 const r = await f.execute({ removeLane: async () => { throw Error("filesystem permission failure"); } });
 expect(r.status).toBe("infra_failed"); expect(r.exitCode).toBe(0);
 expect((await stat(join(f.config.jobsRoot, ".executor-lane"))).isDirectory()).toBe(true);
 expect(JSON.parse(await readFile(join(f.config.jobsRoot, ".artifacts", id, "receipt.json"), "utf8")).status).toBe("infra_failed");
});
test("runs only selected operator argv at the exact bundle identity with a bounded isolated launch", async () => {
 const f = await fixture(); const result = await f.execute(); expect(result.status).toBe("passed"); expect(result.exitCode).toBe(0); expect(result.identity.commitDigest).toBe(f.source.manifest.commitDigest);
 const args = f.calls.find(c => c[1] === "create")!;
 for (const flag of ["--cpus=2", "--memory=1610612736", "--memory-swap=1610612736", "--pids-limit=256", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--userns=keep-id", "--http-proxy=false", "--unsetenv-all", "--image-volume=ignore", "--pull=never", "--workdir=/tmp", ...CONTAINER_BOOTSTRAP_FLAGS]) expect(args).toContain(flag);
 expect(args.some(a => a.startsWith("--timeout="))).toBe(true);
 expect(args.filter(a => a === "--mount")).toHaveLength(1); expect(args.join(" ")).not.toMatch(/--privileged|network=host|docker\.sock|state\.sqlite|NATS|GH_TOKEN/);
 expect(args.at(-1)).toContain(JSON.stringify(f.profile.commands));
 expect(f.calls.some(c => c[1] === "rm")).toBe(true);
 expect(await readFile(join(f.root, "jobs", id, "checkout", "bun.lock"), "utf8").catch(() => null)).toBeNull();
});
test("distinguishes nonzero test exits including 125 from OOM", async () => {
 for (const [code, oom, expected] of [[125, false, "test_failed"], [137, true, "infra_failed"]] as const) { const f = await fixture(); f.setExit(code, oom); expect((await f.execute()).status).toBe(expected); }
});
test("refuses expired jobs and unsupported controllers before creating containers", async () => {
 const f = await fixture(); f.job.deadline = Date.now() - 1; expect((await f.execute()).status).toBe("timed_out"); expect(f.calls).toHaveLength(0);
 const g = await fixture(); g.controllers(["cpu", "memory"]); expect((await g.execute()).status).toBe("rejected"); expect(g.calls.some(c => c[1] === "create")).toBe(false);
});
test("rejects profile and bundle identity mismatches without executing source", async () => {
 const f = await fixture(); f.job.profileDigest = sha("unreviewed"); await expect(f.execute()).rejects.toThrow(); expect(f.calls).toHaveLength(0);
 f.job.profileDigest = f.profile.profileDigest; f.job.bundleDigest = sha("wrong bundle"); expect((await f.execute()).status).toBe("rejected"); expect(f.calls.some(c => c[1] === "create")).toBe(false);
 expect(await stat(join(f.config.jobsRoot, id)).catch(() => null)).toBeNull();
});
test("enforces timeout and cancellation by killing the container and removing the workspace", async () => {
 for (const cancel of [false, true]) {
  const f = await fixture(); f.block(); const abort = new AbortController();
  const running = f.execute({ signal: abort.signal, timeoutMs: cancel ? 60_000 : 3000 });
  if (cancel) { while (!f.calls.some(c => c[1] === "start")) await Bun.sleep(5); abort.abort(); }
  expect((await running).status).toBe(cancel ? "cancelled" : "timed_out");
  expect(f.calls.some(c => c[1] === "kill")).toBe(true); expect(f.calls.some(c => c[1] === "rm")).toBe(true);
 }
}, 15_000);
test("refuses engine defaults that mount host credentials before starting tests", async () => {
 const f = await fixture(); f.extraMount(); expect((await f.execute()).status).toBe("infra_failed"); expect(f.calls.some(c => c[1] === "start")).toBe(false); expect(f.calls.some(c => c[1] === "rm")).toBe(true);
});
test("refuses missing pinned image or mismatched committed lock bytes before launch", async () => {
 const f = await fixture(); f.missingImage(); expect((await f.execute()).status).toBe("rejected"); expect(f.calls.some(c => c[1] === "create")).toBe(false);
 const g = await fixture(); g.profile.lockDigest = sha("different lock"); g.job.lockDigest = g.profile.lockDigest; expect((await g.execute()).status).toBe("rejected"); expect(g.calls.some(c => c[1] === "create")).toBe(false);
});
test("never promotes an engine exit zero without a complete terminal result", async () => {
 const f = await fixture(); f.malformed(); expect((await f.execute()).status).toBe("infra_failed"); expect(f.calls.some(c => c[1] === "rm")).toBe(true);
});
test("CLI writes a private rejected receipt and refuses an existing output before engine access", async () => {
 const f = await fixture(); const bin = join(f.root, "bin"); await mkdir(bin);
 const marker = join(f.root, "engine-access");
 const engine = join(bin, "podman");
 await writeFile(engine, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)}, "accessed");\nif (process.argv[3] === "info") console.log(JSON.stringify({host:{os:"linux",arch:"arm64",cgroupVersion:"v2",cgroupControllers:["cpu","memory","pids"],security:{rootless:true}}})); else process.exit(1);\n`);
 await chmod(engine, 0o700);
 const config = join(f.root, "config.json"), job = join(f.root, "job.json"), output = join(f.root, "receipt.json");
 await writeFile(config, JSON.stringify(f.config), { mode: 0o600 }); await writeFile(job, JSON.stringify(f.job));
 const invoke = () => runCmd(process.execPath, ["src/cli.ts", "remote-test", "execute", "--config", config, "--job", job, "--bundle", f.source.bundlePath, "--output", output], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
 const result = await invoke(); expect(result.code).toBe(1); expect(result.stdout).toContain("Remote-test rejected");
 expect(JSON.parse(await readFile(output, "utf8")).identity).toEqual(f.job); expect((await stat(output)).mode & 0o777).toBe(0o600);
 await rm(marker); const again = await invoke(); expect(again.code).toBe(1); expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
 await rm(output); await writeFile(job, JSON.stringify({ ...f.job, profileId: "unapproved" }));
 expect((await invoke()).code).toBe(1); expect(await readFile(output, "utf8").catch(() => null)).toBeNull();
});
test("CLI export failure identifies the stored durable receipt and preserves existing output", async () => {
 const f = await fixture(); const bin = join(f.root, "bin"); await mkdir(bin);
 const output = join(f.root, "output.json"), engine = join(bin, "podman");
 // Simulate a destination appearing after the pre-execution absence check.
 await writeFile(engine, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(output)}, "existing-output");\nif (process.argv[3] === "info") console.log(JSON.stringify({host:{os:"linux",arch:"arm64",cgroupVersion:"v2",cgroupControllers:["cpu","memory","pids"],security:{rootless:true}}})); else process.exit(1);\n`, { mode: 0o700 });
 const config = join(f.root, "config.json"), job = join(f.root, "job.json");
 await writeFile(config, JSON.stringify(f.config), { mode: 0o600 }); await writeFile(job, JSON.stringify(f.job));
 const r = await runCmd(process.execPath, ["src/cli.ts", "remote-test", "execute", "--config", config, "--job", job, "--bundle", f.source.bundlePath, "--output", output], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
 expect(r.code).toBe(1); expect(r.stderr).toContain("durable receipt stored; output export failed"); expect(r.stdout).toBe("");
 expect(await readFile(output, "utf8")).toBe("existing-output");
 expect(JSON.parse(await readFile(join(f.config.jobsRoot, ".artifacts", id, "receipt.json"), "utf8")).identity).toEqual(f.job);
 expect(await stat(`${output}.reservation`).catch(() => null)).toBeNull();
});

test("Bun bootstrap checks controller files before executing profiles and detects child OOM", async () => {
 const root = await mkdtemp(join(tmpdir(), "ranger-bootstrap-")); roots.push(root);
 const marker = join(root, "executed"), cgroup = join(root, "cgroup"); await mkdir(cgroup);
 const valid: Record<string, string> = { "cpu.max": "200000 100000", "memory.max": "1610612736", "memory.swap.max": "0", "pids.max": "256", "memory.events": "oom_kill 0", "cpu.stat": "usage_usec 100", "memory.peak": "4096" };
 const commands: [string, ...string[]][] = [[process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`]];
 const run = async (fields: Record<string, string>, argv = commands) => {
  await rm(marker, { force: true }); for (const [name, content] of Object.entries({ ...valid, ...fields })) await writeFile(join(cgroup, name), content);
  // Only controller location and cwd differ from the real container program.
  const program = containerProgram(argv).replaceAll('"/sys/fs/cgroup/', JSON.stringify(cgroup).slice(0, -1) + "/").replace('cwd:"/work"', `cwd:${JSON.stringify(root)}`);
  const result = await runCmd(process.execPath, [...CONTAINER_BOOTSTRAP_FLAGS, "-e", program]);
  return { terminal: JSON.parse(result.stdout), stderr: result.stderr };
 };
 expect((await run({})).terminal).toMatchObject({ status: "passed", exitCode: 0 }); expect(await readFile(marker, "utf8")).toBe("ran");
 const invalidControls: Record<string, string>[] = [{ "cpu.max": "max 100000" }, { "memory.max": "max" }, { "memory.swap.max": "1024" }, { "pids.max": "max" }];
 for (const invalid of invalidControls) {
  expect((await run(invalid)).terminal.status).toBe("infra_failed"); expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
 }
 expect((await run({ "memory.events": "oom_kill 1" })).terminal.status).toBe("infra_failed");
 expect((await run({}, [...commands, ["/missing-runtime"]])).terminal.status).toBe("infra_failed");
 const logged = await run({}, [[process.execPath, "-e", 'console.log("stdout-canary"); console.error("stderr-canary")']]);
 expect(logged.terminal.resources).toEqual({ state: "observed", cpuTimeMicros: 100, peakMemoryBytes: 4096 });
 expect(logged.stderr).toContain("stdout-canary"); expect(logged.stderr).toContain("stderr-canary");
});
test("neutral bootstrap does not load job Bun preloads or .env before controller checks", async () => {
 const root = await mkdtemp(join(tmpdir(), "ranger-bun-config-")); roots.push(root);
 const source = join(root, "source"), neutral = join(root, "neutral"); await mkdir(source); await mkdir(neutral);
 const marker = join(root, "preloaded");
 await writeFile(join(source, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
 await writeFile(join(source, "preload.ts"), `await Bun.write(${JSON.stringify(marker)}, "preloaded")`);
 await writeFile(join(source, ".env"), "RANGER_WRAPPER_CANARY=job-controlled\n");
 const probe = 'console.log(process.env.RANGER_WRAPPER_CANARY ?? "unset")';
 const unsafe = await runCmd(process.execPath, ["-e", probe], { cwd: source });
 expect(unsafe.stdout.trim()).toBe("job-controlled");
 await rm(marker, { force: true });
 const safe = await runCmd(process.execPath, [...CONTAINER_BOOTSTRAP_FLAGS, "-e", probe], { cwd: neutral });
 expect(safe.stdout.trim()).toBe("unset"); expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
 // The cgroup failure still precedes any profile or job preload.
 const wrapper = await runCmd(process.execPath, [...CONTAINER_BOOTSTRAP_FLAGS, "-e", containerProgram([[process.execPath, "-e", "process.exit(0)"]]).replace('"/sys/fs/cgroup/"', JSON.stringify(join(root, "missing") + "/"))], { cwd: neutral });
 expect(JSON.parse(wrapper.stdout).status).toBe("infra_failed"); expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
});
test("reviewed bootstrap copies private dependencies, performs frozen offline install and reports required skips", async () => {
 const root = await mkdtemp(join(tmpdir(), "ranger-reviewed-bootstrap-")); roots.push(root);
 const checkout = join(root, "checkout"), image = join(root, "image"), cgroup = join(root, "cgroup"), neutral = join(root, "neutral");
 for (const dir of [checkout, image, cgroup, neutral]) await mkdir(dir);
 await mkdir(join(checkout, "vendor"));
 await writeFile(join(checkout, "vendor", "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }));
 await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { "fixture-dependency": "file:./vendor" } }));
 const install = await runCmd(process.execPath, ["install", "--ignore-scripts"], { cwd: checkout }); expect(install.code).toBe(0);
 const lock = await readFile(join(checkout, "bun.lock")); await writeFile(join(image, "bun.lock"), lock);
 await mkdir(join(image, "node_modules")); await writeFile(join(image, "node_modules", "canary"), "immutable");
 await rm(join(checkout, "node_modules"), { recursive: true, force: true });
 const files = { "cpu.max": "175000 100000", "memory.max": "1342177280", "memory.swap.max": "0", "pids.max": "224", "memory.events": "oom_kill 0", "cpu.stat": "usage_usec 100", "memory.peak": "4096" };
 for (const [file, bytes] of Object.entries(files)) await writeFile(join(cgroup, file), bytes);
 const broker = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.write("PONG\r\n"); } } });
 try {
  const reviewed = createReviewedProfile({ profileId: "fixture", imageDigest: sha("runtime"), lockDigest: sha(lock.toString()), reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"], sidecars: [{ kind: "nats", imageReference: `localhost/nats@${sha("nats")}` }] } });
  const argv: [string, ...string[]][] = [reviewed.commands[0]!, [process.execPath, "--no-env-file", "test", "./fixture.test.ts"]];
  await writeFile(join(checkout, ".env"), "NATS_URL=nats://control-plane.invalid:4222\n");
  const run = async (skip: boolean) => {
   await rm(join(checkout, "node_modules"), { recursive: true, force: true });
   await writeFile(join(checkout, "fixture.test.ts"), `import {expect,test} from 'bun:test'; test('required',()=>{expect(process.env.NATS_URL).toBe('nats://127.0.0.1:${broker.port}');}); ${skip ? "test.skip('missing required',()=>{});" : ""}`);
   const program = containerProgram(argv, reviewed.reviewed, reviewed.lockDigest)
    .replaceAll('"/sys/fs/cgroup/', JSON.stringify(cgroup).slice(0, -1) + "/")
    .replaceAll("/opt/ranger-dependencies", image).replaceAll("/work", checkout)
    .replaceAll("port:4222", `port:${broker.port}`).replaceAll(":4222", `:${broker.port}`);
   const r = await runCmd(process.execPath, [...CONTAINER_BOOTSTRAP_FLAGS, "-e", program], { cwd: neutral });
   return JSON.parse(r.stdout);
  };
  expect(await run(false)).toMatchObject({ status: "passed", coverage: { requiredSkippedTests: 0 } });
  await writeFile(join(checkout, "node_modules", "canary"), "job-only");
  expect(await readFile(join(image, "node_modules", "canary"), "utf8")).toBe("immutable");
  expect(await run(true)).toMatchObject({ status: "infra_failed", coverage: { requiredSkippedTests: 1 } });
  expect(await readFile(join(checkout, "bun.lock"))).toEqual(lock);
 } finally { broker.stop(true); }
});
test("deadline rounding never disables the independent conmon timeout", async () => {
 const f = await fixture(); const base = Date.now(); f.job.deadline = base + 600_000;
 let staged = false;
 const launcher: ExecutorLauncher = async (argv, options) => {
  const result = await f.launcher(argv, options); if (argv[1] === "image") staged = true; return result;
 };
 await f.execute({ launcher, now: () => staged ? base + 599_000 : base });
 const create = f.calls.find(c => c[1] === "create")!; expect(create).toBeDefined();
 expect(Number(create.find(a => a.startsWith("--timeout="))!.split("=")[1])).toBeGreaterThan(0);
});
test("does not overwrite an occupied lane or falsely pass failed teardown", async () => {
 const f = await fixture(); await mkdir(join(f.config.jobsRoot, ".executor-lane")); await expect(f.execute()).rejects.toThrow("interrupted"); expect(f.calls).toHaveLength(0);
 const g = await fixture(); g.cleanupFail(); expect((await g.execute()).status).toBe("infra_failed");
 expect(await readFile(join(g.root, "jobs", id, "checkout", "bun.lock"), "utf8")).toBe("reviewed-lock\n");
 expect(await stat(join(g.config.jobsRoot, ".executor-lane"))).toBeDefined();
 expect((await g.execute()).status).toBe("infra_failed");
 const calls = g.calls.length;
 const nextJob = { ...g.job, jobId: "7c7e8091-1234-4234-8234-123456789abc", generation: 2 };
 await expect(executeRemoteTest({ job: nextJob, bundlePath: g.source.bundlePath, config: g.config }, { launcher: g.launcher, uid: 1000, gid: 1000 })).rejects.toThrow("interrupted");
 expect(g.calls.length).toBe(calls);
});
test("Podman launcher drains attached stderr separately from terminal stdout", async () => {
 const root = await mkdtemp(join(tmpdir(), "ranger-podman-log-")); roots.push(root);
 const engine = join(root, "podman");
 await writeFile(engine, `#!/bin/sh\nprintf '%s\\n' '{"status":"passed","exitCode":0}'\nprintf '%s' 'attached-private-log' >&2\n`, { mode: 0o700 });
 const priorPath = process.env.PATH; process.env.PATH = `${root}:${priorPath}`;
 try {
  const chunks: Buffer[] = [];
  const result = await podmanLauncher(["--remote=false", "start", "--attach", "fixture"], { signal: new AbortController().signal, timeoutMs: 1000, onLog: chunk => chunks.push(Buffer.from(chunk)) });
  expect(result.logsAvailable).toBe(true); expect(JSON.parse(result.stdout)).toEqual({ status: "passed", exitCode: 0 });
  expect(Buffer.concat(chunks).toString()).toBe("attached-private-log");
 } finally { process.env.PATH = priorPath; }
});

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCmd } from "../src/exec.ts";
import { stageSource } from "../src/remote-test/source.ts";
import { CONTAINER_BOOTSTRAP_FLAGS, containerProgram, executeRemoteTest, type ExecutorLauncher } from "../src/remote-test/executor.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const id = "6c7e8091-1234-4234-8234-123456789abc";
async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-executor-"))); roots.push(root);
 const repo = join(root, "repo"), staging = join(root, "staging"), jobsRoot = join(root, "jobs");
 for (const path of [repo, staging, jobsRoot]) await mkdir(path);
 async function git(args: string[]) { const r = await runCmd("git", args, { cwd: repo }); if (r.code) throw new Error(r.stderr); return r.stdout.trim(); }
 await git(["init", "--template="]); await writeFile(join(repo, "bun.lock"), "reviewed-lock\n");
 await git(["add", "."]); await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
 const source = await stageSource({ worktree: repo, stagingRoot: staging, jobId: id });
 const profile = { version: 1 as const, profileId: "unit-v1", profileDigest: sha("approved profile"), lockDigest: sha("reviewed-lock\n"), imageDigest: sha("runtime"), platform: "linux-arm64" as const, commands: [["bun", "test"], ["bunx", "tsc", "--noEmit"]] as [string, ...string[]][] };
 const job = { ...source.manifest, jobId: id, correlationId: id, repositoryId: "github:github.com/the-metafactory/ranger", profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest, platform: profile.platform, deadline: Date.now() + 600_000, generation: 1 };
 const config = { executorId: "fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] };
 const calls: string[][] = [];
 let exitCode = 0, oom = false, block = false, controllers = ["cpu", "memory", "pids"], cleanupFail = false, started = false, extraMount = false, missingImage = false, malformed = false;
 let output = "";
 const launcher: ExecutorLauncher = async (args, options) => {
  calls.push([...args]); const command = args[1];
  if (command === "info") return { code: 0, stdout: JSON.stringify({ host: { os: "linux", arch: "arm64", cgroupVersion: "v2", cgroupControllers: controllers, security: { rootless: true } } }) };
  if (command === "image") return { code: missingImage ? 1 : 0, stdout: JSON.stringify([{ Digest: profile.imageDigest, Os: "linux", Architecture: "arm64" }]) };
  if (command === "create") { const index = args.indexOf("--cidfile"); await writeFile(args[index + 1]!, "a".repeat(64)); return { code: 0, stdout: "a".repeat(64) }; }
  if (command === "start") {
   started = true;
   options.onLog?.(Buffer.from(output));
   if (block) await new Promise<void>((_, reject) => { options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
   return { code: exitCode, logsAvailable: true, stdout: malformed ? "" : JSON.stringify({ status: exitCode ? "test_failed" : "passed", exitCode, resources: { state: "observed", cpuTimeMicros: 123, peakMemoryBytes: 456 } }) + "\n" };
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
 const calls = f.calls.length; await expect(f.execute()).rejects.toThrow("already exists"); expect(f.calls.length).toBe(calls);
});
test("executor storage failure and invalid clock cannot expose passed", async () => {
 const f = await fixture();
 await expect(f.execute({ artifactFault: () => { throw Error("storage failure"); } })).rejects.toThrow();
 expect(await stat(join(f.config.jobsRoot, ".artifacts", id)).catch(() => null)).toBeNull();
 const g = await fixture(); let clock = Date.now();
 await expect(g.execute({ now: () => clock-- })).rejects.toThrow();
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
 const f = await fixture(); f.job.deadline = Date.now() - 1; expect((await f.execute()).status).toBe("rejected"); expect(f.calls).toHaveLength(0);
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

test("Bun bootstrap checks controller files before executing profiles and detects child OOM", async () => {
 const root = await mkdtemp(join(tmpdir(), "ranger-bootstrap-")); roots.push(root);
 const marker = join(root, "executed"), cgroup = join(root, "cgroup"); await mkdir(cgroup);
 const valid: Record<string, string> = { "cpu.max": "200000 100000", "memory.max": "1610612736", "memory.swap.max": "0", "pids.max": "256", "memory.events": "oom_kill 0", "cpu.stat": "usage_usec 100", "memory.peak": "4096" };
 const commands: [string, ...string[]][] = [[process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "ran")`]];
 const run = async (fields: Record<string, string>, argv = commands) => {
  await rm(marker, { force: true }); for (const [name, content] of Object.entries({ ...valid, ...fields })) await writeFile(join(cgroup, name), content);
  // Only controller location and cwd differ from the real container program.
  const program = containerProgram(argv).replace('"/sys/fs/cgroup/"', JSON.stringify(cgroup + "/")).replaceAll('"/sys/fs/cgroup/', JSON.stringify(cgroup).slice(0, -1) + "/").replace('cwd:"/work"', `cwd:${JSON.stringify(root)}`);
  const result = await runCmd(process.execPath, [...CONTAINER_BOOTSTRAP_FLAGS, "-e", program]);
  const terminal = JSON.parse(result.stdout);
  if (argv[0]?.[2]?.includes("stdout-canary")) { expect(result.stderr).toContain("stdout-canary"); expect(result.stderr).toContain("stderr-canary"); }
  return terminal;
 };
 expect(await run({})).toMatchObject({ status: "passed", exitCode: 0 }); expect(await readFile(marker, "utf8")).toBe("ran");
 const invalidControls: Record<string, string>[] = [{ "cpu.max": "max 100000" }, { "memory.max": "max" }, { "memory.swap.max": "1024" }, { "pids.max": "max" }];
 for (const invalid of invalidControls) {
  expect((await run(invalid)).status).toBe("infra_failed"); expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
 }
 expect((await run({ "memory.events": "oom_kill 1" })).status).toBe("infra_failed");
 expect((await run({}, [...commands, ["/missing-runtime"]])).status).toBe("infra_failed");
 const logged = await run({}, [[process.execPath, "-e", 'console.log("stdout-canary"); console.error("stderr-canary")']]);
 expect(logged.resources).toEqual({ state: "observed", cpuTimeMicros: 100, peakMemoryBytes: 4096 });
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
test("deadline rounding never disables the independent conmon timeout", async () => {
 const f = await fixture(); const base = Date.now(); f.job.deadline = base + 600_000;
 let staged = false, ticks = 0;
 const launcher: ExecutorLauncher = async (argv, options) => {
  const result = await f.launcher(argv, options); if (argv[1] === "image") staged = true; return result;
 };
 await f.execute({ launcher, now: () => staged ? base + 599_000 + ticks++ : base });
 const create = f.calls.find(c => c[1] === "create")!; expect(create).toBeDefined();
 expect(Number(create.find(a => a.startsWith("--timeout="))!.split("=")[1])).toBeGreaterThan(0);
});
test("does not overwrite an occupied lane or falsely pass failed teardown", async () => {
 const f = await fixture(); await mkdir(join(f.config.jobsRoot, ".executor-lane")); expect((await f.execute()).status).toBe("rejected"); expect(f.calls).toHaveLength(0);
 const g = await fixture(); g.cleanupFail(); expect((await g.execute()).status).toBe("infra_failed");
 expect(await readFile(join(g.root, "jobs", id, "checkout", "bun.lock"), "utf8")).toBe("reviewed-lock\n");
 expect(await stat(join(g.config.jobsRoot, ".executor-lane"))).toBeDefined();
 await expect(g.execute()).rejects.toThrow("already exists");
});

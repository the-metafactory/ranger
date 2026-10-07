import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { killProcessGroup } from "../exec.ts";
import { ResourceObservationSchema, validateProfileManifest, validateRemoteTestJob, validateRemoteTestReceipt, type RemoteTestReceipt, type ResourceObservation } from "./contract.ts";
import { ArtifactPolicySchema, persistExecution, readExecutionReceipt, type ArtifactOptions } from "./artifacts.ts";
import { restoreSource } from "./source.ts";
import { ActiveRemoteTestJob, BusyRemoteTestExecutor, InterruptedRemoteTestJob, RevokedRemoteTestJob, openJobLedger, type JobLedger, type OwnedContainer } from "./job-ledger.ts";
import { REMOTE_TEST_LIMITS, profileBudgets, type ReviewedPolicy, type ContainerBudget } from "./profiles.ts";

export const EXECUTOR_LIMITS = REMOTE_TEST_LIMITS;
export const CONTAINER_BOOTSTRAP_FLAGS = ["--config=/dev/null", "--no-env-file"] as const;
const ConfigSchema = z.object({
 executorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
 jobsRoot: z.string().refine(s => isAbsolute(s) && !/[\0,:\n]/.test(s) && !s.split("/").includes("..")),
 artifacts: ArtifactPolicySchema.default({}),
 profiles: z.array(z.object({
  profile: z.unknown().transform(validateProfileManifest),
  lockFile: z.string().regex(/^[a-zA-Z0-9_.-]+$/).refine(s => s !== "." && s !== ".."),
  imageReference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
 }).strict().refine(p => p.imageReference.endsWith(`@${p.profile.imageDigest}`) && (!p.profile.reviewed || p.lockFile === "bun.lock"))).min(1).max(32),
}).strict().refine(c => new Set(c.profiles.map(p => p.profile.profileId)).size === c.profiles.length);
export type ExecutorConfig = z.infer<typeof ConfigSchema>;
export function validateExecutorConfig(input: unknown): ExecutorConfig { return ConfigSchema.parse(input); }
export interface LaunchResult { code: number; stdout: string; logsAvailable?: boolean }
/** argv is Podman's argument vector. No shell, arbitrary engine flags or job env. */
export type ExecutorLauncher = (argv: readonly string[], options: { signal: AbortSignal; timeoutMs: number; onLog?: (chunk: Uint8Array) => void }) => Promise<LaunchResult>;

/** Bound all engine subprocesses and their output; never inherit source, bus or
 * forge credentials. Podman uses the operator's reviewed rootless engine config. */
export const podmanLauncher: ExecutorLauncher = (argv, options) => new Promise((resolve, reject) => {
 const env: NodeJS.ProcessEnv = {};
 for (const key of ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[key]) env[key] = process.env[key];
 const child = spawn("podman", [...argv], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
 let stdout = "", failed = false;
 const stop = () => { failed = true; if (child.pid) killProcessGroup(child.pid); };
 child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 65_536) stop(); });
 // Drain even after the retained log fills; bounded capture must not block tests.
 child.stderr.on("data", chunk => options.onLog?.(chunk));
 const timer = setTimeout(stop, options.timeoutMs);
 options.signal.addEventListener("abort", stop, { once: true });
 if (options.signal.aborted) stop();
 const finish = () => { clearTimeout(timer); options.signal.removeEventListener("abort", stop); };
 child.on("error", () => { finish(); reject(new Error("Container engine launch failed")); });
 child.on("close", code => { finish(); if (failed) reject(new Error("Container engine command interrupted")); else resolve({ code: code ?? -1, stdout, logsAvailable: true }); });
});

/** Only this wrapper writes stdout. Child output is drained onto stderr for
 * bounded private host capture. Check actual
 * cgroup files before the first reviewed command, not just requested flags. */
export function containerProgram(commands: [string, ...string[]][], reviewed?: ReviewedPolicy, lockDigest?: string): string {
 const budget = profileBudgets(reviewed).test;
 return `const fs = await import("node:fs/promises");
let result = {status:"infra_failed",exitCode:null};
let ran = false;
${reviewed ? 'let skipped = 0; result.coverage = {requiredSkippedTests:null};' : ''}
try {
 const value = async name => (await fs.readFile("/sys/fs/cgroup/"+name,"utf8")).trim();
 const cpu = (await value("cpu.max")).split(/\\s+/).map(Number);
 if (process.getuid() === 0 || cpu.length !== 2 || !cpu.every(Number.isFinite) || cpu[0] <= 0 || cpu[1] <= 0 || cpu[0]/cpu[1] > ${budget.cpuCores} ||
     await value("memory.max") !== "${budget.memoryBytes}" || await value("memory.swap.max") !== "0" || await value("pids.max") !== "${budget.pids}") throw Error("Required controller enforcement unavailable");
 ${reviewed ? reviewedBootstrap(lockDigest!) : ''}
 for (const argv of ${JSON.stringify(commands)}) {
  let summary = "";
  const collectSummary = ${!!reviewed} && argv.includes("test");
  const child = Bun.spawn(argv,{cwd:"/work",stdin:"ignore",stdout:"pipe",stderr:"pipe"${reviewed ? ',env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/tmp",NATS_URL:"nats://127.0.0.1:4222"}' : ''}});
  ran = true;
  const drain = async stream => { for await (const chunk of stream) { if (collectSummary) summary = (summary + Buffer.from(chunk).toString()).slice(-65536); if (!process.stderr.write(chunk)) await new Promise(resolve => process.stderr.once("drain",resolve)); } };
  const [code] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]);
  result = {status:code === 0 ? "passed" : "test_failed",exitCode:code};
  ${reviewed ? `result.coverage = {requiredSkippedTests:skipped};
  if (argv.includes("test")) {
   const clean = summary.replace(/\\x1b\\[[0-9;]*m/g, "");
   const passed = [...clean.matchAll(/^\\s*(\\d+) pass$/gm)].at(-1), failed = [...clean.matchAll(/^\\s*(\\d+) fail$/gm)].at(-1);
   if (!passed || !failed || Number(passed[1]) + Number(failed[1]) < 1) {
    result.coverage.requiredSkippedTests = null;
    if (code === 0) throw Error("Required test summary missing or empty");
   } else {
    skipped += [...clean.matchAll(/^\\s*(\\d+) (?:skip|todo)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0);
    result.coverage.requiredSkippedTests = skipped;
    if (skipped > 0) { if (code === 0) result.status = "infra_failed"; break; }
   }
  }` : ''}
  if (code !== 0) break;
 }
 if (/^oom_kill\\s+[1-9][0-9]*$/m.test(await value("memory.events"))) result.status = "infra_failed";
} catch { result.status = "infra_failed"; }
result.resources = {state:ran ? "unavailable" : "skipped",cpuTimeMicros:null,peakMemoryBytes:null};
if (ran) try {
 const cpu = (await fs.readFile("/sys/fs/cgroup/cpu.stat","utf8")).match(/^usage_usec\\s+(\\d+)$/m);
 const peak = Number((await fs.readFile("/sys/fs/cgroup/memory.peak","utf8")).trim());
 const micros = cpu ? Number(cpu[1]) : NaN;
 if (Number.isSafeInteger(micros) && micros >= 0 && Number.isSafeInteger(peak) && peak >= 0) result.resources = {state:"observed",cpuTimeMicros:micros,peakMemoryBytes:peak};
} catch {}
console.log(JSON.stringify(result));
process.exit(result.exitCode ?? 125);`;
}

/** No network, shared package cache, hooks or source-provided install commands.
 * The image's self-contained dependency snapshot is copied, never mounted RW. */
function reviewedBootstrap(lockDigest: string): string {
 return `if (Bun.version !== "1.3.14") throw Error("Reviewed recipe requires Bun 1.3.14");
 const crypto = await import("node:crypto");
 const digest = "sha256:"+crypto.createHash("sha256").update(await fs.readFile("/opt/ranger-dependencies/bun.lock")).digest("hex");
 if (digest !== ${JSON.stringify(lockDigest)}) throw Error("Image dependencies do not match lock");
 try { await fs.lstat("/work/node_modules"); throw Error("Source contains node_modules"); } catch (e) { if (e.code !== "ENOENT") throw e; }
 await fs.cp("/opt/ranger-dependencies/node_modules","/work/node_modules",{recursive:true,dereference:true,force:false,errorOnExist:true});
 let ready = false;
 for (let attempt = 0; attempt < 50 && !ready; attempt++) {
  ready = await new Promise(resolve => {
   let connection, received = "";
   const timer = setTimeout(() => { connection?.terminate(); resolve(false); }, 200);
   Bun.connect({hostname:"127.0.0.1",port:4222,socket:{
    open(socket){connection=socket;socket.write("CONNECT {}\\r\\nPING\\r\\n");},
    data(socket,data){received=(received+Buffer.from(data).toString()).slice(-4096);if(received.includes("PONG\\r\\n")){clearTimeout(timer);socket.end();resolve(true);}},
    error(){clearTimeout(timer);resolve(false);},close(){clearTimeout(timer);resolve(received.includes("PONG\\r\\n"));}
   }}).catch(() => {clearTimeout(timer);resolve(false);});
  });
  if (!ready) await Bun.sleep(100);
 }
 if (!ready) throw Error("Job-private NATS not ready");`;
}

function isolatedContainerFlags(budget: ContainerBudget, seconds: number, uid: number, gid: number): string[] {
 return ["--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--cgroups=enabled",
  `--cpus=${budget.cpuCores}`, `--memory=${budget.memoryBytes}`, `--memory-swap=${budget.memoryBytes}`, `--pids-limit=${budget.pids}`,
  `--timeout=${seconds}`, "--stop-timeout=0", "--restart=no", "--read-only", "--read-only-tmpfs=false",
  "--tmpfs=/tmp:rw,nosuid,nodev,size=67108864,mode=1777", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--userns=keep-id", `--user=${uid}:${gid}`, "--http-proxy=false", "--unsetenv-all", "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=HOME=/tmp",
  "--image-volume=ignore", "--no-healthcheck", "--systemd=false", "--log-driver=none", "--workdir=/tmp"];
}

/** Fixed shell text: no profile/job interpolation except validated numeric budgets. */
function natsProgram(budget: ContainerBudget): string {
 return `test "$(id -u)" != 0
set -- $(cat /sys/fs/cgroup/cpu.max)
test "$1" -gt 0; test "$2" -gt 0; test "$1" -le $(( $2 / 4 ))
test "$(cat /sys/fs/cgroup/memory.max)" = ${budget.memoryBytes}
test "$(cat /sys/fs/cgroup/memory.swap.max)" = 0
test "$(cat /sys/fs/cgroup/pids.max)" = ${budget.pids}
exec /nats-server --jetstream --store_dir=/data --addr=127.0.0.1 --port=4222`;
}

/** Absence of optional peak telemetry is established by successful enumeration.
 * A listed but unreadable/malformed peak, or failed mandatory reads, still fails. */
export function sidecarMetricsProgram(): string {
 return `set -e
interfaces=$(ls -1 /sys/fs/cgroup)
cat /sys/fs/cgroup/cpu.stat
if printf '%s\\n' "$interfaces" | grep -Fx memory.peak >/dev/null; then
 peak=$(cat /sys/fs/cgroup/memory.peak)
 case "$peak" in ''|*[!0-9]*) exit 1;; esac
 printf 'ranger_peak %s\\n' "$peak"
else
 printf 'ranger_peak unavailable\\n'
fi
cat /sys/fs/cgroup/memory.events`;
}

/** One operator-exclusive jobs root is one lane. Configuration is trusted and
 * reviewed, never supplied by the job; profile digest authentication belongs
 * to that admission layer. Source and lock bytes are verified here. */
type ExecutionInput = { job: unknown; bundlePath: string; config: unknown };
type ExecutionOptions = { launcher?: ExecutorLauncher; signal?: AbortSignal; timeoutMs?: number; now?: () => number; uid?: number; gid?: number; artifactFault?: ArtifactOptions["fault"]; removeLane?: (path: string) => Promise<void> };
export async function executeRemoteTest(input: ExecutionInput, options: ExecutionOptions = {}): Promise<RemoteTestReceipt> {
 const config = validateExecutorConfig(input.config);
 const selected = config.profiles.find(p => p.profile.profileId === (input.job as { profileId?: unknown } | null)?.profileId);
 if (!selected) throw Error("Job profile is not operator-approved");
 const job = validateRemoteTestJob(input.job, selected.profile);
 const ledger = await openJobLedger(config.jobsRoot, config.executorId, options.now);
 let cancellationFailed = false;
 const cancel = () => { try { ledger.cancel(job); } catch { cancellationFailed = true; } };
 try {
  if (options.signal?.aborted) cancel();
  const legacy = !ledger.recorded(job) ? await readExecutionReceipt(config.jobsRoot, job, config.executorId) : null;
  const admitted = legacy ? ledger.adoptLegacy(job, legacy) : ledger.admit(job);
  if (admitted.kind === "terminal") return admitted.receipt;
  if (admitted.kind === "revoked") throw new RevokedRemoteTestJob(admitted.receipt);
  if (admitted.kind === "busy") throw new BusyRemoteTestExecutor();
  if (admitted.kind === "active") throw new ActiveRemoteTestJob(admitted);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
   const receipt = await executeAdmittedRemoteTest({ ...input, job, config }, options, ledger, admitted.token);
   if (cancellationFailed) ledger.cancel(job); // Retry persistence after teardown; failure remains uncertain.
   return ledger.complete(job, admitted.token, receipt);
  } catch (error) { ledger.interrupt(job, admitted.token); throw error; }
 } finally { options.signal?.removeEventListener("abort", cancel); ledger.close(); }
}

async function executeAdmittedRemoteTest(
 input: ExecutionInput,
 options: ExecutionOptions,
 ledger: JobLedger, token: string,
): Promise<RemoteTestReceipt> {
 const config = validateExecutorConfig(input.config);
 const profileId = (input.job as { profileId?: unknown } | null)?.profileId;
 const selected = config.profiles.find(p => p.profile.profileId === profileId);
 if (!selected) throw new Error("Job profile is not operator-approved");
 const job = validateRemoteTestJob(input.job, selected.profile);
 // Legacy artifacts and an interrupted publication cannot be overwritten.
 try { await lstat(join(config.jobsRoot, ".artifacts", job.jobId)); throw Error("Execution receipt already exists"); }
 catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
 const now = options.now ?? Date.now;
 const executionStartedAt = now();
 const timeoutMs = options.timeoutMs ?? EXECUTOR_LIMITS.timeoutMs;
 if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > EXECUTOR_LIMITS.timeoutMs) throw new Error("Invalid executor wall-clock limit");
 const uid = options.uid ?? process.getuid?.(), gid = options.gid ?? process.getgid?.();
 let status: RemoteTestReceipt["status"] = "rejected", exitCode: number | null = null;
 let resources: ResourceObservation = { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null };
 let coverage = selected.profile.reviewed ? { requiredSkippedTests: null as number | null } : undefined;
 const budgets = profileBudgets(selected.profile.reviewed);
 let outputState: "captured" | "unavailable" | "skipped" = "skipped", truncated = false, logBytes = 0;
 const logs: Buffer[] = [];
 const captureLog = (chunk: Uint8Array) => {
  outputState = "captured";
  const remaining = config.artifacts.maxLogBytes - logBytes;
  if (chunk.byteLength > remaining) truncated = true;
  if (remaining > 0) { const retained = Buffer.from(chunk.subarray(0, remaining)); logs.push(retained); logBytes += retained.length; }
 };
 const receipt = () => persistExecution(join(config.jobsRoot, ".artifacts"),
  validateRemoteTestReceipt({ version: 1, identity: job, executorId: config.executorId, status, exitCode, completedAt: now(), ...(coverage ? { coverage } : {}) }, job),
  { startedAt: executionStartedAt, log: Buffer.concat(logs, logBytes), truncated, outputState, resources },
  { ...config.artifacts, now, fault: options.artifactFault });
 if (job.deadline - now() < 1000) return receipt();
 if (options.signal?.aborted) { status = "cancelled"; return receipt(); }
 if (!uid || !gid || uid < 0 || gid < 0) return receipt();
 const root = await realpath(config.jobsRoot);
 const rootInfo = await stat(root);
 if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o022) !== 0 || /[,:\n]/.test(root)) throw new Error("Jobs root must be operator-owned and not writable by others");
 const lane = join(root, ".executor-lane");
 try { await mkdir(lane, { mode: 0o700 }); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new InterruptedRemoteTestJob(1); throw error; }
 try {
  const owner = await open(join(lane, "owner.json"), "wx", 0o600);
  try { await owner.writeFile(JSON.stringify({ ledgerId: ledger.id, jobId: job.jobId, token })); await owner.sync(); } finally { await owner.close(); }
 } catch (error) { await rm(lane, { recursive: true }); throw error; }
 const launcher = options.launcher ?? podmanLauncher;
 const controller = new AbortController();
 let interruption: "timed_out" | "cancelled" | "infra_failed" | undefined;
 const interrupt = (reason: typeof interruption) => { interruption ??= reason; controller.abort(); };
 const cancel = () => interrupt("cancelled");
 options.signal?.addEventListener("abort", cancel, { once: true });
 if (options.signal?.aborted) cancel();
 const end = Math.min(job.deadline, now() + timeoutMs);
 const timer = setTimeout(() => interrupt("timed_out"), Math.max(0, end - now()));
 const fenceTimer = setInterval(() => {
  try { if (!ledger.allowed(job, token)) interrupt(now() >= job.deadline ? "timed_out" : "cancelled"); }
  catch { interrupt("infra_failed"); }
 }, 100);
 const command = async (args: string[], cleanup = false): Promise<string> => {
  const signal = cleanup ? new AbortController().signal : controller.signal;
  if (signal.aborted) throw new Error("Interrupted");
  const remaining = end - now();
  if (!cleanup && remaining <= 0) { interrupt("timed_out"); throw new Error("Expired"); }
  const r = await launcher(["--remote=false", ...args], { signal, timeoutMs: cleanup ? 15_000 : Math.min(remaining, args[0] === "start" ? timeoutMs : 30_000) });
  if (r.code !== 0) throw new Error("Container engine operation failed");
  return r.stdout;
 };
 let checkout: string | undefined, containerId: string | undefined, launchAttempted = false, releaseLane = false;
 const cidfile = join(lane, "container-id");
 let sidecarId: string | undefined, sidecarAttempted = false;
 const sidecarCidfile = join(lane, "nats-id");
 try {
  const info = JSON.parse(await command(["info", "--format=json"]));
  if (info.host?.os !== "linux" || !["arm64", "aarch64"].includes(info.host.arch) || info.host.cgroupVersion !== "v2" || info.host.security?.rootless !== true ||
      !["cpu", "memory", "pids"].every(c => info.host.cgroupControllers?.includes(c))) throw new Error("Unsupported engine enforcement");
  const image = JSON.parse(await command(["image", "inspect", "--", selected.imageReference]));
  if (!Array.isArray(image) || image.length !== 1 || image[0].Digest !== job.imageDigest || image[0].Os !== "linux" || image[0].Architecture !== "arm64") throw new Error("Pinned runtime image unavailable");
  const sidecar = selected.profile.reviewed?.sidecars[0];
  if (sidecar) {
   const inspected = JSON.parse(await command(["image", "inspect", "--", sidecar.imageReference]));
   if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0].Digest !== sidecar.imageReference.split("@")[1] || inspected[0].Os !== "linux" || inspected[0].Architecture !== "arm64") throw Error("Pinned sidecar image unavailable");
  }
  const restored = await restoreSource({ bundlePath: input.bundlePath, jobsRoot: root, jobId: job.jobId,
   manifest: { version: 1, commitDigest: job.commitDigest, treeDigest: job.treeDigest, bundleDigest: job.bundleDigest } });
  checkout = restored.checkoutPath;
  const lock = await open(join(checkout, selected.lockFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
   if (!(await lock.stat()).isFile() || `sha256:${createHash("sha256").update(await lock.readFile()).digest("hex")}` !== job.lockDigest) throw new Error("Lock identity mismatch");
  } finally { await lock.close(); }
  if (selected.profile.reviewed) {
   const packageFile = await open(join(checkout, "package.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
   try {
    if (!(await packageFile.stat()).isFile()) throw Error("Invalid package file");
    const pkg = JSON.parse(await packageFile.readFile("utf8"));
    if (pkg.name !== "@the-metafactory/myelin" || pkg.scripts?.test !== "bun test" || pkg.scripts?.typecheck !== "bunx tsc --noEmit" || pkg.scripts?.lint !== "eslint .") throw Error("Repository recipe requires renewed review");
   } finally { await packageFile.close(); }
   // A new test root needs renewed review rather than silently losing coverage.
   const pending = [checkout]; let entries = 0;
   while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
     if (++entries > 50_000) throw Error("Reviewed source inventory too large");
     if (directory === checkout && entry.name === ".git") continue;
     const path = join(directory, entry.name), relative = path.slice(checkout.length + 1);
     if (entry.isSymbolicLink()) throw Error("Reviewed recipe does not support source symlinks");
     if (entry.isDirectory()) { pending.push(path); continue; }
     if (/(?:[._](?:test|spec))\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/^(?:src\/|scripts\/|tools\/|tests\/integration\/|tests\/package-exports\.smoke\.test\.ts$)/.test(relative)) throw Error("New test root requires recipe review");
    }
   }
  }
  const runtimeSeconds = Math.floor((end - now()) / 1000);
  if (runtimeSeconds < 1) interrupt("timed_out");
  if (controller.signal.aborted) throw new Error("Interrupted before launch");
  ledger.launch(job, token);
  if (sidecar) {
   sidecarAttempted = true;
   const id = (await command(["create", "--cidfile", sidecarCidfile, `--name=ranger-nats-${randomUUID()}`, "--pull=never",
    `--label=ranger.remote-test.ledger=${ledger.id}`, `--label=ranger.remote-test.job=${job.jobId}`, `--label=ranger.remote-test.attempt=${token}`, "--label=ranger.remote-test.role=nats",
    "--network=none", ...isolatedContainerFlags(budgets.nats!, runtimeSeconds, uid, gid),
    "--tmpfs=/data:rw,nosuid,nodev,size=134217728,mode=1777", "--entrypoint=/bin/sh", sidecar.imageReference, "-ec", natsProgram(budgets.nats!),
   ])).trim();
   if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid sidecar identity");
   sidecarId = id;
   const created = JSON.parse(await command(["inspect", id]))[0];
   if (!Array.isArray(created?.Mounts) || !created.Mounts.every((m: { Type: string; Destination: string }) => m.Type === "tmpfs" && ["/tmp", "/data"].includes(m.Destination))) throw Error("Unexpected sidecar mount policy");
   await command(["start", sidecarId]);
  }
  launchAttempted = true;
  const id = (await command(["create", "--cidfile", cidfile, `--name=ranger-test-${randomUUID()}`, "--pull=never",
   `--label=ranger.remote-test.ledger=${ledger.id}`, `--label=ranger.remote-test.job=${job.jobId}`, `--label=ranger.remote-test.attempt=${token}`,
   sidecarId ? `--network=container:${sidecarId}` : "--network=none", ...isolatedContainerFlags(budgets.test, runtimeSeconds, uid, gid),
   "--mount", `type=bind,source=${checkout},destination=/work,rw`, "--entrypoint=bun", selected.imageReference, ...CONTAINER_BOOTSTRAP_FLAGS, "-e", containerProgram(selected.profile.commands, selected.profile.reviewed, job.lockDigest),
  ])).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid container identity");
  containerId = id;
  // Refuse defaults from operator engine configuration that add host mounts.
  const created = JSON.parse(await command(["inspect", containerId]))[0];
  if (!Array.isArray(created?.Mounts) || created.Mounts.filter((m: { Type: string }) => m.Type === "bind").length !== 1 ||
      !created.Mounts.every((m: { Type: string; Source: string; Destination: string }) =>
       m.Type === "bind" ? m.Source === checkout && m.Destination === "/work" : m.Type === "tmpfs" && m.Destination === "/tmp")) throw new Error("Unexpected container mount policy");
  // A nonzero test exit is expected: do not confuse it with engine failure.
  const startedAt = now();
  resources = { state: "unavailable", cpuTimeMicros: null, peakMemoryBytes: null };
  outputState = "unavailable";
  ledger.launch(job, token);
  const result = await launcher(["--remote=false", "start", "--attach", containerId], { signal: controller.signal, timeoutMs: Math.max(1, end - now()) + 5000, onLog: captureLog });
  if (result.logsAvailable) outputState = "captured";
  const state = JSON.parse(await command(["inspect", containerId]))[0]?.State;
  if (state?.OOMKilled === true) { status = "infra_failed"; exitCode = Number.isInteger(state.ExitCode) && state.ExitCode >= 0 && state.ExitCode <= 255 ? state.ExitCode : null; }
  else if (!result.stdout.trim() && state?.Status === "exited" && state.ExitCode === 137 && now() - startedAt >= runtimeSeconds * 1000) { status = "timed_out"; }
  else {
   const terminal = z.object({ status: z.enum(["passed", "test_failed", "infra_failed"]), exitCode: z.number().int().min(0).max(255).nullable(), resources: ResourceObservationSchema.optional(), coverage: z.object({ requiredSkippedTests: z.number().int().nonnegative().safe().nullable() }).strict().optional() }).strict().parse(JSON.parse(result.stdout.trim()));
   if (terminal.status === "passed" && terminal.exitCode !== 0 || terminal.status === "test_failed" && (terminal.exitCode === null || terminal.exitCode === 0)) throw new Error("Inconsistent test outcome");
   if (state?.Status !== "exited" || state.ExitCode !== (terminal.exitCode ?? 125) || result.code !== state.ExitCode) throw new Error("Incomplete terminal result");
   status = terminal.status; exitCode = terminal.exitCode;
   if (terminal.resources) resources = terminal.resources;
   if (coverage) {
    if (!terminal.coverage) throw Error("Incomplete required test coverage");
    coverage = terminal.coverage;
    if (terminal.status === "passed" && coverage.requiredSkippedTests !== 0) throw Error("Incomplete required test coverage");
   }
  }
  if (sidecarId && status !== "timed_out") {
   const sidecarState = JSON.parse(await command(["inspect", sidecarId]))[0]?.State;
   if (sidecarState?.Status !== "running" || sidecarState.OOMKilled !== false) throw Error("Sidecar interrupted");
   // Summing independent peaks is a conservative aggregate upper bound.
   const metrics = await command(["exec", sidecarId, "/bin/sh", "-ec", sidecarMetricsProgram()]);
   const cpu = Number(metrics.match(/^usage_usec\s+(\d+)$/m)?.[1]);
   const peakValue = metrics.match(/^ranger_peak (unavailable|[0-9]+)$/m)?.[1];
   const peak = peakValue === "unavailable" ? null : Number(peakValue);
   const oom = Number(metrics.match(/^oom_kill\s+(\d+)$/m)?.[1]);
   if (!Number.isSafeInteger(cpu) || cpu < 0 || !Number.isSafeInteger(oom) || oom !== 0 ||
    peakValue === undefined || peak !== null && (!Number.isSafeInteger(peak) || peak < 0)) throw Error("Sidecar metrics invalid or OOM");
   if (resources.state === "observed" && peak !== null) {
    resources = ResourceObservationSchema.parse({ state: "observed", cpuTimeMicros: resources.cpuTimeMicros! + cpu, peakMemoryBytes: resources.peakMemoryBytes! + peak });
   } else resources = { state: "unavailable", cpuTimeMicros: null, peakMemoryBytes: null };
  }
 } catch {
  status = interruption ?? (launchAttempted || sidecarAttempted ? "infra_failed" : "rejected");
  if (sidecarAttempted && resources.state === "observed") resources = { state: "unavailable", cpuTimeMicros: null, peakMemoryBytes: null };
 }
 finally {
  clearTimeout(timer); clearInterval(fenceTimer); options.signal?.removeEventListener("abort", cancel);
  // A create interrupted after allocation can still leave a container. The
  // private cidfile is Podman's identity of that allocation, never a job name.
  if (!containerId && launchAttempted) {
   try { const id = (await readFile(cidfile, "utf8")).trim(); if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(); containerId = id; }
   catch { status = "infra_failed"; }
  }
  let safe = !launchAttempted || containerId !== undefined;
  if (containerId) {
   if (interruption) { try { await command(["kill", "--signal=KILL", containerId], true); } catch { /* rm --force is also a kill; its result gates cleanup. */ } }
   try { await command(["rm", "--force", "--volumes", containerId], true); } catch { safe = false; }
  }
  if (!sidecarId && sidecarAttempted) {
   try { const id = (await readFile(sidecarCidfile, "utf8")).trim(); if (!/^[a-f0-9]{64}$/.test(id)) throw Error(); sidecarId = id; }
   catch { safe = false; }
  }
  if (sidecarId) {
   try { await command(["rm", "--force", "--volumes", sidecarId], true); } catch { safe = false; }
  }
  if (safe) {
   try { if (checkout) await rm(join(root, job.jobId), { recursive: true, force: true }); releaseLane = true; }
   catch { safe = false; }
  }
  if (!safe) status = "infra_failed"; // Retain the lane and source for operator inspection.
 }
 if (status !== "infra_failed" && interruption) status = interruption;
 if (status === "passed" && now() > end) status = "timed_out";
 // Container/source teardown already finished. Releasing the lane may still
 // fail, so its outcome must be known before a terminal receipt is published.
 if (releaseLane) {
  try { await (options.removeLane ?? (path => rm(path, { recursive: true })))(lane); }
  catch { status = "infra_failed"; }
 }
 return receipt();
}

/** Operator restart seam. The old executor must be stopped; recovery never
 * infers success from an engine exit or removes foreign/unlabelled containers. */
export async function reconcileRemoteTests(input: unknown, options: { launcher?: ExecutorLauncher } = {}) {
 const config = validateExecutorConfig(input), root = await realpath(config.jobsRoot);
 const ledger = await openJobLedger(root, config.executorId), launcher = options.launcher ?? podmanLauncher;
 const command = async (argv: string[]) => {
  const result = await launcher(["--remote=false", ...argv], { signal: new AbortController().signal, timeoutMs: 30_000 });
  if (result.code !== 0) throw Error("Remote-test recovery engine operation failed"); return result.stdout;
 };
 try {
  await ledger.reconcile({
   list: async () => {
    const inventory = (await command(["ps", "--all", "--no-trunc", "--quiet", "--filter", `label=ranger.remote-test.ledger=${ledger.id}`])).trim();
    const ids = inventory ? inventory.split(/\s+/) : [];
    if (ids.length > 1024) throw Error("Invalid recovery container inventory");
    const containers: (OwnedContainer & { sidecar: boolean })[] = [];
    for (const id of ids) {
     if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Invalid recovery container ID");
     const inspected = JSON.parse(await command(["inspect", id]));
     if (!Array.isArray(inspected) || inspected.length !== 1 || inspected[0].Id !== id) throw Error("Invalid recovery container inspection");
     const labels = inspected[0].Config?.Labels;
     if (labels?.["ranger.remote-test.ledger"] !== ledger.id) throw Error("Recovery label mismatch");
     const role = labels["ranger.remote-test.role"];
     if (role !== undefined && role !== "nats") throw Error("Unknown recovery container role");
     containers.push({ id, ledgerId: labels["ranger.remote-test.ledger"], jobId: labels["ranger.remote-test.job"], token: labels["ranger.remote-test.attempt"], sidecar: role === "nats" });
    }
    // Network namespace dependants must go before their NATS owner.
    return containers.sort((a, b) => Number(a.sidecar) - Number(b.sidecar));
   },
   remove: async id => { await command(["rm", "--force", "--volumes", id]); },
   cleanup: async jobs => {
    const lane = join(root, ".executor-lane");
    const info = await lstat(lane).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (info) {
     if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw Error("Unsafe recovery lane");
     const owner = JSON.parse(await readFile(join(lane, "owner.json"), "utf8"));
     if (owner.ledgerId !== ledger.id || !jobs.some(j => j.jobId === owner.jobId)) throw Error("Unknown recovery lane owner");
     await rm(lane, { recursive: true });
    }
    const inbox = join(root, ".ssh-incoming"), inboxInfo = await lstat(inbox).catch(e => { if (e.code === "ENOENT") return null; throw e; });
    if (inboxInfo && (!inboxInfo.isDirectory() || inboxInfo.uid !== process.getuid?.() || (inboxInfo.mode & 0o077))) throw Error("Unsafe recovery inbox");
    for (const job of jobs) {
     await rm(join(root, job.jobId), { recursive: true, force: true });
     if (inboxInfo) await rm(join(inbox, job.jobId), { recursive: true, force: true });
    }
   },
  });
 } finally { ledger.close(); }
}

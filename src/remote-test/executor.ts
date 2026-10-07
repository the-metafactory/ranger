import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { killProcessGroup } from "../exec.ts";
import { validateProfileManifest, validateRemoteTestJob, validateRemoteTestReceipt, type RemoteTestReceipt } from "./contract.ts";
import { restoreSource } from "./source.ts";

export const EXECUTOR_LIMITS = { cpuCores: 2, memoryBytes: 1610612736, pids: 256, timeoutMs: 600_000 } as const;
const ConfigSchema = z.object({
 executorId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
 jobsRoot: z.string().refine(s => isAbsolute(s) && !/[\0,:\n]/.test(s) && !s.split("/").includes("..")),
 profiles: z.array(z.object({
  profile: z.unknown().transform(validateProfileManifest),
  lockFile: z.string().regex(/^[a-zA-Z0-9_.-]+$/).refine(s => s !== "." && s !== ".."),
  imageReference: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
 }).strict().refine(p => p.imageReference.endsWith(`@${p.profile.imageDigest}`))).min(1).max(32),
}).strict().refine(c => new Set(c.profiles.map(p => p.profile.profileId)).size === c.profiles.length);
export type ExecutorConfig = z.infer<typeof ConfigSchema>;
export function validateExecutorConfig(input: unknown): ExecutorConfig { return ConfigSchema.parse(input); }
export interface LaunchResult { code: number; stdout: string }
/** argv is Podman's argument vector. No shell, arbitrary engine flags or job env. */
export type ExecutorLauncher = (argv: readonly string[], options: { signal: AbortSignal; timeoutMs: number }) => Promise<LaunchResult>;

/** Bound all engine subprocesses and their output; never inherit source, bus or
 * forge credentials. Podman uses the operator's reviewed rootless engine config. */
export const podmanLauncher: ExecutorLauncher = (argv, options) => new Promise((resolve, reject) => {
 const env: NodeJS.ProcessEnv = {};
 for (const key of ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[key]) env[key] = process.env[key];
 const child = spawn("podman", [...argv], { env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
 let stdout = "", failed = false;
 const stop = () => { failed = true; if (child.pid) killProcessGroup(child.pid); };
 child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 65_536) stop(); });
 const timer = setTimeout(stop, options.timeoutMs);
 options.signal.addEventListener("abort", stop, { once: true });
 if (options.signal.aborted) stop();
 const finish = () => { clearTimeout(timer); options.signal.removeEventListener("abort", stop); };
 child.on("error", () => { finish(); reject(new Error("Container engine launch failed")); });
 child.on("close", code => { finish(); if (failed) reject(new Error("Container engine command interrupted")); else resolve({ code: code ?? -1, stdout }); });
});

/** Only this wrapper writes stdout. Tests and descendants have stdout/stderr
 * discarded, so a test cannot impersonate the terminal result. Check actual
 * cgroup files before the first reviewed command, not just requested flags. */
export function containerProgram(commands: [string, ...string[]][]): string {
 return `const fs = await import("node:fs/promises");
let result = {status:"infra_failed",exitCode:null};
try {
 const value = async name => (await fs.readFile("/sys/fs/cgroup/"+name,"utf8")).trim();
 const cpu = (await value("cpu.max")).split(/\\s+/).map(Number);
 if (process.getuid() === 0 || cpu.length !== 2 || !cpu.every(Number.isFinite) || cpu[0] <= 0 || cpu[1] <= 0 || cpu[0]/cpu[1] > 2 ||
     await value("memory.max") !== "1610612736" || await value("memory.swap.max") !== "0" || await value("pids.max") !== "256") throw Error("Required controller enforcement unavailable");
 for (const argv of ${JSON.stringify(commands)}) {
  const child = Bun.spawn(argv,{cwd:"/work",stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  const code = await child.exited;
  result = {status:code === 0 ? "passed" : "test_failed",exitCode:code};
  if (code !== 0) break;
 }
 if (/^oom_kill\\s+[1-9][0-9]*$/m.test(await value("memory.events"))) result.status = "infra_failed";
} catch { result.status = "infra_failed"; }
console.log(JSON.stringify(result));
process.exit(result.exitCode ?? 125);`;
}

/** One operator-exclusive jobs root is one lane. Configuration is trusted and
 * reviewed, never supplied by the job; profile digest authentication belongs
 * to that admission layer. Source and lock bytes are verified here. */
export async function executeRemoteTest(
 input: { job: unknown; bundlePath: string; config: unknown },
 options: { launcher?: ExecutorLauncher; signal?: AbortSignal; timeoutMs?: number; now?: () => number; uid?: number; gid?: number } = {},
): Promise<RemoteTestReceipt> {
 const config = validateExecutorConfig(input.config);
 const profileId = (input.job as { profileId?: unknown } | null)?.profileId;
 const selected = config.profiles.find(p => p.profile.profileId === profileId);
 if (!selected) throw new Error("Job profile is not operator-approved");
 const job = validateRemoteTestJob(input.job, selected.profile);
 const now = options.now ?? Date.now;
 const timeoutMs = options.timeoutMs ?? EXECUTOR_LIMITS.timeoutMs;
 if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > EXECUTOR_LIMITS.timeoutMs) throw new Error("Invalid executor wall-clock limit");
 const uid = options.uid ?? process.getuid?.(), gid = options.gid ?? process.getgid?.();
 let status: RemoteTestReceipt["status"] = "rejected", exitCode: number | null = null;
 const receipt = () => validateRemoteTestReceipt({ version: 1, identity: job, executorId: config.executorId, status, exitCode, completedAt: now() }, job);
 if (job.deadline - now() < 1000) return receipt();
 if (options.signal?.aborted) { status = "cancelled"; return receipt(); }
 if (!uid || !gid || uid < 0 || gid < 0) return receipt();
 const root = await realpath(config.jobsRoot);
 const rootInfo = await stat(root);
 if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o022) !== 0 || /[,:\n]/.test(root)) throw new Error("Jobs root must be operator-owned and not writable by others");
 const lane = join(root, ".executor-lane");
 try { await mkdir(lane, { mode: 0o700 }); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return receipt(); throw error; }
 const launcher = options.launcher ?? podmanLauncher;
 const controller = new AbortController();
 let interruption: "timed_out" | "cancelled" | undefined;
 const interrupt = (reason: typeof interruption) => { interruption ??= reason; controller.abort(); };
 const cancel = () => interrupt("cancelled");
 options.signal?.addEventListener("abort", cancel, { once: true });
 if (options.signal?.aborted) cancel();
 const end = Math.min(job.deadline, now() + timeoutMs);
 const timer = setTimeout(() => interrupt("timed_out"), Math.max(0, end - now()));
 const command = async (args: string[], cleanup = false): Promise<string> => {
  const signal = cleanup ? new AbortController().signal : controller.signal;
  if (signal.aborted) throw new Error("Interrupted");
  const remaining = end - now();
  if (!cleanup && remaining <= 0) { interrupt("timed_out"); throw new Error("Expired"); }
  const r = await launcher(["--remote=false", ...args], { signal, timeoutMs: cleanup ? 15_000 : Math.min(remaining, args[0] === "start" ? timeoutMs : 30_000) });
  if (r.code !== 0) throw new Error("Container engine operation failed");
  return r.stdout;
 };
 let checkout: string | undefined, containerId: string | undefined, launchAttempted = false;
 const cidfile = join(lane, "container-id");
 try {
  const info = JSON.parse(await command(["info", "--format=json"]));
  if (info.host?.os !== "linux" || !["arm64", "aarch64"].includes(info.host.arch) || info.host.cgroupVersion !== "v2" || info.host.security?.rootless !== true ||
      !["cpu", "memory", "pids"].every(c => info.host.cgroupControllers?.includes(c))) throw new Error("Unsupported engine enforcement");
  const image = JSON.parse(await command(["image", "inspect", "--", selected.imageReference]));
  if (!Array.isArray(image) || image.length !== 1 || image[0].Digest !== job.imageDigest || image[0].Os !== "linux" || image[0].Architecture !== "arm64") throw new Error("Pinned runtime image unavailable");
  const restored = await restoreSource({ bundlePath: input.bundlePath, jobsRoot: root, jobId: job.jobId,
   manifest: { version: 1, commitDigest: job.commitDigest, treeDigest: job.treeDigest, bundleDigest: job.bundleDigest } });
  checkout = restored.checkoutPath;
  const lock = await open(join(checkout, selected.lockFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
   if (!(await lock.stat()).isFile() || `sha256:${createHash("sha256").update(await lock.readFile()).digest("hex")}` !== job.lockDigest) throw new Error("Lock identity mismatch");
  } finally { await lock.close(); }
  if (end - now() < 1000) interrupt("timed_out");
  if (controller.signal.aborted) throw new Error("Interrupted before launch");
  launchAttempted = true;
  const runtimeSeconds = Math.floor((end - now()) / 1000);
  const id = (await command(["create", "--cidfile", cidfile, `--name=ranger-test-${randomUUID()}`, "--pull=never",
   "--network=none", "--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--cgroups=enabled",
   `--cpus=${EXECUTOR_LIMITS.cpuCores}`, `--memory=${EXECUTOR_LIMITS.memoryBytes}`, `--memory-swap=${EXECUTOR_LIMITS.memoryBytes}`, `--pids-limit=${EXECUTOR_LIMITS.pids}`,
   `--timeout=${runtimeSeconds}`, "--stop-timeout=0", "--restart=no", "--read-only", "--read-only-tmpfs=false",
   "--tmpfs=/tmp:rw,nosuid,nodev,size=67108864,mode=1777", "--cap-drop=ALL", "--security-opt=no-new-privileges",
   "--userns=keep-id", `--user=${uid}:${gid}`, "--http-proxy=false", "--unsetenv-all", "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=HOME=/tmp",
   "--image-volume=ignore", "--no-healthcheck", "--systemd=false", "--log-driver=none", "--workdir=/work",
   "--mount", `type=bind,source=${checkout},destination=/work,rw`, "--entrypoint=bun", selected.imageReference, "-e", containerProgram(selected.profile.commands),
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
  const result = await launcher(["--remote=false", "start", "--attach", containerId], { signal: controller.signal, timeoutMs: Math.max(1, end - now()) });
  const state = JSON.parse(await command(["inspect", containerId]))[0]?.State;
  if (state?.OOMKilled === true) { status = "infra_failed"; exitCode = Number.isInteger(state.ExitCode) && state.ExitCode >= 0 && state.ExitCode <= 255 ? state.ExitCode : null; }
  else if (!result.stdout.trim() && state?.Status === "exited" && state.ExitCode === 137 && now() - startedAt >= runtimeSeconds * 1000) { status = "timed_out"; }
  else {
   const terminal = z.object({ status: z.enum(["passed", "test_failed", "infra_failed"]), exitCode: z.number().int().min(0).max(255).nullable() }).strict().parse(JSON.parse(result.stdout.trim()));
   if (state?.Status !== "exited" || state.ExitCode !== (terminal.exitCode ?? 125) || result.code !== state.ExitCode) throw new Error("Incomplete terminal result");
   status = terminal.status; exitCode = terminal.exitCode;
  }
 } catch { status = interruption ?? (launchAttempted ? "infra_failed" : "rejected"); }
 finally {
  clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
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
  if (safe) {
   try { if (checkout) await rm(join(root, job.jobId), { recursive: true, force: true }); await rm(lane, { recursive: true }); }
   catch { safe = false; }
  }
  if (!safe) status = "infra_failed"; // Retain the lane and source for operator inspection.
 }
 if (status !== "infra_failed" && interruption) status = interruption;
 if (status === "passed" && now() > end) status = "timed_out";
 return receipt();
}

import { z } from "zod";
import { lstat, realpath, open, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runCmd, type RunResult, type RunOptions } from "../exec.ts";
import { validateProfileManifest, type ProfileManifest } from "./contract.ts";

const argument = z.string().max(4096).refine(s => !s.includes("\0"));
const command = z.tuple([argument.refine(s => s.length > 0)]).rest(argument);
const ConfigSchema = z.object({
 profile: z.unknown().transform(validateProfileManifest),
 cwd: argument.refine(s => s.startsWith("/")),
 runtime: command,
 // Only an already-delegated, non-root cgroup. Never enable controllers here.
 cgroupRoot: z.string().regex(/^\/sys\/fs\/cgroup\/(?:[a-zA-Z0-9_.:@-]+\/)*[a-zA-Z0-9_.:@-]+$/)
  .refine(s => !s.split("/").some(p => p === "." || p === "..")),
 timeoutSeconds: z.number().int().min(1).max(3600),
 health: z.array(z.object({ name: z.string().min(1).max(128), command }).strict()).max(32),
}).strict().refine(c => new Set(c.health.map(h => h.name)).size === c.health.length, { message: "Health probe names must be unique" });

export type BaselineConfig = z.infer<typeof ConfigSchema>;
export function validateBaselineConfig(input: unknown): BaselineConfig { return ConfigSchema.parse(input); }
export const BASELINE_LIMITS = { cpuCores: 2, memoryBytes: 1610612736, jobs: 1 } as const;
export type Measurement<T> = { status: "ok"; value: T } | { status: "failed" | "unavailable"; reason: string };
export interface WorkloadMetrics { cpuSeconds: number; peakMemoryBytes: number; durationSeconds: number; exitCode: number }
const WorkloadSchema = z.object({
 cpuSeconds: z.number().finite().nonnegative(), peakMemoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 durationSeconds: z.number().finite().nonnegative(), exitCode: z.number().int().min(0).max(255),
}).strict();
export interface BaselineMetrics {
 platform(): Promise<string>;
 runtime(config: BaselineConfig): Promise<string>;
 availableMemory(config: BaselineConfig): Promise<number>;
 controller(config: BaselineConfig): Promise<string>;
 health(probe: BaselineConfig["health"][number]): Promise<string>;
 workload(config: BaselineConfig): Promise<WorkloadMetrics>;
}
interface HealthEntry { name: string; measurement: Measurement<string> }
export interface BaselineReport {
 version: 1; generatedAt: string; mode: "capacity" | "run";
 transport: { kind: "local" } | { kind: "ssh"; target: string };
 profile: ProfileManifest; configuration: BaselineConfig; limits: typeof BASELINE_LIMITS;
 platform: Measurement<string>; runtime: Measurement<string>; controller: Measurement<string>;
 availableMemoryBefore: Measurement<number>; availableMemoryAfter: Measurement<number>;
 preHealth: HealthEntry[]; postHealth: HealthEntry[]; workload: Measurement<WorkloadMetrics>;
}
async function measure<T>(probe: () => Promise<T>): Promise<Measurement<T>> {
 try { return { status: "ok", value: await probe() }; }
 catch (error) { return { status: "failed", reason: error instanceof Error ? error.message : String(error) }; }
}
const unavailable = (reason: string): Measurement<never> => ({ status: "unavailable", reason });
function textValue(s: string): string { if (!s.trim()) throw new Error("Empty required measurement"); return s.trim(); }
function memoryValue(n: number): number {
 if (!Number.isSafeInteger(n) || n < 0) throw new Error("Unavailable or invalid available memory"); return n;
}

/** No effects until the reviewed operator config has been validated. An explicit
 * run grant never overrides missing capacity, runtime, controller or health. */
export async function runBaseline(input: BaselineConfig, opts: { run?: boolean; metrics: BaselineMetrics; now?: () => Date; transport?: BaselineReport["transport"] }): Promise<{ report: BaselineReport; exitCode: 0 | 1 }> {
 const config = validateBaselineConfig(input), m = opts.metrics;
 const health = async () => {
  const entries: HealthEntry[] = [];
  for (const h of config.health) entries.push({ name: h.name, measurement: await measure(async () => textValue(await m.health(h))) });
  return entries;
 };
 const report: BaselineReport = {
  version: 1, generatedAt: (opts.now ?? (() => new Date()))().toISOString(), mode: opts.run ? "run" : "capacity",
  transport: opts.transport ?? { kind: "local" },
  profile: config.profile, configuration: config, limits: BASELINE_LIMITS,
  platform: await measure(async () => {
   const value = textValue(await m.platform());
   if (!/^Linux (?:aarch64|arm64)$/.test(value)) throw new Error(`Profile requires linux-arm64; observed ${value}`);
   return value;
  }),
  runtime: await measure(async () => textValue(await m.runtime(config))),
  availableMemoryBefore: await measure(async () => memoryValue(await m.availableMemory(config))),
  controller: await measure(async () => textValue(await m.controller(config))),
  preHealth: await health(), postHealth: [],
  availableMemoryAfter: unavailable("Workload not attempted"), workload: unavailable("No --run grant"),
 };
 const required = [report.platform, report.runtime, report.controller, report.availableMemoryBefore, ...report.preHealth.map(h => h.measurement)];
 let failed = required.some(m => m.status !== "ok");
 if (opts.run) {
  if (failed) report.workload = unavailable("Required preflight measurement failed");
  else if (report.availableMemoryBefore.status === "ok" && report.availableMemoryBefore.value < BASELINE_LIMITS.memoryBytes) {
   report.workload = unavailable("Available memory is below the job cap; yielding"); failed = true;
  } else {
   report.workload = await measure(async () => WorkloadSchema.parse(await m.workload(config)));
   // Always observe residents after an attempted run, including transport failure.
   report.availableMemoryAfter = await measure(async () => memoryValue(await m.availableMemory(config)));
   report.postHealth = await health();
   failed = report.workload.status !== "ok" || report.workload.value.exitCode !== 0 ||
    report.availableMemoryAfter.status !== "ok" || report.postHealth.some(h => h.measurement.status !== "ok");
  }
 }
 return { report, exitCode: failed ? 1 : 0 };
}

export type CommandAdapter = (argv: readonly string[], timeoutMs: number) => Promise<RunResult>;
type Runner = (bin: string, args: string[], options: RunOptions) => Promise<RunResult>;
export const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\"'\"'")}'`;
export function localCommandAdapter(runner: Runner = runCmd): CommandAdapter {
 return (argv, timeoutMs) => runner(argv[0]!, argv.slice(1), { timeoutMs, processGroup: true });
}
export function sshCommandAdapter(target: string, runner: Runner = runCmd): CommandAdapter {
 // Operator-owned SSH alias/user@host only; no options, URLs or shell syntax.
 if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(target)) throw new Error("Invalid SSH target");
 return (argv, timeoutMs) => runner("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", target, argv.map(shellQuote).join(" ")], { timeoutMs, processGroup: true });
}

/** A single exclusive child of the delegated root is both lane lock and aggregate
 * controller. The controller shell stays outside it. No resident is moved,
 * stopped, or killed; cgroup.kill touches only this newly-created job group. */
function workloadScript(config: BaselineConfig): string {
 const child = `${config.cgroupRoot}/ranger-baseline`;
 const commands = config.profile.commands.map(c => c.map(shellQuote).join(" ")).join(" && ");
 const job = `set -eu; printf '%s\\n' "$$" > ${shellQuote(`${child}/cgroup.procs`)}; cd ${shellQuote(config.cwd)}; ${commands}`;
 return `set -eu
cg=${shellQuote(child)}
mkdir "$cg" || { echo 'Baseline lane occupied or unavailable' >&2; exit 125; }
watchdog=''
cleanup() {
 if [ -n "$watchdog" ]; then kill "$watchdog" 2>/dev/null || true; wait "$watchdog" 2>/dev/null || true; fi
 printf '1\\n' > "$cg/cgroup.kill" || return 1
 i=0
 while grep -q '^populated 1$' "$cg/cgroup.events"; do
  i=$((i+1)); [ "$i" -lt 50 ] || return 1; sleep 0.1
 done
 rmdir "$cg"
}
trap 'status=$?; trap - EXIT; cleanup || status=125; exit "$status"' EXIT
trap 'exit 124' HUP INT TERM
test -r "$cg/memory.peak"
test -w "$cg/cgroup.kill"
printf '${BASELINE_LIMITS.memoryBytes}\\n' > "$cg/memory.max"
printf '0\\n' > "$cg/memory.swap.max"
printf '${BASELINE_LIMITS.cpuCores * 100000} 100000\\n' > "$cg/cpu.max"
printf '1\\n' > "$cg/memory.oom.group"
start=$(date +%s%N)
# Watchdog lives on the target, so a lost SSH connection cannot grant an unbounded run.
(sleep ${config.timeoutSeconds} & sleeper=$!; trap '' HUP; trap 'kill "$sleeper" 2>/dev/null || true; wait "$sleeper" 2>/dev/null || true; exit' TERM INT; wait "$sleeper"; printf '1\\n' > "$cg/cgroup.kill") >/dev/null 2>&1 &
watchdog=$!
code=0
sh -c ${shellQuote(job)} >/dev/null 2>&1 || code=$?
end=$(date +%s%N)
if [ "$(( (end-start)/1000000000 ))" -ge ${config.timeoutSeconds} ]; then code=124; fi
# Any detached sidecar still alive is an incomplete job, not a success.
if grep -q '^populated 1$' "$cg/cgroup.events"; then code=125; fi
if awk '/^oom_kill / { if ($2 > 0) exit 1 }' "$cg/memory.events"; then :; else code=125; fi
printf '1\\n' > "$cg/cgroup.kill"
awk '/^usage_usec / { printf "cpuSeconds=%.6f\\n", $2 / 1000000; found=1 } END { if (!found) exit 1 }' "$cg/cpu.stat"
printf 'peakMemoryBytes=%s\\n' "$(cat "$cg/memory.peak")"
awk -v start="$start" -v end="$end" 'BEGIN { printf "durationSeconds=%.6f\\n", (end-start)/1000000000 }'
printf 'exitCode=%s\\n' "$code"
`;
}

/** Resolve existing parents before checking: a symlink must not turn a private
 * destination into a tracked deployment artifact. Refuse overwrites entirely. */
export async function privateOperatorPath(path: string, existing = false): Promise<string> {
 const absolute = resolve(path);
 const candidate = existing ? await realpath(absolute) : join(await realpath(dirname(absolute)), absolute.split("/").at(-1)!);
 let parent = dirname(candidate);
 for (;;) {
  try { await lstat(join(parent, ".git")); throw new Error("Operator configuration and reports must be outside git repositories"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const next = dirname(parent); if (next === parent) break; parent = next;
 }
 if (existing) {
  const info = await stat(candidate);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new Error("Operator configuration must be an operator-owned regular file without group/world write access");
 }
 return candidate;
}
export async function writePrivateBaselineReport(path: string, report: BaselineReport | (() => Promise<BaselineReport>)): Promise<string> {
 const destination = await privateOperatorPath(path);
 const file = await open(destination, "wx", 0o600);
 try { await file.writeFile(JSON.stringify(typeof report === "function" ? await report() : report, null, 2) + "\n"); }
 finally { await file.close(); }
 return destination;
}

export function createCommandMetrics(command: CommandAdapter): BaselineMetrics {
 async function checked(argv: readonly string[], timeoutMs = 15000): Promise<string> {
  const r = await command(argv, timeoutMs);
  if (r.code !== 0) throw new Error(`Probe exited ${r.code}: ${r.stderr.trim().slice(-1000)}`);
  return textValue(r.stdout);
 }
 return {
  platform: () => checked(["uname", "-sm"]),
  runtime: c => checked(c.runtime),
  availableMemory: async c => memoryValue(Number(await checked(["sh", "-c", `set -eu
available=$(awk '/^MemAvailable:/ { printf "%.0f\\n", $2 * 1024; found=1 } END { if (!found) exit 1 }' /proc/meminfo)
parent=${shellQuote(c.cgroupRoot)}
while [ "$parent" != /sys/fs/cgroup ]; do
 limit=$(cat "$parent/memory.max"); current=$(cat "$parent/memory.current")
 if [ "$limit" != max ]; then
  headroom=$((limit-current)); [ "$headroom" -ge 0 ] || headroom=0
  if [ "$headroom" -lt "$available" ]; then available=$headroom; fi
 fi
 parent=$(dirname "$parent")
done
printf '%s\\n' "$available"`]))),
  controller: async c => {
   const p = shellQuote(c.cgroupRoot);
   await checked(["sh", "-c", `set -eu; [ "$(stat -f -c %T ${p})" = cgroup2fs ]; test -w ${p}; test -r ${p}/memory.peak; test -r ${p}/memory.swap.max; test -w ${p}/cgroup.kill; grep -qw cpu ${p}/cgroup.subtree_control; grep -qw memory ${p}/cgroup.subtree_control; printf cgroup-v2`]);
   return "cgroup-v2";
  },
  health: async h => { await checked(["sh", "-c", `${h.command.map(shellQuote).join(" ")} >/dev/null && printf healthy`]); return "healthy"; },
  workload: async c => {
   const output = await checked(["sh", "-c", workloadScript(c)], (c.timeoutSeconds + 30) * 1000);
   const fields: Record<string, number> = {};
   for (const line of output.split("\n")) {
    const match = /^(cpuSeconds|peakMemoryBytes|durationSeconds|exitCode)=(\d+(?:\.\d+)?)$/.exec(line);
    if (!match || match[1]! in fields) throw new Error("Invalid or duplicate workload metric");
    fields[match[1]!] = Number(match[2]);
   }
   return WorkloadSchema.parse(fields);
  },
 };
}

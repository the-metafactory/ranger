import { describe, expect, test } from "bun:test";
import { runBaseline, createCommandMetrics, localCommandAdapter, sshCommandAdapter, shellQuote, writePrivateBaselineReport, privateOperatorPath, type BaselineMetrics, type BaselineConfig } from "../src/remote-test/baseline.ts";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config: BaselineConfig = {
 profile: { version: 1, profileId: "tests", profileDigest: `sha256:${"a".repeat(64)}`, lockDigest: `sha256:${"b".repeat(64)}`, imageDigest: `sha256:${"c".repeat(64)}`, platform: "linux-arm64", commands: [["bun", "test"]] },
 cwd: "/private/work", runtime: ["bun", "--version"], cgroupRoot: "/sys/fs/cgroup/delegated", timeoutSeconds: 60,
 health: [{ name: "resident", command: ["service-health"] }],
};
function fixture() {
 const calls: string[] = [];
 const metrics: BaselineMetrics = {
  platform: async () => { calls.push("platform"); return "Linux aarch64"; },
  runtime: async () => { calls.push("runtime"); return "1.3.6"; },
  availableMemory: async () => { calls.push("memory"); return 4 * 1024 ** 3; },
  controller: async () => { calls.push("controller"); return "cgroup-v2"; },
  health: async (h) => { calls.push(h.name); return "healthy"; },
  workload: async () => { calls.push("workload"); return { cpuSeconds: 1.25, peakMemoryBytes: 300000, durationSeconds: 2.5, exitCode: 0 }; },
 };
 return { metrics, calls };
}
describe("baseline handler", () => {
 test("capacity-only never invokes workload, explicitly marks job metrics unavailable", async () => {
  const f = fixture(); const r = await runBaseline(config, { metrics: f.metrics });
  expect(f.calls).not.toContain("workload"); expect(r.exitCode).toBe(0);
  expect(r.report.workload.status).toBe("unavailable"); expect(r.report.mode).toBe("capacity");
 });
 test("run records profile, platform, runtime, pre/post capacity and health, aggregate job metrics", async () => {
  const f = fixture(); const r = await runBaseline(config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(0); expect(r.report.profile).toEqual(config.profile);
  expect(r.report.workload).toEqual({ status: "ok", value: { cpuSeconds: 1.25, peakMemoryBytes: 300000, durationSeconds: 2.5, exitCode: 0 } });
  expect(f.calls).toEqual(["platform", "runtime", "memory", "controller", "resident", "workload", "memory", "resident"]);
 });
 for (const name of ["platform", "runtime", "availableMemory", "controller", "health"] as const) {
  test(`failed required ${name} probe is explicit, nonzero and blocks the workload`, async () => {
   const f = fixture(); f.metrics[name] = async () => { throw new Error("unavailable"); };
   const r = await runBaseline(config, { run: true, metrics: f.metrics });
   expect(r.exitCode).toBe(1); expect(f.calls).not.toContain("workload"); expect(JSON.stringify(r.report)).toContain("failed");
  });
 }
 test("insufficient capacity yields without a job", async () => {
  const f = fixture(); f.metrics.availableMemory = async () => 0;
  const r = await runBaseline(config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(f.calls).not.toContain("workload");
 });
 test("workload exception still probes post service health", async () => {
  const f = fixture(); f.metrics.workload = async () => { throw new Error("transport interrupted"); };
  const r = await runBaseline(config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(f.calls.filter(x => x === "resident")).toHaveLength(2);
  expect(r.report.workload.status).toBe("failed");
 });
 test("failed post health and nonzero workload cannot produce success", async () => {
  const f = fixture(); let n = 0; f.metrics.health = async () => { if (n++) throw new Error("down"); return "healthy"; };
  f.metrics.workload = async () => ({ cpuSeconds: 1, peakMemoryBytes: 2, durationSeconds: 3, exitCode: 124 });
  const r = await runBaseline(config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.postHealth[0]?.measurement.status).toBe("failed");
 });
 test("malformed numeric metrics and mismatched platform fail explicitly", async () => {
  const f = fixture(); f.metrics.workload = async () => ({ cpuSeconds: NaN, peakMemoryBytes: -1, durationSeconds: 0, exitCode: 0 });
  expect((await runBaseline(config, { run: true, metrics: f.metrics })).report.workload.status).toBe("failed");
  const platform = fixture(); platform.metrics.platform = async () => "Darwin arm64";
  const r = await runBaseline(config, { run: true, metrics: platform.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.platform.status).toBe("failed"); expect(platform.calls).not.toContain("workload");
 });
 test("invalid profile is rejected before any command", async () => {
  const f = fixture(); await expect(runBaseline({ ...config, profile: { ...config.profile, version: 2 } } as unknown as BaselineConfig, { metrics: f.metrics })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
 });
});
describe("command adapters (no live hosts)", () => {
 test("local adapter forwards argv and timeout with group cleanup", async () => {
  const calls: unknown[] = [];
  const adapter = localCommandAdapter(async (...args) => { calls.push(args); return { code: 0, stdout: "ok", stderr: "" }; });
  await adapter(["printf", "a b"], 4000);
  expect(calls).toEqual([["printf", ["a b"], { timeoutMs: 4000, processGroup: true }]]);
 });
 test("SSH uses batch mode and quotes every remote argument, never local shell interpolation", async () => {
  const calls: unknown[][] = [];
  const adapter = sshCommandAdapter("operator@host", async (...args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; });
  await adapter(["printf", "'; $(touch /tmp/nope)"], 4000);
  expect(calls[0]?.[0]).toBe("ssh");
  expect(calls[0]?.[1]).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "operator@host", "'printf' ''\"'\"'; $(touch /tmp/nope)'"]);
  expect(() => sshCommandAdapter("-oProxyCommand=evil")).toThrow();
 });
 test("command metrics reject missing runtime and malformed output", async () => {
  const m = createCommandMetrics(async () => ({ code: 127, stdout: "", stderr: "missing" }));
  await expect(m.runtime(config)).rejects.toThrow();
  const broken = createCommandMetrics(async () => ({ code: 0, stdout: "garbage", stderr: "" }));
  await expect(broken.availableMemory(config)).rejects.toThrow();
  await expect(broken.workload(config)).rejects.toThrow();
 });
 test("cgroup wrapper sets fixed caps, encloses argv, kills leftovers and times out on target", async () => {
  let argv: readonly string[] = [];
  const m = createCommandMetrics(async (a) => { argv = a; return { code: 0, stdout: "cpuSeconds=1\npeakMemoryBytes=2\ndurationSeconds=3\nexitCode=0\n", stderr: "" }; });
  await m.workload(config);
  expect(argv[0]).toBe("sh"); const script = argv[2]!;
  expect(script).toContain("1610612736"); expect(script).toContain("200000 100000");
  expect(script).toContain("cgroup.kill"); expect(script).toContain("sleep 60");
  expect(script).toContain(shellQuote("bun").replaceAll("'", "'\"'\"'")); expect(script).toContain("memory.peak");
 });
});
describe("private report storage", () => {
 test("report is owner-only, refuses overwrite and repository/symlink destinations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ranger-baseline-"));
  try {
   const { report } = await runBaseline(config, { metrics: fixture().metrics });
   const path = join(dir, "report.json"); await writePrivateBaselineReport(path, report);
   expect((await stat(path)).mode & 0o777).toBe(0o600);
   expect(JSON.parse(await readFile(path, "utf8"))).toEqual(report);
   await expect(writePrivateBaselineReport(path, report)).rejects.toThrow();
   let invoked = false;
   await expect(writePrivateBaselineReport(path, async () => { invoked = true; return report; })).rejects.toThrow();
   expect(invoked).toBe(false);
   await chmod(path, 0o666);
   await expect(privateOperatorPath(path, true)).rejects.toThrow("operator-owned");
   await chmod(path, 0o600);
   await mkdir(join(dir, "repo")); await mkdir(join(dir, "repo", ".git"));
   await symlink(join(dir, "repo"), join(dir, "link"));
   await expect(privateOperatorPath(join(dir, "link", "report.json"))).rejects.toThrow("outside git");
   await expect(writePrivateBaselineReport(join(dir, "repo", "report.json"), report)).rejects.toThrow("outside git");
  } finally { await rm(dir, { recursive: true, force: true }); }
 });
});

for (const failure of ["cleanup", "sidecar", "oom", "missing-peak", "timeout"] as const) {
 test(`shell wrapper fails visibly on ${failure} (fake controller)`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ranger-baseline-failure-"));
  try {
   const setup = `printf 'populated ${failure === "sidecar" ? 1 : 0}\\n' > "$cg/cgroup.events"; printf 'oom_kill ${failure === "oom" ? 1 : 0}\\n' > "$cg/memory.events"; printf 'usage_usec 1000000\\n' > "$cg/cpu.stat"; ${failure === "missing-peak" ? "true" : "printf '1000\\n' > \"$cg/memory.peak\""}; touch "$cg/cgroup.kill"`;
   const local = localCommandAdapter();
   const m = createCommandMetrics(async (argv, timeout) => {
    let script = argv[2]!.replaceAll(config.cgroupRoot, dir).replace("watchdog=''", `${setup}\nwatchdog=''`);
    // The fake filesystem cannot actually kill processes. Model the kernel's
    // transition to empty when the job group's kill file is written.
    const kernelKill = failure === "timeout" ? `if [ -f "$cg/cgroup.procs" ]; then kill -KILL "$(cat "$cg/cgroup.procs")" 2>/dev/null || true; fi;` : "";
    script = script.replaceAll(`printf '1\\n' > "$cg/cgroup.kill"`, `(printf '1\\n' > "$cg/cgroup.kill"; ${kernelKill} printf 'populated 0\\n' > "$cg/cgroup.events")`);
    script = script.replace('rmdir "$cg"', failure === "cleanup" ? "return 1" : 'rm -f "$cg/"*; rmdir "$cg"');
    return local(["sh", "-c", script], failure === "timeout" ? 5000 : timeout);
   });
   const marker = join(dir, "ran");
   // exec keeps the recorded cgroup.procs PID as the sleeper. The fake kernel
   // kill models that cgroup operation, so a broken target watchdog cannot
   // pass through the elapsed-time check: this workload would run for 30 s.
   const c = { ...config, cwd: dir, timeoutSeconds: failure === "timeout" ? 1 : 60, profile: { ...config.profile, commands: failure === "timeout" ? [["exec", "sleep", "30"]] : [["touch", marker]] } } as BaselineConfig;
   if (failure === "cleanup" || failure === "missing-peak") {
    await expect(m.workload(c)).rejects.toThrow();
    if (failure === "missing-peak") await expect(stat(marker)).rejects.toThrow();
   } else {
    const started = Date.now(); const result = await m.workload(c);
    expect(result.exitCode).toBe(failure === "timeout" ? 124 : 125);
    if (failure === "timeout") expect(Date.now() - started).toBeLessThan(4000);
   }
  } finally { await rm(dir, { recursive: true, force: true }); }
 });
}

test("real shell wrapper runs quoted argv only after caps, preserves test failure, and cleans its exclusive lane (fake cgroup files)", async () => {
 const dir = await mkdtemp(join(tmpdir(), "ranger-baseline-shell-"));
 try {
  const cg = join(dir, "ranger-baseline");
  const fakeFiles = `printf 'populated 0\\n' > "$cg/cgroup.events"; printf 'oom_kill 0\\n' > "$cg/memory.events"; printf 'usage_usec 1250000\\n' > "$cg/cpu.stat"; printf '12345\\n' > "$cg/memory.peak"; touch "$cg/cgroup.kill"`;
  const local = localCommandAdapter();
  const m = createCommandMetrics(async (argv, timeout) => {
   // Only replace the controller filesystem for this isolated offline test.
   const script = argv[2]!.replaceAll(config.cgroupRoot, dir)
    .replace('watchdog=\'\'', `${fakeFiles}\nwatchdog=''`)
    .replace('rmdir "$cg"', 'rm -f "$cg/"*; rmdir "$cg"');
   return local(["sh", "-c", script], timeout);
  });
  const marker = join(dir, "quoted ' argument");
  const command = `test "$(cat ${shellQuote(join(cg, "memory.max"))})" = 1610612736 && test "$(cat ${shellQuote(join(cg, "cpu.max"))})" = '200000 100000' && printf ran > ${shellQuote(marker)}; exit 7`;
  const result = await m.workload({ ...config, cwd: dir, profile: { ...config.profile, commands: [["sh", "-c", command]] } });
  expect(result.exitCode).toBe(7); expect(result.cpuSeconds).toBe(1.25); expect(result.peakMemoryBytes).toBe(12345);
  expect(await readFile(marker, "utf8")).toBe("ran");
  await expect(stat(cg)).rejects.toThrow();
  // An existing lane refuses before the reviewed command is invoked.
  await mkdir(cg); await writeFile(marker, "untouched");
  await expect(m.workload({ ...config, cwd: dir, profile: { ...config.profile, commands: [["touch", marker]] } })).rejects.toThrow("occupied");
  expect(await readFile(marker, "utf8")).toBe("untouched");
 } finally { await rm(dir, { recursive: true, force: true }); }
});

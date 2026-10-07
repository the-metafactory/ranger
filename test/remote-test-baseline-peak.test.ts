import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 createCommandMetrics, localCommandAdapter, runBaseline, shellQuote, writePrivateBaselineReport,
 type BaselineConfig, type WorkloadMetrics,
} from "../src/remote-test/baseline.ts";

const config: BaselineConfig = {
 profile: { version: 1, profileId: "tests", profileDigest: `sha256:${"a".repeat(64)}`, lockDigest: `sha256:${"b".repeat(64)}`, imageDigest: `sha256:${"c".repeat(64)}`, platform: "linux-arm64", commands: [["true"]] },
 cwd: "/private/work", runtime: ["fixture-runtime"], cgroupRoot: "/sys/fs/cgroup/delegated", timeoutSeconds: 60,
 health: [{ name: "resident", command: ["fixture-health"] }],
};

// Execute production-generated shells. Only the cgroup filesystem, platform,
// resident probes and kernel kill/removal operations are replaced; no host lane,
// SSH, container or service is activated by these default tests.
async function fixture(options: {
 peak?: string; readError?: "EACCES" | "EIO" | "ENOENT"; listingError?: boolean;
 failure?: "test" | "oom" | "timeout" | "sidecar" | "cleanup";
 missing?: string; controller?: string; ancestorHeadroom?: number;
 rootPeak?: string; postFailure?: "health" | "capacity";
} = {}) {
 const dir = await mkdtemp(join(tmpdir(), "ranger-baseline-peak-"));
 const ancestor = join(dir, "ancestor"), root = join(ancestor, "delegated"), cg = join(root, "ranger-baseline"), marker = join(dir, "ran");
 await mkdir(root, { recursive: true });
 for (const [file, value] of Object.entries({
  "memory.max": "max", "memory.current": "0", "memory.swap.max": "max",
  "cgroup.kill": "", "cgroup.subtree_control": options.controller ?? "cpu memory",
 })) await writeFile(join(root, file), value);
 await writeFile(join(ancestor, "memory.max"), options.ancestorHeadroom === undefined ? "max" : String(options.ancestorHeadroom));
 await writeFile(join(ancestor, "memory.current"), "0");
 if (options.rootPeak !== undefined) await writeFile(join(root, "memory.peak"), options.rootPeak);
 await writeFile(join(dir, "meminfo"), "MemAvailable: 4194304 kB\n");
 let healthCalls = 0, memoryCalls = 0, runs = 0;
 const local = localCommandAdapter();
 const metrics = createCommandMetrics(async (argv, timeout) => {
  if (argv[0] === "uname") return { code: 0, stdout: "Linux aarch64", stderr: "" };
  if (argv[0] === "fixture-runtime") return { code: 0, stdout: "fixture", stderr: "" };
  let script = argv[2]!;
  if (script.includes("fixture-health")) {
   healthCalls++;
   return options.postFailure === "health" && healthCalls > 1 ? { code: 1, stdout: "", stderr: "resident unhealthy" } : { code: 0, stdout: "healthy", stderr: "" };
  }
  script = script.replaceAll(config.cgroupRoot, root).replaceAll("/sys/fs/cgroup", dir)
   .replace("/proc/meminfo", shellQuote(join(dir, "meminfo")))
   .replace(`stat -f -c %T ${shellQuote(root)}`, "printf cgroup2fs");
  if (script.includes("MemAvailable")) {
   memoryCalls++;
   if (options.postFailure === "capacity" && memoryCalls > 1) return { code: 1, stdout: "", stderr: "post-run capacity unavailable" };
  }
  if (script.includes("watchdog=''")) {
   runs++;
   const setup = [
    `printf 'populated ${options.failure === "sidecar" ? 1 : 0}\\n' > "$cg/cgroup.events"`,
    `printf 'oom_kill ${options.failure === "oom" ? 1 : 0}\\n' > "$cg/memory.events"`,
    `printf 'usage_usec 1250000\\n' > "$cg/cpu.stat"`,
    `touch "$cg/cgroup.kill"`,
    options.peak === undefined ? "true" : `printf '%s' ${shellQuote(options.peak)} > "$cg/memory.peak"`,
    // A directory simulates an interface the kernel cannot write, unlike an
    // ordinary absent fixture file that shell redirection would create.
    options.missing ? `mkdir "$cg/${options.missing}"` : "true",
   ].join("; ");
   const cat = options.readError ? `cat() { case "$1" in */memory.peak) echo '${options.readError}' >&2; return 1;; *) command cat "$@";; esac; }` : "";
   const ls = options.listingError ? "ls() { echo 'EIO' >&2; return 1; }" : "";
   script = script.replace("watchdog=''", `${setup}\n${cat}\n${ls}\nwatchdog=''`);
   const kill = options.failure === "timeout" ? `if [ -f "$cg/cgroup.procs" ]; then kill -KILL "$(cat "$cg/cgroup.procs")" 2>/dev/null || true; fi;` : "";
   script = script.replaceAll(`printf '1\\n' > "$cg/cgroup.kill"`, `(printf '1\\n' > "$cg/cgroup.kill"; ${kill} printf 'populated 0\\n' > "$cg/cgroup.events")`);
   script = script.replace('rmdir "$cg"', options.failure === "cleanup" ? "return 1" : 'rm -rf "$cg/"*; rmdir "$cg"');
  }
  return local(["sh", "-c", script], options.failure === "timeout" ? 5000 : timeout);
 });
 const checkCaps = `test "$(cat ${shellQuote(join(cg, "memory.max"))})" = 1610612736 && test "$(cat ${shellQuote(join(cg, "memory.swap.max"))})" = 0 && test "$(cat ${shellQuote(join(cg, "cpu.max"))})" = '200000 100000' && test "$(cat ${shellQuote(join(cg, "memory.oom.group"))})" = 1 && printf ran > ${shellQuote(marker)}`;
 const c: BaselineConfig = { ...config, cwd: dir, timeoutSeconds: options.failure === "timeout" ? 1 : 60,
  profile: { ...config.profile, commands: options.failure === "timeout" ? [["exec", "sleep", "30"]] : [["sh", "-c", `${checkCaps} || exit 99; exit ${options.failure === "test" ? 7 : 0}`]] },
 };
 return { dir, root, cg, marker, config: c, metrics, counts: () => ({ healthCalls, memoryCalls, runs }), dispose: () => rm(dir, { recursive: true, force: true }) };
}

test("absent peak permits capacity preflight and granted bounded run; V2 private JSON preserves null", async () => {
 const f = await fixture();
 try {
  const capacity = await runBaseline(f.config, { metrics: f.metrics });
  expect(capacity.exitCode).toBe(0); expect(capacity.report.version).toBe(2);
  expect(f.counts().runs).toBe(0); expect(capacity.report.workload.status).toBe("unavailable");
  const result = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(result.exitCode).toBe(0);
  expect(result.report.workload).toEqual({ status: "ok", value: {
   cpuSeconds: 1.25, durationSeconds: expect.any(Number), exitCode: 0,
   peakMemoryBytes: null, peakMemoryState: "unavailable",
  } });
  expect(await readFile(f.marker, "utf8")).toBe("ran");
  await expect(stat(f.cg)).rejects.toThrow();
  expect(f.counts()).toEqual({ healthCalls: 3, memoryCalls: 3, runs: 1 });
  const path = join(f.dir, "report.json"); await writePrivateBaselineReport(path, result.report);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.workload.value.peakMemoryBytes).toBeNull(); expect(saved.version).toBe(2);
  expect(saved.configuration.profile.version).toBe(1); expect((await stat(path)).mode & 0o777).toBe(0o600);
 } finally { await f.dispose(); }
});

for (const peak of ["0\n", "12345\n", "9007199254740991\n"]) test(`valid child peak ${peak.trim()} is exactly observed even with absent root peak`, async () => {
 const f = await fixture({ peak });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(0);
  expect(r.report.workload).toMatchObject({ status: "ok", value: { peakMemoryBytes: Number(peak), peakMemoryState: "observed" } });
 } finally { await f.dispose(); }
});

test("root peak does not imply child peak availability", async () => {
 const f = await fixture({ rootPeak: "98765" });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(0); expect(r.report.workload).toMatchObject({ status: "ok", value: { peakMemoryBytes: null, peakMemoryState: "unavailable" } });
 } finally { await f.dispose(); }
});

for (const peak of ["", "\n", "garbage", "-1", "1.5", "9007199254740992", "1\n2"]) test(`present malformed peak ${JSON.stringify(peak)} fails and still observes health/capacity`, async () => {
 const f = await fixture({ peak });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.workload.status).toBe("failed");
  expect(f.counts()).toEqual({ healthCalls: 2, memoryCalls: 2, runs: 1 });
  await expect(stat(f.cg)).rejects.toThrow();
 } finally { await f.dispose(); }
});

for (const readError of ["EACCES", "EIO", "ENOENT"] as const) test(`listed peak read ${readError} fails rather than becoming unavailable`, async () => {
 const f = await fixture({ peak: "123", readError });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.workload.status).toBe("failed");
  expect(f.counts().healthCalls).toBe(2); expect(f.counts().memoryCalls).toBe(2);
  await expect(stat(f.cg)).rejects.toThrow();
 } finally { await f.dispose(); }
});

test("failed namespace enumeration cannot establish absence", async () => {
 const f = await fixture({ listingError: true });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.workload.status).toBe("failed");
  await expect(stat(f.marker)).rejects.toThrow();
 } finally { await f.dispose(); }
});

for (const failure of ["test", "oom", "timeout", "sidecar", "cleanup"] as const) test(`absent peak preserves ${failure} outcome and post-run observations`, async () => {
 const f = await fixture({ failure });
 try {
  const started = Date.now();
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(f.counts()).toEqual({ healthCalls: 2, memoryCalls: 2, runs: 1 });
  if (failure === "cleanup") {
   expect(r.report.workload.status).toBe("failed"); expect((await stat(f.cg)).isDirectory()).toBe(true);
  } else {
   expect(r.report.workload).toMatchObject({ status: "ok", value: { peakMemoryBytes: null, peakMemoryState: "unavailable", exitCode: failure === "test" ? 7 : failure === "timeout" ? 124 : 125 } });
   await expect(stat(f.cg)).rejects.toThrow();
  }
  if (failure === "timeout") expect(Date.now() - started).toBeLessThan(4000);
 } finally { await f.dispose(); }
});

test("absent peak does not bypass an occupied lane or remove its contents", async () => {
 const f = await fixture();
 try {
  await mkdir(f.cg); await writeFile(join(f.cg, "owner"), "other job");
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.workload.status).toBe("failed");
  expect(await readFile(join(f.cg, "owner"), "utf8")).toBe("other job");
  await expect(stat(f.marker)).rejects.toThrow();
  expect(f.counts().healthCalls).toBe(2);
 } finally { await f.dispose(); }
});

for (const postFailure of ["health", "capacity"] as const) test(`absent peak and passing workload cannot conceal post-run ${postFailure} failure`, async () => {
 const f = await fixture({ postFailure });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1);
  expect(r.report.workload).toMatchObject({ status: "ok", value: { peakMemoryBytes: null, peakMemoryState: "unavailable", exitCode: 0 } });
  expect(postFailure === "health" ? r.report.postHealth[0]!.measurement.status : r.report.availableMemoryAfter.status).toBe("failed");
  expect(f.counts()).toEqual({ healthCalls: 2, memoryCalls: 2, runs: 1 });
 } finally { await f.dispose(); }
});

for (const missing of ["memory.max", "memory.swap.max", "cpu.max", "memory.oom.group", "cgroup.procs"]) test(`absent peak still refuses unwritable ${missing} before workload`, async () => {
 const f = await fixture({ missing });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1);
  if (missing === "cgroup.procs") expect(r.report.workload).toMatchObject({ status: "ok", value: { exitCode: 1 } });
  else expect(r.report.workload.status).toBe("failed");
  await expect(stat(f.marker)).rejects.toThrow();
  expect(f.counts().healthCalls).toBe(2);
 } finally { await f.dispose(); }
});

for (const controller of ["cpu", "memory", ""]) test(`missing mandatory controllers ${JSON.stringify(controller)} refuse preflight without peak`, async () => {
 const f = await fixture({ controller });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.controller.status).toBe("failed"); expect(f.counts().runs).toBe(0);
 } finally { await f.dispose(); }
});

test("absent peak preserves ancestor available-memory headroom admission", async () => {
 const f = await fixture({ ancestorHeadroom: 1024 });
 try {
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.availableMemoryBefore).toEqual({ status: "ok", value: 1024 });
  expect(f.counts().runs).toBe(0);
 } finally { await f.dispose(); }
});

for (const file of ["memory.swap.max", "cgroup.kill"]) test(`absent peak does not excuse missing mandatory root ${file}`, async () => {
 const f = await fixture();
 try {
  await rm(join(f.root, file));
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.controller.status).toBe("failed"); expect(f.counts().runs).toBe(0);
 } finally { await f.dispose(); }
});

test("absent peak does not excuse an unwritable mandatory root kill interface", async () => {
 const f = await fixture();
 try {
  await chmod(join(f.root, "cgroup.kill"), 0o400);
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.controller.status).toBe("failed"); expect(f.counts().runs).toBe(0);
 } finally { await f.dispose(); }
});

for (const output of [
 "cpuSeconds=1\ndurationSeconds=2\nexitCode=0\npeakMemoryState=observed\npeakMemoryBytes=null",
 "cpuSeconds=1\ndurationSeconds=2\nexitCode=0\npeakMemoryState=unavailable\npeakMemoryBytes=0",
 "cpuSeconds=1\ndurationSeconds=2\nexitCode=0\npeakMemoryState=unknown\npeakMemoryBytes=null",
 "cpuSeconds=1\ndurationSeconds=2\nexitCode=0\npeakMemoryBytes=null",
 "cpuSeconds=1\ndurationSeconds=2\nexitCode=0\npeakMemoryState=unavailable\npeakMemoryBytes=null\npeakMemoryBytes=null",
 "cpuSeconds=1\ndurationSeconds=2\nexitCode=0\npeakMemoryState=unavailable\npeakMemoryBytes=null\nextra=1",
]) test(`command metrics reject invalid V2 wire output ${JSON.stringify(output)}`, async () => {
 const metrics = createCommandMetrics(async () => ({ code: 0, stdout: output, stderr: "" }));
 await expect(metrics.workload(config)).rejects.toThrow();
});

for (const change of [
 { peakMemoryBytes: 0, peakMemoryState: "unavailable" }, { peakMemoryBytes: null, peakMemoryState: "observed" },
 { cpuSeconds: undefined }, { durationSeconds: undefined }, { exitCode: undefined },
 { cpuSeconds: NaN }, { durationSeconds: -1 }, { exitCode: 256 },
]) test(`V2 metric validation refuses ${JSON.stringify(change)}`, async () => {
 const f = await fixture();
 try {
  f.metrics.workload = async () => ({ cpuSeconds: 1, durationSeconds: 2, exitCode: 0, peakMemoryBytes: null, peakMemoryState: "unavailable", ...change } as WorkloadMetrics);
  const r = await runBaseline(f.config, { run: true, metrics: f.metrics });
  expect(r.exitCode).toBe(1); expect(r.report.workload.status).toBe("failed");
 } finally { await f.dispose(); }
});

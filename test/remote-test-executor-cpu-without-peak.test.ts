import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { ResourceObservationSchema } from "../src/remote-test/contract.ts";
import { CONTAINER_BOOTSTRAP_FLAGS, containerProgram } from "../src/remote-test/executor.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const unavailable = { state: "unavailable", cpuTimeMicros: null, peakMemoryBytes: null };

async function wrapper(fields: Record<string, string | null> = {}) {
 const root = await mkdtemp(join(tmpdir(), "ranger-cpu-without-peak-")); roots.push(root);
 const cgroup = join(root, "cgroup"); await mkdir(cgroup);
 const files = { "cpu.max": "200000 100000", "memory.max": "1610612736", "memory.swap.max": "0", "pids.max": "256", "memory.events": "oom_kill 0", "cpu.stat": "usage_usec 100\n", ...fields };
 for (const [name, value] of Object.entries(files)) if (value !== null) await writeFile(join(cgroup, name), value);
 const program = containerProgram([[process.execPath, "-e", "process.exit(0)"]])
  .replaceAll("/sys/fs/cgroup/", cgroup + "/").replaceAll('"/sys/fs/cgroup"', JSON.stringify(cgroup))
  .replace('cwd:"/work"', `cwd:${JSON.stringify(root)}`);
 return { cgroup, run: async () => {
  const result = await runCmd(process.execPath, [...CONTAINER_BOOTSTRAP_FLAGS, "-e", program]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
 } };
}

for (const peak of [null, "0", "4096\n"]) test(`wrapper retains CPU with peak ${JSON.stringify(peak)}`, async () => {
 const f = await wrapper({ "memory.peak": peak });
 const terminal = await f.run();
 expect(terminal.status).toBe("passed");
 expect(terminal.resources).toEqual({ state: "observed", cpuTimeMicros: 100, peakMemoryBytes: peak === null ? null : Number(peak) });
});

for (const cpu of [null, "", "usage_usec bad", "usage_usec -1", "usage_usec 1.5", "usage_usec 9007199254740992"])
 for (const peak of [null, "4096", "bad"]) test(`wrapper rejects CPU ${JSON.stringify(cpu)} with peak ${JSON.stringify(peak)}`, async () => {
  const f = await wrapper({ "cpu.stat": cpu, "memory.peak": peak });
  expect((await f.run()).resources).toEqual(unavailable);
 });

for (const peak of ["", " \n", "bad", "-1", "1.5", "1\n2", "0x10", "1e3", "9007199254740992"])
 test(`wrapper rejects existing invalid peak ${JSON.stringify(peak)}`, async () => {
  const f = await wrapper({ "memory.peak": peak });
  expect((await f.run()).resources).toEqual(unavailable);
 });

test("wrapper rejects a listed peak with a failed read", async () => {
 const f = await wrapper(); await mkdir(join(f.cgroup, "memory.peak"));
 expect((await f.run()).resources).toEqual(unavailable);
 await rm(join(f.cgroup, "memory.peak"), { recursive: true });
 await symlink(join(f.cgroup, "missing-target"), join(f.cgroup, "memory.peak"));
 expect((await f.run()).resources).toEqual(unavailable);
});

test("wrapper rejects an unreadable existing peak", async () => {
 const f = await wrapper({ "memory.peak": "4096" }), peak = join(f.cgroup, "memory.peak");
 await chmod(peak, 0o000);
 try { expect((await f.run()).resources).toEqual(unavailable); }
 finally { await chmod(peak, 0o600); }
});

test("wrapper rejects failed cgroup enumeration", async () => {
 const f = await wrapper(); await chmod(f.cgroup, 0o111);
 try { expect((await f.run()).resources).toEqual(unavailable); }
 finally { await chmod(f.cgroup, 0o700); }
});

test("observed resources require CPU and allow an absent peak", () => {
 for (const peakMemoryBytes of [null, 0, 4096]) {
  const observation = { state: "observed" as const, cpuTimeMicros: 100, peakMemoryBytes };
  expect(ResourceObservationSchema.parse(observation)).toEqual(observation);
 }
 for (const state of ["unavailable", "skipped"] as const) {
  expect(ResourceObservationSchema.parse({ ...unavailable, state })).toEqual({ ...unavailable, state });
  expect(ResourceObservationSchema.safeParse({ state, cpuTimeMicros: 100, peakMemoryBytes: null }).success).toBe(false);
 }
 for (const peakMemoryBytes of [null, 0]) expect(ResourceObservationSchema.safeParse({ state: "observed", cpuTimeMicros: null, peakMemoryBytes }).success).toBe(false);
});

import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { RunResult } from "../src/exec.ts";
import { createShadowTestBackend, measureShadowTests, type ShadowComparison, type ShadowMeasurements } from "../src/remote-test/shadow.ts";
import { createShadowFixture } from "./fixtures/remote-test-shadow.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function compare(local: RunResult, remoteSkips: number | null = 0, measurements: (result: RunResult) => ShadowMeasurements | Promise<ShadowMeasurements> = measureShadowTests) {
 const f = await createShadowFixture(root => { roots.push(root); });
 const receipt = { ...f.remote.evidence!.receipt, status: "test_failed" as const, exitCode: 1, coverage: { requiredSkippedTests: remoteSkips } };
 await Bun.write(f.path, JSON.stringify(receipt));
 const reports: ShadowComparison[] = [];
 const backend = createShadowTestBackend(f.selection, {
  remote: { kind: "ssh", run: async () => ({ ...f.remote, result: { code: 1, stdout: "", stderr: "" }, evidence: { ...f.remote.evidence!, receipt } }) },
  measurements,
  write: async report => { reports.push(report); },
 });
 let calls = 0;
 const result = await backend.run(f.request, async () => { calls++; return local; });
 expect(calls).toBe(1);
 expect(backend.kind).toBe("local");
 expect(result.result.code).toBe(local.code);
 expect(result.result.stdout).toBe(local.stdout);
 expect(result.result.stderr).toStartWith(local.stderr);
 expect(result.evidence).toBeUndefined();
 expect(result.shadow?.reportStored).toBe(true);
 expect(reports).toHaveLength(1);
 const report = reports[0];
 expect(report.remote.state).toBe("matched");
 expect(report.authority).toBe("local");
 return { result, report };
}

test("local coverage sums skip and todo lines in every ANSI-stripped Bun summary across both output streams", async () => {
 const local = {
  code: 7, cpuTimeSeconds: 12.5,
  stdout: "bun test v1.3.14\n 8 pass\n 2 skip\n 3 todo\n 0 fail\nRan 13 tests across 2 files.\n",
  stderr: "bun test v1.3.14\n\u001b[32m 4 pass\u001b[0m\n\u001b[33m 5 skip\u001b[0m\n 1 todo\n 1 fail\nRan 11 tests across 3 files.\n",
 };
 const { report } = await compare(local, 11);
 expect(report.local.requiredSkippedTests).toBe(11);
 expect(report.local.laptopCpuSeconds).toBe(12.5);
 expect(report.coverageParity).toBe("same");
});

test.each([
 ["no test summary", ""],
 ["skip and todo without executed test totals", " 2 skip\n 3 todo\n"],
 ["empty summary", " 0 pass\n 0 fail\n 2 skip\n 3 todo\n"],
 ["missing fail total", " 4 pass\n 2 skip\n"],
 ["missing pass total", " 1 fail\n 3 todo\n"],
 ["valid summary followed by an empty one", " 4 pass\n 0 fail\n 0 pass\n 0 fail\n"],
 ["empty summary followed by a valid one", " 0 pass\n 0 fail\n 4 pass\n 0 fail\n"],
])("local coverage stays unknown for %s", async (_label, stderr) => {
 const { report, result } = await compare({ code: 0, stdout: "", stderr });
 expect(report.local.requiredSkippedTests).toBeNull();
 expect(report.coverageParity).toBe("pending");
 expect(result.shadow?.coverageParity).toBe("pending");
});

test.each([
 ["zero skips", " 3 pass\n 0 fail\n", 0, 0, "same"],
 ["different skips", " 0 pass\n 1 fail\n 2 skip\n", 0, 2, "different"],
 ["different todos", " 2 pass\n 0 fail\n 1 todo\n", 2, 1, "different"],
 ["unknown remote", " 3 pass\n 0 fail\n", null, 0, "pending"],
] as const)("known local coverage compares with remote count: %s", async (_label, stderr, remoteSkips, localSkips, parity) => {
 const { report, result } = await compare({ code: 1, stdout: "", stderr }, remoteSkips);
 expect(report.local.requiredSkippedTests).toBe(localSkips);
 expect(report.coverageParity).toBe(parity);
 expect(result.shadow?.coverageParity).toBe(parity);
});

test.each([0, 7])("measurement errors retain a stored pending report and local exit %s", async code => {
 const local = { code, stdout: "original output", stderr: " 3 pass\n 0 fail\n", cpuTimeSeconds: 2.5 };
 for (const measurements of [
  () => { throw Error("private measurement details"); },
  async () => { throw Error("private measurement details"); },
  () => ({ laptopCpuSeconds: 2.5, requiredSkippedTests: NaN }),
 ]) {
  const { report, result } = await compare(local, 0, measurements);
  expect(report.local.requiredSkippedTests).toBeNull();
  expect(report.local.laptopCpuSeconds).toBe(2.5);
  expect(report.coverageParity).toBe("pending");
  expect(result.result.stderr).not.toContain("private measurement details");
 }
});

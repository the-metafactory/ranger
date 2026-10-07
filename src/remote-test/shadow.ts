import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RunResult } from "../exec.ts";
import { privateOperatorPath } from "./baseline.ts";
import { validateJobIdentity, validateRemoteTestReceipt, type RemoteTestReceipt } from "./contract.ts";
import { assertTestSource, createSshTestBackend, runTestBackend, type SshSelection, type TestBackend, type TestRequest, type TestResult } from "./supervisor-backend.ts";

const metric = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().safe();
const pending = null;
export interface ShadowComparison {
 version: 1;
 authority: "local";
 request: Pick<TestRequest, "head" | "repositoryId" | "generation" | "correlationId">;
 local: { code: number; durationMs: number; laptopCpuSeconds: number | null; requiredSkippedTests: number | null; receipt: { identity: RemoteTestReceipt["identity"]; executorId: "ranger-local-shadow"; code: number } | null };
 remote: { state: "matched" | "missing" | "invalid"; refusal: string | null; resultCode: number; receipt: RemoteTestReceipt | null; roundTripMs: number; queueMs: number | null; transferMs: number | null; jobMs: number | null };
 parity: "same" | "different" | "pending";
 coverageParity: "same" | "different" | "pending";
}
export interface ShadowMeasurements { laptopCpuSeconds: number | null; requiredSkippedTests: number | null }

/** Pure attribution comparison. Local observations share the immutable job tuple;
 * they are comparison evidence only, never remote execution/admission authority. */
export function compareShadow(request: TestRequest, local: RunResult, localDurationMs: number, remote: TestResult, roundTripMs: number, measured: ShadowMeasurements = { laptopCpuSeconds: null, requiredSkippedTests: null }): ShadowComparison {
 const observation = z.object({ laptopCpuSeconds: metric.nullable(), requiredSkippedTests: count.nullable() }).strict().parse(measured);
 const report: ShadowComparison = {
  version: 1, authority: "local", request: { head: request.head, repositoryId: request.repositoryId, generation: request.generation, correlationId: request.correlationId },
  local: { code: local.code, durationMs: metric.parse(localDurationMs), ...observation, receipt: null },
  remote: { state: ["invalid_receipt", "source_or_receipt_validation", "revoked"].includes(remote.refusal ?? "") ? "invalid" : "missing", refusal: remote.refusal ?? null, resultCode: remote.result.code, receipt: null, roundTripMs: metric.parse(roundTripMs), queueMs: pending, transferMs: pending, jobMs: pending },
  parity: "pending", coverageParity: "pending",
 };
 if (!remote.evidence) return report;
 try {
  const { job } = remote.evidence, receipt = validateRemoteTestReceipt(remote.evidence.receipt, job);
  if (job.commitDigest !== request.head || job.repositoryId !== request.repositoryId || job.generation !== request.generation || job.correlationId !== request.correlationId ||
      (remote.result.code === 0) !== (receipt.status === "passed")) throw Error("Shadow identity or outcome mismatch");
  report.remote = { ...report.remote, state: "matched", receipt, jobMs: receipt.evidence?.durationMs ?? pending };
  report.parity = receipt.status === (local.code === 0 ? "passed" : "test_failed") && receipt.exitCode === local.code ? "same" : "different";
  const skips = receipt.coverage?.requiredSkippedTests;
  if (skips !== undefined && skips !== null && observation.requiredSkippedTests !== null) report.coverageParity = skips === observation.requiredSkippedTests ? "same" : "different";
  report.local.receipt = { identity: job, executorId: "ranger-local-shadow", code: local.code };
 } catch { report.remote.state = "invalid"; report.remote.receipt = null; report.parity = "pending"; report.coverageParity = "pending"; }
 return report;
}

/** Deliberately local-kind: no remote receipt may enter the supervisor push gate.
 * Reporting failures are visible, but never turn a failed local test into a pass.
 * No raw private transport errors or endpoints are sent to the journal/worker. */
export function createShadowTestBackend(selection: SshSelection, options: {
 remote?: TestBackend; write?: (report: ShadowComparison) => Promise<void>;
 clock?: () => number; measurements?: () => Promise<ShadowMeasurements>;
} = {}): TestBackend {
 const remote = options.remote ?? createSshTestBackend(selection), clock = options.clock ?? (() => performance.now());
 if (remote.kind !== "ssh") throw Error("Shadow requires an SSH comparison backend");
 return { kind: "local", async run(request, local) {
  try { await assertTestSource(request); }
  catch { return { result: { code: 1, stdout: "", stderr: "Shadow source is not the current clean commit; local verification refused." } }; }
  const started = clock(), result = await local(), durationMs = clock() - started;
  const remoteStarted = clock();
  let compared: TestResult;
  try { compared = await runTestBackend(remote, request, async () => { throw Error("Shadow remote cannot run local"); }); }
  catch { compared = { result: { code: 1, stdout: "", stderr: "" } }; }
  let measured: ShadowMeasurements = { laptopCpuSeconds: result.cpuTimeSeconds ?? null, requiredSkippedTests: null };
  let note = "";
  let shadow: NonNullable<TestResult["shadow"]> = { state: "unavailable", parity: "pending", coverageParity: "pending", reportStored: false };
  try { if (options.measurements) measured = await options.measurements(); }
  catch { note = " Measurements pending."; }
  try {
   const report = compareShadow(request, result, durationMs, compared, clock() - remoteStarted, measured);
   if (options.write) await options.write(report);
   else {
    if (!selection.reportRoot) throw Error("Missing reportRoot");
    await writeShadowReport(join(selection.reportRoot, `shadow-${randomUUID()}.json`), report);
   }
   shadow = { state: report.remote.state, parity: report.parity, coverageParity: report.coverageParity, reportStored: true };
   note += ` Shadow comparison: ${report.remote.state}; outcome parity ${report.parity}; coverage parity ${report.coverageParity}.`;
  } catch { note += " Shadow report unavailable; metrics pending."; }
  // Remote work must not let source mutation bypass existing local behavior.
  // A source error is a safety refusal, never a replacement remote test gate.
  try { await assertTestSource(request); }
  catch { return { shadow, result: { ...result, code: result.code === 0 ? 1 : result.code, stderr: `${result.stderr}\nShadow source changed; refusing current local gate.` } }; }
  return { shadow, result: { ...result, stderr: result.stderr + "\nLocal gate authoritative." + note } };
 } };
}

/** All pilot metrics are explicit observations, not estimates from wall time.
 * CPU includes eligible install + test processes; host reserve is measured while
 * the remote job runs; service restarts/OOM are deltas over that job interval. */
const PilotJobSchema = z.object({
 identity: z.unknown().transform(validateJobIdentity),
 source: z.enum(["measured", "fixture"]),
 baselineLaptopCpuSeconds: metric.nullable(), activatedLaptopCpuSeconds: metric.nullable(),
 reservedHostRamBytes: count.nullable(), unexpectedServiceRestarts: count.nullable(), oomEvents: count.nullable(),
 queueMs: metric.nullable(), transferMs: metric.nullable(), jobMs: metric.nullable(),
}).strict();
const PilotSchema = z.object({ version: z.literal(1), jobs: z.array(PilotJobSchema).max(10) }).strict();
type Target = { status: "passed" | "failed" | "pending"; value: number | null };
export function summarizeShadow(input: unknown) {
 const data = PilotSchema.parse(input);
 const identities = data.jobs.map(j => j.identity.jobId);
 if (new Set(identities).size !== identities.length) throw Error("Duplicate pilot jobs");
 const complete = data.jobs.length === 10 && data.jobs.every(j => j.source === "measured");
 const assess = (values: (number | null)[], calculation: (values: number[]) => number, pass: (n: number) => boolean): Target => {
  if (!complete || values.some(v => v === null)) return { status: "pending", value: null };
  const value = calculation(values as number[]);
  return Number.isFinite(value) ? { status: pass(value) ? "passed" : "failed", value } : { status: "pending", value: null };
 };
 const baseline = data.jobs.reduce((s,j) => s + (j.baselineLaptopCpuSeconds ?? 0), 0);
 const cpu = assess(data.jobs.flatMap(j => [j.baselineLaptopCpuSeconds, j.activatedLaptopCpuSeconds]), () => baseline > 0 ? 1 - data.jobs.reduce((s,j) => s + j.activatedLaptopCpuSeconds!, 0) / baseline : NaN, n => n >= 0.8);
 const safety = (field: "reservedHostRamBytes" | "unexpectedServiceRestarts" | "oomEvents", calc: (values: number[]) => number, pass: (n: number) => boolean): Target => {
  const observed = data.jobs.filter(j => j.source === "measured" && j[field] !== null).map(j => j[field]!);
  if (observed.length && !pass(calc(observed))) return { status: "failed", value: calc(observed) };
  return assess(data.jobs.map(j => j[field]), calc, pass);
 };
 const reserve = safety("reservedHostRamBytes", v => Math.min(...v), n => n >= 1024 ** 3);
 const restarts = safety("unexpectedServiceRestarts", v => v.reduce((a,b) => a+b,0), n => n === 0);
 const oom = safety("oomEvents", v => v.reduce((a,b) => a+b,0), n => n === 0);
 return { version: 1, authority: "local", jobs: data.jobs, jobCount: data.jobs.length, targets: { laptopCpuReduction: cpu, reservedHostRam: reserve, unexpectedServiceRestarts: restarts, oomEvents: oom },
  status: [cpu,reserve,restarts,oom].some(t => t.status === "failed") ? "failed" : [cpu,reserve,restarts,oom].every(t => t.status === "passed") ? "passed" : "pending" };
}

/** Refuse repository destinations, symlink roots and non-private directories.
 * Exclusive file creation prevents overwriting earlier operator evidence. */
export async function writeShadowReport(path: string, report: unknown): Promise<void> {
 const destination = await privateOperatorPath(path);
 const parent = join(destination, "..");
 const info = await lstat(parent);
 if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw Error("Shadow reports require a private operator directory");
 const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
 try { await file.writeFile(JSON.stringify(report, null, 2) + "\n"); await file.sync(); }
 finally { await file.close(); }
}

/** POSIX time supplies child-process CPU (including descendants), never wall-time
 * estimates or the supervisor process resourceUsage. Missing footer stays pending. */
export function readShadowCpu(result: RunResult): RunResult {
 const footer = /real[ \t]+([0-9]+(?:\.[0-9]+)?)\nuser[ \t]+([0-9]+(?:\.[0-9]+)?)\nsys[ \t]+([0-9]+(?:\.[0-9]+)?)\s*$/.exec(result.stderr);
 if (!footer) return result;
 const cpuTimeSeconds = Number(footer[2]) + Number(footer[3]);
 return Number.isFinite(cpuTimeSeconds) ? { ...result, cpuTimeSeconds, stderr: result.stderr.slice(0, footer.index) } : result;
}

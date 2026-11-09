import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd, type RunResult } from "../src/exec.ts";
import * as github from "../src/github.ts";
import { GitHubError } from "../src/github.ts";
import { readGraphqlBudget } from "../src/budget.ts";
import { readRepoSentinel } from "../src/frontier-cache.ts";
import { configureGitHubUsage, githubUsageDirectory, meteredGh, meteredOpaque, MAX_DAY_BYTES, RETENTION_DAYS } from "../src/github-usage.ts";
import { buildUsageReport, parsePeriodStart, renderUsageReport, type WindowReport } from "../src/github-usage-report.ts";
import { sageReview } from "../src/review.ts";
import { runReadRetryingTransient } from "../src/transient.ts";
import { bun, cliPath, fixturesBin, testCliEnv } from "./support.ts";

const SENTINEL_CREDENTIAL = "sentinel-credential-value";
const WINDOW_RESET = Math.floor(Date.parse("2026-11-08T22:00:00Z") / 1000);
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 10, 8, 21, minute, second)).toISOString();

let dir: string;
let usageDir: string;
const originalPath = process.env.PATH;

interface FakeResponse {
 status?: number;
 headers?: string;
 body: string;
 stderr?: string;
 exit?: number;
}

function fakeGh(responses: Record<string, FakeResponse>): string {
 const budgetFile = join(dir, "remaining");
 writeFileSync(budgetFile, "4000");
 const calls = join(dir, "calls.jsonl");
 writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const key = Object.keys(responses).find((k) => args[1].includes(k));
if (key === undefined) { console.error("fake gh: unhandled " + args[1]); process.exit(96); }
const r = responses[key];
const remaining = Number(readFileSync(${JSON.stringify(budgetFile)}, "utf8")) - 1;
writeFileSync(${JSON.stringify(budgetFile)}, String(remaining));
if (args.includes("--include") || args.includes("-i")) {
 process.stdout.write("HTTP/2.0 " + (r.status ?? 200) + " Status\\n");
 process.stdout.write("Access-Control-Allow-Origin: *\\r\\n" + (r.headers ?? "X-Ratelimit-Limit: 5000\\r\\nX-Ratelimit-Remaining: " + remaining + "\\r\\nX-Ratelimit-Reset: ${WINDOW_RESET}\\r\\nX-Ratelimit-Resource: core\\r\\n") + "\\r\\n");
}
process.stdout.write(r.body);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.exit ?? 0);
`);
 chmodSync(join(dir, "gh"), 0o755);
 process.env.PATH = `${dir}:${originalPath}`;
 return calls;
}

function recorded(): Record<string, unknown>[] {
 if (!existsSync(usageDir)) return [];
 return readdirSync(usageDir).flatMap((f) =>
  readFileSync(join(usageDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}

function seed(day: string, records: Record<string, unknown>[]): void {
 mkdirSync(usageDir, { recursive: true });
 writeFileSync(join(usageDir, `${day}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const call = (minute: number, component: string, remaining: number, extra: Record<string, unknown> = {}) => ({
 kind: "call", at: at(minute), component, endpoint: "GET pulls/:id", source: "RANGER_READONLY_A", command: "tick",
 resource: "core", status: 200, limit: 5000, remaining, reset: WINDOW_RESET, ...extra,
});
const opaque = (fromMinute: number, toMinute: number, component: string, extra: Record<string, unknown> = {}) => ({
 kind: "opaque", at: at(fromMinute), endedAt: at(toMinute), component, source: "RANGER_READONLY_A", command: "tick", ...extra,
});
const recordBeganEarlier = () => seed("2026-11-07", [{ ...call(0, "token-gate", 5000), at: "2026-11-07T00:00:00Z", reset: 1 }]);
const period = { since: new Date(at(0)), until: new Date(at(59)) };
const everything = () => buildUsageReport(usageDir, new Date(0), new Date(Date.now() + 60_000));
const onlyWindow = (): WindowReport => {
 const { windows } = buildUsageReport(usageDir, period.since, period.until);
 expect(windows.length).toBe(1);
 return windows[0];
};
const openPr = { body: '{"number":7,"state":"open","head":{"ref":"b","sha":"abc"},"base":{"ref":"main"}}' };

beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-usage-"));
 usageDir = githubUsageDirectory(join(dir, "state.sqlite"));
 configureGitHubUsage({ directory: usageDir, command: "tick" });
});

afterEach(() => {
 configureGitHubUsage(null);
 process.env.PATH = originalPath;
 rmSync(dir, { recursive: true, force: true });
});

describe("recording ranger's own calls", () => {
 test("a burst is attributed to the components that made it, with headers stripped from what callers see", async () => {
  fakeGh({
   "pulls/7": openPr,
   "issues/events": { body: "99\n" },
   "issues?": { body: "2026-01-01T00:00:00Z\n" },
  });
  for (let i = 0; i < 3; i++) {
   expect((await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL)).iid).toBe(7);
  }
  expect(await readRepoSentinel("acme/widgets", SENTINEL_CREDENTIAL, "RANGER_READONLY_A")).toBe("2026-01-01T00:00:00Z|99");

  const report = everything();
  expect(report.spenders.map((s) => [s.component, s.source, s.calls])).toEqual([
   ["forge-port", "write-token", 3],
   ["frontier-sentinel", "RANGER_READONLY_A", 2],
  ]);
  expect(report.spenders[0].endpoints[0]).toEqual({ endpoint: "GET pulls/:id", calls: 3 });
  expect(recorded()[0]).toMatchObject({ kind: "call", command: "tick", resource: "core", status: 200, limit: 5000, reset: WINDOW_RESET });
 });

 test("the record holds no token value, no response headers and no repo name", async () => {
  fakeGh({ "pulls/7": openPr });
  await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL);
  const raw = readdirSync(usageDir).map((f) => readFileSync(join(usageDir, f), "utf8")).join("");
  expect(raw.length).toBeGreaterThan(0);
  expect(raw).not.toContain(SENTINEL_CREDENTIAL);
  expect(raw).not.toContain("Access-Control");
  expect(raw).not.toContain("acme/widgets");
 });

 test("paginated pages are each counted, and the slurped JSON still parses", async () => {
  const block = (remaining: number) => `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: ${WINDOW_RESET}\r\nX-Ratelimit-Resource: core\r\n\r\n`;
  const stdout = `[${block(10)}[{"id":1,"body":"HTTP/2.0 200 inside a string"}]\n,${block(9)}[{"id":2,"body":"b"}]\n]\n`;
  const base = (): Promise<RunResult> => Promise.resolve({ code: 0, stdout, stderr: "" });
  const result = await meteredGh({ component: "forge-port", source: "write-token" }, base)("gh", ["api", "repos/a/b/issues/1/comments?per_page=100", "--paginate", "--slurp"], {});
  expect(JSON.parse(result.stdout)).toEqual([[{ id: 1, body: "HTTP/2.0 200 inside a string" }], [{ id: 2, body: "b" }]]);
  expect(recorded().map((r) => [r.endpoint, r.remaining])).toEqual([["GET issues/:id/comments", 10], ["GET issues/:id/comments", 9]]);
 });

 test("a caller's own --include keeps its headers, and is not doubled", async () => {
  const calls = fakeGh({ "git/refs": { status: 204, body: "" } });
  await github.deleteBranch("acme/widgets", "feature-x", SENTINEL_CREDENTIAL);
  const args = JSON.parse(readFileSync(calls, "utf8").trim()) as string[];
  expect(args.filter((a) => a === "--include").length).toBe(1);
  expect(recorded()[0]).toMatchObject({ endpoint: "DELETE git/refs/heads/:ref", status: 204 });
 });

 test("a retried read counts every attempt, and a 429 is not retried because of the added headers", async () => {
  let attempts = 0;
  const flaky = (): Promise<RunResult> => {
   attempts++;
   return Promise.resolve(attempts === 1
    ? { code: 1, stdout: "HTTP/2.0 502 Bad\nX-Ratelimit-Remaining: 9\r\nX-Ratelimit-Resource: core\r\n\r\n", stderr: "gh: HTTP 502" }
    : { code: 0, stdout: "HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 8\r\nX-Ratelimit-Resource: core\r\n\r\n{}", stderr: "" });
  };
  const ok = await runReadRetryingTransient("gh", ["api", "x"], {}, { backoffMs: [0], runner: meteredGh({ component: "forge-port", source: "write-token" }, flaky) });
  expect(ok.stdout).toBe("{}");
  expect(recorded().length).toBe(2);

  let refused = 0;
  const limited = (): Promise<RunResult> => {
   refused++;
   return Promise.resolve({ code: 1, stdout: "HTTP/2.0 429 Too Many\nRetry-After: 60\r\nX-Ratelimit-Remaining: 7\r\nX-Ratelimit-Resource: core\r\n\r\n{}", stderr: "gh: too many (HTTP 429)" });
  };
  await runReadRetryingTransient("gh", ["api", "x"], {}, { backoffMs: [0], runner: meteredGh({ component: "forge-port", source: "write-token" }, limited) });
  expect(refused).toBe(1);
 });

 test("the free /rate_limit read is a sample of both resources, never a charged call", async () => {
  fakeGh({ rate_limit: { body: `{"limit":5000,"remaining":4800,"reset":${WINDOW_RESET + 7},"used":200}\n` } });
  const budget = await readGraphqlBudget(SENTINEL_CREDENTIAL, "RANGER_READONLY_A");
  expect(budget?.remaining).toBe(4800);
  const records = recorded();
  expect(records.every((r) => r.kind === "gauge")).toBe(true);
  expect(records.map((r) => r.resource).sort()).toEqual(["core", "graphql"]);
  expect(everything().spenders).toEqual([]);
 });

 test("a plain --paginate keeps gh's merged pages: no added --include, one call of unknown cost", async () => {
  const seen: string[][] = [];
  const base = (_bin: string, args: string[]): Promise<RunResult> => {
   seen.push(args);
   return Promise.resolve({ code: 0, stdout: "[1,2]", stderr: "" });
  };
  const result = await meteredGh({ component: "forge-port", source: "write-token" }, base)("gh", ["api", "repos/a/b/pulls", "--paginate"], {});
  expect(result.stdout).toBe("[1,2]");
  expect(seen).toEqual([["api", "repos/a/b/pulls", "--paginate"]]);
  expect(recorded().map((r) => [r.endpoint, r.status])).toEqual([["GET pulls", undefined]]);
 });

 test("a branch, a repo and a comparison never reach an endpoint label", async () => {
  const base = (): Promise<RunResult> => Promise.resolve({ code: 0, stdout: "", stderr: "" });
  const metered = meteredGh({ component: "c", source: "s" }, base);
  await metered("gh", ["api", "repos/acme/widgets"], {});
  await metered("gh", ["api", "repos/acme/widgets/compare/secret-branch...abc?per_page=1"], {});
  await metered("gh", ["api", "https://api.github.com/repos/acme/widgets/check-runs/9", "--method", "PATCH", "--hostname", "api.github.com"], {});
  await metered("gh", ["api", "graphql", "-f", "query=mutation"], {});
  expect(recorded().map((r) => r.endpoint)).toEqual(["GET repos/:repo", "GET compare/:arg", "PATCH check-runs/:id", "POST graphql"]);
 });

 test("a sage run is on the record under the source of the token it reviews with", async () => {
  await sageReview("acme/widgets", 7, SENTINEL_CREDENTIAL, { command: "/usr/bin/false", substrate: "claude", tokenSource: "RANGER_READONLY_A" }).catch(() => undefined);
  expect(recorded().map((r) => [r.kind, r.component, r.source])).toEqual([["opaque", "sage-review", "RANGER_READONLY_A"]]);
 });

 test("a ranger command records its calls and soma runs beside its journal", async () => {
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, `version: 1\nmaps:\n  - repo: acme/widgets\n    root: 1\n    walk: full\nstate:\n  journalPath: ${join(dir, "state.sqlite")}\nauth:\n  readOnlyTokens:\n    "acme/*": RANGER_READONLY_A\n`);
  const env = { ...process.env, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, FAKE_SOMA_DIR: join(import.meta.dir, "fixtures", "data"), GH_SCOPES: "", RANGER_READONLY_A: SENTINEL_CREDENTIAL };
  const scout = await runCmd(bun, [cliPath, "scout", "-c", configPath, "--json"], { env: testCliEnv(env) });
  expect(scout.code).toBe(0);
  const records = recorded();
  expect(records.find((r) => r.component === "token-gate")).toMatchObject({ kind: "call", source: "RANGER_READONLY_A", command: "scout" });
  expect(records.some((r) => r.kind === "opaque" && r.component === "soma-graph-frontier")).toBe(true);
  expect(JSON.stringify(records)).not.toContain(SENTINEL_CREDENTIAL);
 });

 test("with no record configured, the call is exactly what it was", async () => {
  configureGitHubUsage(null);
  const calls = fakeGh({ "pulls/7": openPr });
  await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL);
  expect(JSON.parse(readFileSync(calls, "utf8").trim())).toEqual(["api", "repos/acme/widgets/pulls/7"]);
 });
});

describe("refusals", () => {
 test("a secondary refusal with budget left is recorded as a refusal, and the caller still gets the same failure", async () => {
  fakeGh({ "pulls/7": {
   status: 403,
   headers: `Retry-After: 60\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4200\r\nX-Ratelimit-Reset: ${WINDOW_RESET}\r\nX-Ratelimit-Resource: core\r\n`,
   body: '{"message":"You have exceeded a secondary rate limit"}',
   stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)\n",
   exit: 1,
  } });
  const failure = await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(GitHubError);
  expect((failure as Error).message).toContain("secondary rate limit");
  expect((failure as Error).message).not.toContain("Ratelimit");

  const report = everything();
  expect(report.refusals.map((r) => [r.component, r.refusal, r.resource, r.remaining])).toEqual([["forge-port", "secondary", "core", 4200]]);
  const text = renderUsageReport(report);
  expect(text).toContain("secondary");
  expect(text).toContain("4200 left");
 });

 test("a spent window is a primary refusal, and a plain 403 is not a refusal at all", async () => {
  fakeGh({
   "pulls/7": { status: 403, headers: `X-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: ${WINDOW_RESET}\r\nX-Ratelimit-Resource: core\r\n`, body: "{}", stderr: "gh: API rate limit exceeded for user (HTTP 403)\n", exit: 1 },
   "pulls/8": { status: 403, body: "{}", stderr: "gh: Resource not accessible (HTTP 403)\n", exit: 1 },
  });
  await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL).catch(() => undefined);
  await github.getPr("acme/widgets", 8, SENTINEL_CREDENTIAL).catch(() => undefined);
  const records = recorded();
  expect(records[0].refusal).toBe("primary");
  expect(records[1].refusal).toBeUndefined();
 });

 test("a refusal a subprocess reports is on the record, though its calls are not countable", async () => {
  const soma = (): Promise<RunResult> => Promise.resolve({ code: 1, stdout: "", stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)" });
  await meteredOpaque({ component: "soma-graph-read", source: "RANGER_READONLY_A" }, soma)("soma", ["graph", "frontier"], {});
  const report = everything();
  expect(report.opaque.map((o) => [o.component, o.runs, o.refused])).toEqual([["soma-graph-read", 1, 1]]);
  expect(report.refusals[0]).toMatchObject({ component: "soma-graph-read", refusal: "secondary" });
 });
});

describe("tracing spend from the record alone", () => {
 test("a chosen period filters the ranking", () => {
  seed("2026-11-08", [call(5, "token-gate", 4990), call(50, "forge-port", 4980), call(51, "forge-port", 4979)]);
  const early = buildUsageReport(usageDir, new Date(at(0)), new Date(at(10)));
  expect(early.spenders.map((s) => [s.component, s.calls])).toEqual([["token-gate", 1]]);
  const late = buildUsageReport(usageDir, new Date(at(40)), new Date(at(59)));
  expect(late.spenders.map((s) => [s.component, s.calls])).toEqual([["forge-port", 2]]);
 });

 test("a period across a UTC midnight reads both day files", () => {
  seed("2026-11-08", [{ ...call(0, "token-gate", 10), at: "2026-11-08T23:59:00Z" }]);
  seed("2026-11-09", [{ ...call(0, "forge-port", 9), at: "2026-11-09T00:01:00Z" }]);
  const report = buildUsageReport(usageDir, new Date("2026-11-08T23:00:00Z"), new Date("2026-11-09T01:00:00Z"));
  expect(report.spenders.map((s) => s.component).sort()).toEqual(["forge-port", "token-gate"]);
 });

 test("the budget falling by more than ranger's calls, with nothing of ranger running, is outside spend", () => {
  recordBeganEarlier();
  seed("2026-11-08", [call(10, "token-gate", 4000), call(20, "token-gate", 3700)]);
  const window = onlyWindow();
  expect(window.used).toBe(1300);
  expect(window.recordedCalls).toBe(2);
  expect(window.outsideRanger).toBe(1298);
  expect(window.duringOpaque).toEqual({});
 });

 test("spend during a soma run is put to that run, not called outside", () => {
  recordBeganEarlier();
  seed("2026-11-08", [call(0, "token-gate", 5000), opaque(10, 12, "soma-graph-read"), call(15, "token-gate", 4700)]);
  const window = onlyWindow();
  expect(window.duringOpaque).toEqual({ "soma-graph-read": 299 });
  expect(window.outsideRanger).toBe(0);
 });

 test("a short run in a long gap gets the whole gap, and the report calls that an upper bound", () => {
  recordBeganEarlier();
  seed("2026-11-08", [call(0, "token-gate", 5000), { ...opaque(10, 10, "soma-graph-read"), endedAt: at(10, 1) }, call(50, "token-gate", 4000)]);
  expect(onlyWindow().duringOpaque).toEqual({ "soma-graph-read": 999 });
  const text = renderUsageReport(buildUsageReport(usageDir, period.since, period.until));
  expect(text).toContain("at most 999 during soma-graph-read");
  expect(text).toContain("upper bound");
 });

 test("overlapping runs each get the gap, so a short run inside a long one keeps a true upper bound", () => {
  recordBeganEarlier();
  seed("2026-11-08", [call(0, "token-gate", 5000), opaque(5, 40, "sage-review"), { ...opaque(10, 10, "soma-graph-read"), endedAt: at(10, 1) }, call(50, "token-gate", 4000)]);
  const window = onlyWindow();
  expect(window.duringOpaque).toEqual({ "sage-review": 999, "soma-graph-read": 999 });
  expect(window.outsideRanger).toBe(0);
 });

 test("spend with no run going is not called outside everything ranger started, in text or JSON", () => {
  recordBeganEarlier();
  seed("2026-11-08", [call(0, "token-gate", 5000), call(15, "token-gate", 4700)]);
  const report = buildUsageReport(usageDir, period.since, period.until);
  expect(renderUsageReport(report)).toContain("with no soma or sage run going 299");
  expect(renderUsageReport(report)).toContain("a worker's own gh");
  expect(report.caveats.join(" ")).toContain("a worker's own gh");
 });

 test("a day past the engine's argument limit still reports", () => {
  const lines = Array.from({ length: 70_000 }, (_, i) => call(0, "forge-port", 5000 - (i % 5000)));
  seed("2026-11-08", lines);
  expect(buildUsageReport(usageDir, period.since, period.until).spenders[0].calls).toBe(70_000);
 });

 test("a run under another account's token does not explain this window's spend", () => {
  recordBeganEarlier();
  seed("2026-11-08", [
   call(0, "token-gate", 5000),
   call(1, "forge-port", 4000, { source: "write-token", reset: WINDOW_RESET + 900 }),
   opaque(10, 12, "soma-graph-write", { source: "write-token" }),
   call(15, "token-gate", 4700),
  ]);
  const { windows } = buildUsageReport(usageDir, period.since, period.until);
  const principal = windows.find((w) => w.sources.includes("RANGER_READONLY_A"));
  expect(principal?.outsideRanger).toBe(299);
  expect(principal?.duringOpaque).toEqual({});
 });

 test("two tokens that share one account's budget are one window, so neither reads as outside the other", () => {
  recordBeganEarlier();
  seed("2026-11-08", [
   call(1, "token-gate", 5000),
   call(2, "serve-read", 4999, { source: "RANGER_READONLY_B" }),
   call(3, "token-gate", 4998),
  ]);
  const window = onlyWindow();
  expect(window.sources).toEqual(["RANGER_READONLY_A", "RANGER_READONLY_B"]);
  expect(window.outsideRanger).toBe(0);
 });

 test("spend before the record began is not called outside", () => {
  seed("2026-11-08", [call(30, "token-gate", 3000), call(31, "token-gate", 2999)]);
  const window = onlyWindow();
  expect(window.beforeRecordBegan).toBe(1999);
  expect(window.outsideRanger).toBe(0);
 });

 test("an exhausted window names its top spenders", () => {
  recordBeganEarlier();
  seed("2026-11-08", [
   call(1, "token-gate", 3),
   call(2, "forge-port", 2),
   call(3, "forge-port", 1),
   call(4, "forge-port", 0, { status: 403, refusal: "primary" }),
  ]);
  const report = buildUsageReport(usageDir, period.since, period.until);
  const [window] = report.windows;
  expect(window.exhausted).toBe(true);
  expect(window.topSpenders[0]).toEqual({ component: "forge-port", calls: 3 });
  const text = renderUsageReport(report);
  expect(text).toContain("EXHAUSTED");
  expect(text).toContain("forge-port 3");
 });

 test("a graphql and a core window stay apart", () => {
  seed("2026-11-08", [call(1, "token-gate", 4000), { kind: "gauge", at: at(2), component: "budget-gate", source: "RANGER_READONLY_A", resource: "graphql", limit: 5000, remaining: 300, reset: WINDOW_RESET }]);
  const { windows } = buildUsageReport(usageDir, period.since, period.until);
  expect(windows.map((w) => w.resource).sort()).toEqual(["core", "graphql"]);
 });
});

describe("bounds and failures", () => {
 test("a recording failure never breaks the forge call, and is said once", async () => {
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "a file where the directory should be");
  const notices: string[] = [];
  configureGitHubUsage({ directory: blocked, command: "tick", notice: (line) => notices.push(line) });
  fakeGh({ "pulls/7": openPr });
  expect((await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL)).iid).toBe(7);
  expect((await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL)).iid).toBe(7);
  expect(notices.length).toBe(1);
  expect(notices[0]).toContain("GitHub usage");
 });

 test("day files past the retention are pruned on the first write of a process", async () => {
  mkdirSync(usageDir, { recursive: true });
  const old = new Date(Date.now() - (RETENTION_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
  const recent = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(usageDir, `${old}.jsonl`), "");
  writeFileSync(join(usageDir, `${recent}.jsonl`), "");
  writeFileSync(join(usageDir, "unrelated.txt"), "");
  fakeGh({ "pulls/7": openPr });
  await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL);
  const files = readdirSync(usageDir);
  expect(files).not.toContain(`${old}.jsonl`);
  expect(files).toContain(`${recent}.jsonl`);
  expect(files).toContain("unrelated.txt");
 });

 test("a day file at the cap stops growing, and the report says the day is incomplete", async () => {
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(join(usageDir, `${today}.jsonl`), `${"x".repeat(MAX_DAY_BYTES)}\n`);
  fakeGh({ "pulls/7": openPr });
  await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL);
  await github.getPr("acme/widgets", 7, SENTINEL_CREDENTIAL);
  const size = readFileSync(join(usageDir, `${today}.jsonl`)).length;
  expect(size).toBeLessThan(MAX_DAY_BYTES + 200);
  const report = buildUsageReport(usageDir, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  expect(report.cappedDays).toEqual([today]);
  expect(report.malformedLines).toBe(1);
  expect(renderUsageReport(report)).toContain(today);
 });
});

describe("the operator command", () => {
 test("parsePeriodStart takes a duration or a timestamp, and refuses anything else", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  expect(parsePeriodStart("90m", now).toISOString()).toBe("2026-11-09T10:30:00.000Z");
  expect(parsePeriodStart("2d", now).toISOString()).toBe("2026-11-07T12:00:00.000Z");
  expect(parsePeriodStart("2026-11-08T00:00:00Z", now).toISOString()).toBe("2026-11-08T00:00:00.000Z");
  expect(() => parsePeriodStart("yesterday", now)).toThrow("--since");
 });

 test("ranger budget ranks spenders for a period, and --json carries the same report", async () => {
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, `state:\n  journalPath: ${join(dir, "state.sqlite")}\nmaps:\n  - repo: acme/widgets\n    root: 1\n    walk: full\n`);
  seed("2026-11-08", [call(5, "token-gate", 4990, { reset: WINDOW_RESET - 3600 }), call(50, "forge-port", 4980), call(51, "forge-port", 4979)]);
  const args = [cliPath, "budget", "-c", configPath, "--since", at(40), "--until", at(59)];
  const text = await runCmd(bun, args, { env: testCliEnv(process.env) });
  expect(text.stderr).toBe("");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("forge-port");
  expect(text.stdout).not.toContain("token-gate");
  const json = await runCmd(bun, [...args, "--json"], { env: testCliEnv(process.env) });
  expect((JSON.parse(json.stdout) as { spenders: { component: string; calls: number }[] }).spenders[0]).toMatchObject({ component: "forge-port", calls: 2 });
  const bad = await runCmd(bun, [cliPath, "budget", "-c", configPath, "--since", "yesterday"], { env: testCliEnv(process.env) });
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("--since");
 });

 test("an empty record says so", () => {
  expect(renderUsageReport(buildUsageReport(usageDir, period.since, period.until))).toContain("no GitHub use recorded");
 });
});

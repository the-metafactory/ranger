import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { openJournal, type SubstrateReading } from "../src/journal.ts";
import { baseConfigLines, cliPath, testCliEnv } from "./support.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const request = { version: 1, permitted: ["claude", "codex", "pi"], attempted: [], parserCapable: ["claude", "codex", "pi"] };

function fixture(configured: readonly string[] = ["claude", "codex", "pi"]) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-selection-"));
 roots.push(dir);
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, [...baseConfigLines(dir), "selection:", `  substrates: ${JSON.stringify(configured)}`].join("\n"));
 const { config } = loadConfig(path);
 const journal = openJournal(config);
 journal.close();
 const bin = join(dir, "bin");
 mkdirSync(bin);
 const calls = join(dir, "calls");
 for (const name of ["claude", "codex", "pi"]) {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${calls}'\nexit 1\n`);
  chmodSync(file, 0o755);
 }
 return { dir, path, bin, calls, config };
}

function seed(f: ReturnType<typeof fixture>, substrate: SubstrateReading["substrate"], over: Partial<SubstrateReading> = {}) {
 const journal = openJournal(f.config);
 journal.upsertSubstrateReading({ substrate, readAt: new Date().toISOString(), fiveHourUsedPct: 10, sevenDayUsedPct: 10,
  fiveHourResetsAt: null, sevenDayResetsAt: null, resetsAt: null, capped: false, cappedUntil: null, ...over });
 journal.close();
}

async function invoke(f: ReturnType<typeof fixture>, input: unknown = request, raw?: string) {
 const child = Bun.spawn([process.execPath, cliPath, "select-substrate", "--config", f.path], {
  cwd: f.dir,
  env: testCliEnv({ ...process.env, PATH: `${f.bin}:${process.env.PATH ?? ""}`, RANGER_JOURNAL_PATH: f.config.state.journalPath }),
  stdin: new TextEncoder().encode(raw ?? JSON.stringify(input)), stdout: "pipe", stderr: "pipe",
 });
 const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
 return { stdout, stderr, code, result: JSON.parse(stdout) };
}

test("public CLI routes exhausted Claude to Codex without a provider process for fresh readings", async () => {
 const f = fixture();
 seed(f, "claude", { capped: true });
 seed(f, "codex");
 const out = await invoke(f);
 expect(out.code).toBe(0);
 expect(out.stderr).toBe("");
 expect(out.result).toMatchObject({ version: 1, kind: "selected", substrate: "codex", reason: "most-headroom" });
 expect(out.result.candidates).toContainEqual({ substrate: "claude", reason: "capped" });
 expect(existsSync(f.calls)).toBe(false);
 const journal = openJournal(f.config);
 expect(journal.listSubstrateReadings()).toHaveLength(2);
 expect(journal.listSubstrateSessions(new Date(0))).toHaveLength(0);
 journal.close();
});

test("eligible Pi is the fallback when both strong providers are exhausted", async () => {
 const f = fixture();
 seed(f, "claude", { capped: true });
 seed(f, "codex", { fiveHourUsedPct: 99 });
 expect((await invoke(f)).result).toMatchObject({ kind: "selected", substrate: "pi", reason: "pi-fallback" });
 expect(existsSync(f.calls)).toBe(false);
});

test("headroom and active caps reuse Ranger policy; prior attempts narrow eligible strong providers", async () => {
 const f = fixture();
 seed(f, "claude", { fiveHourUsedPct: 5 });
 seed(f, "codex", { fiveHourUsedPct: 50 });
 expect((await invoke(f)).result.substrate).toBe("claude");
 expect((await invoke(f, { ...request, attempted: ["claude"] })).result.substrate).toBe("codex");
 seed(f, "claude", { cappedUntil: new Date(Date.now() + 60_000).toISOString() });
 expect((await invoke(f)).result.substrate).toBe("codex");
 expect(existsSync(f.calls)).toBe(false);
});

test("configured strong providers restrict both selection and refresh", async () => {
 const f = fixture(["codex"]);
 seed(f, "claude", { fiveHourUsedPct: 0 });
 seed(f, "codex", { fiveHourUsedPct: 50 });
 expect((await invoke(f)).result.substrate).toBe("codex");
 expect(existsSync(f.calls)).toBe(false);
});

test("public CLI refreshes Codex through account/rateLimits/read only", async () => {
 const f = fixture(["codex"]);
 writeFileSync(join(f.bin, "codex"), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { createInterface } from 'node:readline';\nif (process.argv.slice(2).join(' ') !== 'app-server') process.exit(99);\nconst allowed = ['initialize', 'initialized', 'account/rateLimits/read'];\nfor await (const line of createInterface({ input: process.stdin })) {\n const message = JSON.parse(line);\n if (!allowed.includes(message.method)) process.exit(99);\n appendFileSync(${JSON.stringify(f.calls)}, message.method + '\\n');\n if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: null, rateLimitReachedType: null } } }) + '\\n');\n}\n`);
 expect((await invoke(f)).result).toMatchObject({ kind: "selected", substrate: "codex" });
 expect(readFileSync(f.calls, "utf8").trim().split("\n")).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
});

test.each([
 { label: "not configured", configured: ["claude", "codex"], input: request, reason: "not-configured" },
 { label: "not permitted", configured: ["pi"], input: { ...request, permitted: ["codex"] }, reason: "not-permitted" },
 { label: "parser incapable", configured: ["pi"], input: { ...request, parserCapable: ["claude", "codex"] }, reason: "parser-incapable" },
 { label: "already attempted", configured: ["pi"], input: { ...request, attempted: ["pi"] }, reason: "already-attempted" },
])("Pi cannot escape restrictions: $label", async ({ configured, input, reason }) => {
 const f = fixture(configured);
 seed(f, "claude", { capped: true });
 seed(f, "codex", { capped: true });
 const out = await invoke(f, input);
 expect(out.result).toMatchObject({ kind: "unavailable", reason: "no-eligible-substrate" });
 expect(out.result.candidates).toContainEqual({ substrate: "pi", reason });
 expect(existsSync(f.calls)).toBe(false);
});

test("all attempted and empty permitted requests return unavailable without refreshing", async () => {
 const f = fixture();
 for (const input of [{ ...request, attempted: ["claude", "codex", "pi"] }, { ...request, permitted: [] }]) {
  expect((await invoke(f, input)).result.kind).toBe("unavailable");
 }
 expect(existsSync(f.calls)).toBe(false);
});

test("missing and stale readings fail closed when quota refresh fails", async () => {
 const f = fixture(["claude", "codex"]);
 seed(f, "claude", { readAt: "2000-01-01T00:00:00Z" });
 const out = await invoke(f);
 expect(out.result.kind).toBe("unavailable");
 expect(out.result.candidates).toContainEqual({ substrate: "claude", reason: "stale-reading" });
 expect(out.result.candidates).toContainEqual({ substrate: "codex", reason: "missing-reading" });
 expect(readFileSync(f.calls, "utf8").trim().split("\n").sort()).toEqual(["claude", "codex"]);
});

test("only configured permitted capable unattempted providers are refreshed", async () => {
 const f = fixture();
 expect((await invoke(f, { ...request, permitted: ["claude"], attempted: ["claude"] })).result.kind).toBe("unavailable");
 expect(existsSync(f.calls)).toBe(false);
});

test("a disallowed or parser-incapable strong provider cannot win on headroom", async () => {
 const f = fixture();
 seed(f, "claude", { fiveHourUsedPct: 0 });
 seed(f, "codex", { fiveHourUsedPct: 50 });
 for (const input of [{ ...request, permitted: ["codex"] }, { ...request, parserCapable: ["codex"] }]) {
  expect((await invoke(f, input)).result.substrate).toBe("codex");
 }
 expect(existsSync(f.calls)).toBe(false);
});

test("stdin must finish within the bounded request deadline", async () => {
 const f = fixture();
 const child = Bun.spawn([process.execPath, cliPath, "select-substrate", "--config", f.path], {
  cwd: f.dir, env: testCliEnv(process.env), stdin: "pipe", stdout: "pipe", stderr: "pipe",
 });
 child.stdin.write('{"version":1');
 const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
 expect(code).toBe(2);
 expect(JSON.parse(stdout).reason).toBe("invalid-request");
 expect(stderr).toContain("timed out");
 expect(existsSync(f.calls)).toBe(false);
}, 15_000);

test("public CLI refreshes Claude through its existing quota reader, without parsing or executing work", async () => {
 const f = fixture(["claude"]);
 writeFileSync(join(f.bin, "claude"), `#!/bin/sh\n[ "$*" = '-p ok --model haiku --output-format stream-json --verbose' ] || exit 99\nprintf '%s\\n' 'quota-only' >> '${f.calls}'\nprintf '%s\\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.1}}}}'\n`);
 expect((await invoke(f)).result).toMatchObject({ kind: "selected", substrate: "claude" });
 expect(readFileSync(f.calls, "utf8")).toBe("quota-only\n");
 const journal = openJournal(f.config);
 expect(journal.getSubstrateReading("claude")?.fiveHourUsedPct).toBe(10);
 expect(journal.listSubstrateSessions(new Date(0))).toHaveLength(0);
 journal.close();
});

test.each([
 { ...request, version: 2 }, { ...request, permitted: ["unknown"] }, { ...request, extra: true },
 { version: 1, permitted: ["pi"], attempted: [] }, null, [],
].map(input => ({ input })))("malformed request fails closed before quota access: %j", async ({ input }) => {
 const f = fixture();
 const out = await invoke(f, input);
 expect(out.code).toBe(2);
 expect(out.result).toMatchObject({ kind: "unavailable", reason: "invalid-request" });
 expect(out.stderr).toContain("ranger select-substrate:");
 expect(existsSync(f.calls)).toBe(false);
});

test("invalid JSON and oversized input fail closed", async () => {
 const f = fixture();
 for (const raw of ["{", " ".repeat(16385)]) expect((await invoke(f, null, raw)).result.reason).toBe("invalid-request");
 expect(existsSync(f.calls)).toBe(false);
});

test("missing config emits explicit integration unavailable JSON", async () => {
 const f = fixture();
 rmSync(f.path);
 expect((await invoke(f)).result).toMatchObject({ kind: "unavailable", reason: "integration-unavailable" });
 expect(existsSync(f.calls)).toBe(false);
});

test("absent selector configuration opts no providers in", async () => {
 const f = fixture();
 writeFileSync(f.path, baseConfigLines(f.dir).join("\n"));
 expect((await invoke(f)).result.kind).toBe("unavailable");
 expect(existsSync(f.calls)).toBe(false);
});

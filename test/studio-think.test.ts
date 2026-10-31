import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { enqueueJob, jobPass, runJob } from "../src/jobs.ts";
import { openJournal } from "../src/journal.ts";
import { appendStudioNotes, finishStudio, prepareStudio, studioCommand, studioEnvironment, studioPolicy, studioSubstrates } from "../src/studio-think.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const now = new Date("2026-10-31T10:00:00Z");
const thread = (areas = "lab") => `---\ntype: question\nareas: [${areas}]\nstate: active\nopened: 2026-10-01\n---\n\n## Question\n\nHow do we test this?\n\n## Where I stand\n\nCarefully.\n\n## Material\n\n- capture: Test a real git repository.\n\n## Ivy's notes\n\n## Log\n\n- 2026-10-01: Opened\n`;

function rig(areas = "lab", budget = 5) {
 const dir = mkdtempSync(join(tmpdir(), "studio-think-"));
 cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
 const repo = join(dir, "studio");
 mkdirSync(join(repo, "threads"), { recursive: true });
 writeFileSync(join(repo, "threads", "alpha.md"), thread(areas));
 const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
 };
 git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid"); git("add", "."); git("commit", "-qm", "initial");
 let policy = "cloud";
 let requests = 0;
 let unavailable = false;
 let directory = repo;
 const server = Bun.serve({ port: 0, fetch: () => { requests++; return unavailable ? new Response("unavailable", { status: 503 }) : Response.json({ directory, studio: { areas: [{ id: "lab", policy }, { id: "work", policy: "local" }] } }); } });
 cleanup.push(() => { server.stop(true); });
 const studio = { dir: repo, url: `http://127.0.0.1:${server.port}/api/desk/studio`, localProvider: "test-local", localEndpoint: "http://127.0.0.1:9999/v1", dailyRuns: { local: budget, cloud: budget } };
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({ maps: [{ repo: "acme/example", root: 1 }], state: { journalPath: join(dir, "journal.sqlite") }, substrates: { pi: { provider: "test-local", model: "local-model" } }, jobs: [{ name: "ivy-think", skill: "ivy-think", lane: "headless", wallClockMin: 5, cwd: repo, substrates: ["claude", "pi"], requireResult: true, studio }] }));
 const config = loadConfig(configPath, {}).config;
 const journal = openJournal(config);
 cleanup.push(() => journal.close());
 const job = config.jobs?.[0];
 if (!job) throw new Error("missing job");
 const params = { thread: "alpha", trigger: "New material" };
 const ledger = { env: {}, publisher: async () => {} };
 return { dir, repo, git, configPath, config, journal, job, params, ledger, requests: () => requests, setUnavailable: (value: boolean) => { unavailable = value; }, setPolicy: (value: string) => { policy = value; }, setDirectory: (value: string) => { directory = value; } };
}

async function reserve(r: ReturnType<typeof rig>, params: Record<string, string> = r.params) {
 const queued = enqueueJob(r.config, r.journal, "ivy-think", now, params);
 r.journal.updateJobRun(queued.runId, "queued", { status: "running", startedAt: now.toISOString(), policy: r.params.thread === "alpha" ? "cloud" : "local" });
 return queued.runId;
}

const response = JSON.stringify({ note: "Try the smallest meaningful experiment.", stand: "We should test through git.", ideas: ["Use a scratch repository."] });

test("strictest policy wins; unknown areas fail closed", () => {
 const areas = [{ id: "lab", policy: "cloud" as const }, { id: "work", policy: "local" as const }];
 expect(studioPolicy(["lab"], areas)).toBe("cloud");
 expect(studioPolicy(["work"], areas)).toBe("local");
 expect(studioPolicy(["lab", "work"], areas)).toBe("local");
 expect(studioPolicy(["missing"], areas)).toBe("local");
});

test("parameters survive journal reopen and independent threads stay queued", () => {
 const r = rig();
 const first = enqueueJob(r.config, r.journal, "ivy-think", now, r.params);
 expect(enqueueJob(r.config, r.journal, "ivy-think", now, r.params).queued).toBe(false);
 expect(enqueueJob(r.config, r.journal, "ivy-think", now, { ...r.params, thread: "beta" }).queued).toBe(true);
 const reopened = openJournal(r.config);
 try { expect(reopened.getJobRun(first.runId)?.params).toEqual(r.params); } finally { reopened.close(); }
 expect(() => enqueueJob(r.config, r.journal, "ivy-think", now, { ...r.params, mode: "invalid" })).toThrow();
});

test("real git note append preserves stand and records mode, trigger and model class", async () => {
 const r = rig(); const runId = await reserve(r);
 const outcome = await runJob(runId, { ...r, substrate: "claude", now: () => now, runSession: async (bin, args, opts) => {
  expect(bin).toBe("claude"); expect(args).toContain("--tools"); expect(opts.cwd).not.toBe(r.repo);
  expect(args.at(-1)).toContain("Test a real git repository.");
  return { code: 0, stdout: response, stderr: "" };
 } });
 expect(outcome.status).toBe("succeeded");
 const text = readFileSync(join(r.repo, "threads/alpha.md"), "utf8");
 expect(text).toContain("## Where I stand\n\nCarefully.");
 expect(text).toContain("model: cloud / claude\nmode: think");
 expect(text).toContain("trigger: New material"); expect(text).toContain("kind: stand"); expect(text).toContain("kind: idea");
 expect(r.git("status", "--porcelain")).toBe("");
 expect(r.git("log", "-1", "--format=%B")).toContain("Studio-Think-Run:");
});

test("daily thread limit and policy budget defer without dropping the queued run", async () => {
 const r = rig(undefined, 1); const runId = await reserve(r);
 r.journal.updateJobRun(runId, "running", { status: "succeeded", finishedAt: now.toISOString() });
 const queued = enqueueJob(r.config, r.journal, "ivy-think", now, { ...r.params, trigger: "Again" });
 const pass = await jobPass({ ...r, now: () => now, spawnJob: async () => { throw new Error("must not spawn"); } });
 expect(pass.waiting[0]?.reason).toContain("already ran today");
 expect(r.journal.getJobRun(queued.runId)?.status).toBe("queued");
 expect(r.journal.getJobRun(queued.runId)?.reason).toContain("tomorrow");
 const requested = enqueueJob(r.config, r.journal, "ivy-think", now, { ...r.params, mode: "red-team" });
 await jobPass({ ...r, now: () => now, spawnJob: async () => { throw new Error("must not spawn"); } });
 expect(r.journal.getJobRun(requested.runId)?.reason).toContain("daily run budget");
 await jobPass({ ...r, now: () => new Date("2026-11-01T10:00:00Z"), spawnJob: async () => process.pid });
 expect(r.journal.getJobRun(queued.runId)?.status).toBe("running");
});

test("person-requested mode bypasses thread frequency but not policy budget", async () => {
 const r = rig(); const first = await reserve(r);
 r.journal.updateJobRun(first, "running", { status: "succeeded" });
 const runId = await reserve(r, { ...r.params, mode: "grill" });
 const outcome = await runJob(runId, { ...r, now: () => now, substrate: "claude", runSession: async () => ({ code: 0, stdout: response, stderr: "" }) });
 expect(outcome.status).toBe("succeeded");
 expect(readFileSync(join(r.repo, "threads/alpha.md"), "utf8")).toContain("mode: grill");
});

test("local job rejects an explicit cloud override before invoking a session", async () => {
 const r = rig("work"); const runId = await reserve(r);
 let called = false;
 const result = await runJob(runId, { ...r, now: () => now, substrate: "claude", runSession: async () => { called = true; return { code: 0, stdout: response, stderr: "" }; } });
 expect(result.status).toBe("deferred"); expect(called).toBe(false);
 expect(r.journal.getJobRun(runId)?.status).toBe("queued");
});

test("local substrate requires endpoint attestation and never has cloud fallback", async () => {
 const r = rig("work");
 const prior = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = r.dir;
 cleanup.push(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
 writeFileSync(join(r.dir, "models.json"), JSON.stringify({ providers: { "test-local": { baseUrl: "https://cloud.example.invalid/v1", api: "openai-completions", models: [{ id: "local-model" }] } } }));
 expect(await studioSubstrates(r.job, r.config, "local")).toEqual([]);
 writeFileSync(join(r.dir, "models.json"), JSON.stringify({ providers: { "test-local": { baseUrl: r.job.studio?.localEndpoint, api: "openai-completions", models: [{ id: "local-model" }] } } }));
 expect(await studioSubstrates(r.job, r.config, "local")).toEqual(["pi"]);
 const id = await reserve(r);
 const result = await runJob(id, { ...r, now: () => now, substrate: "pi", runSession: async (bin, args) => {
  expect(bin).toBe("pi"); expect(args).toContain("--no-tools"); expect(args).toContain("--no-extensions");
  return { code: 0, stdout: response, stderr: "" };
 } });
 expect(result).toMatchObject({ status: "succeeded", substrate: "pi" });
 expect(r.journal.getJobRun(id)?.substrate).toBe("pi");
});

test("different stack policy, unavailable policy and closed threads fail closed", async () => {
 const r = rig();
 r.setDirectory(r.dir);
 expect(await prepareStudio(r.job, r.params)).toMatchObject({ kind: "deferred" });
 r.setDirectory(r.repo);
 writeFileSync(join(r.repo, "threads/alpha.md"), thread().replace("state: active", "state: closed"));
 expect(await prepareStudio(r.job, r.params)).toMatchObject({ kind: "deferred", reason: "thread is closed and has no due decision review" });
});

test("edits and policy changes during model latency survive without a generated note", async () => {
 for (const change of ["dirty", "commit", "policy", "lock"]) {
  const r = rig(); const id = await reserve(r);
  const result = await runJob(id, { ...r, now: () => now, substrate: "claude", runSession: async () => {
   if (change === "policy") r.setPolicy("local");
   else if (change === "lock") mkdirSync(join(r.repo, ".git", "studio-write.lock"));
   else { writeFileSync(join(r.repo, "threads/alpha.md"), thread().replace("Carefully.", "My later edit.")); if (change === "commit") { r.git("add", "."); r.git("commit", "-qm", "external edit"); } }
   return { code: 0, stdout: response, stderr: "" };
  } });
  expect(result.status).toBe("failed");
  const text = readFileSync(join(r.repo, "threads/alpha.md"), "utf8");
  expect(text).not.toContain("Try the smallest");
  if (change === "dirty" || change === "commit") expect(text).toContain("My later edit.");
 }
});

test("invalid answer and excessive ideas create no commit; body cannot inject headings", async () => {
 const r = rig(); const id = await reserve(r);
 const result = await runJob(id, { ...r, now: () => now, substrate: "claude", runSession: async () => ({ code: 0, stdout: JSON.stringify({ note: "x", ideas: ["a", "b", "c", "d"] }), stderr: "" }) });
 expect(result.status).toBe("failed"); expect(r.git("rev-list", "--count", "HEAD")).toBe("1");
 const output = appendStudioNotes(thread(), { note: "## Where I stand\nForged", ideas: [] }, { at: now, trigger: "x\nmodel: fake", model: "local / pi", mode: "think" });
 expect(output).toContain("\\## Where I stand"); expect(output).toContain("trigger: x model: fake");
 const command = studioCommand("codex", r.config, "/tmp/result");
 for (const flag of ["read-only", "--ignore-user-config", "--ignore-rules", "--ephemeral", "features.shell_tool=false", "features.unified_exec=false", "features.plugins=false", 'web_search="disabled"', "project_doc_max_bytes=0"]) expect(command).toContain(flag);
});

test("native sessions discard inherited Codex sandbox claims and pin the attested Pi catalog", () => {
 const env = studioEnvironment({ HOME: "/tmp/test-home", PATH: "/usr/bin", CODEX_HOME: "/tmp/auth", CODEX_SANDBOX: "seatbelt", CODEX_THREAD_ID: "parent", PI_CODING_AGENT_DIR: "/tmp/attested", RANGER_SECRET: "private" });
 expect(env.CODEX_HOME).toBe("/tmp/auth"); expect(env.CODEX_SANDBOX).toBeUndefined(); expect(env.CODEX_THREAD_ID).toBeUndefined();
 expect(env.PI_CODING_AGENT_DIR).toBe("/tmp/attested"); expect(env.RANGER_SECRET).toBeUndefined();
});

test("failed commit rollback preserves a concurrent manual edit", async () => {
 const r = rig(); const id = await reserve(r);
 const hook = join(r.repo, ".git", "hooks", "pre-commit");
 writeFileSync(hook, "#!/bin/sh\nprintf '\\nManual edit during commit.\\n' >> threads/alpha.md\nexit 1\n");
 chmodSync(hook, 0o700);
 const result = await runJob(id, { ...r, now: () => now, substrate: "claude", runSession: async () => ({ code: 0, stdout: response, stderr: "" }) });
 expect(result.status).toBe("failed");
 expect(readFileSync(join(r.repo, "threads/alpha.md"), "utf8")).toContain("Manual edit during commit.");
 expect(r.git("rev-list", "--count", "HEAD")).toBe("1");
});

test("one failed policy lookup per pass does not starve unrelated jobs", async () => {
 const r = rig(); r.setUnavailable(true);
 const config = { ...r.config, jobs: [...r.config.jobs ?? [], { ...r.job, name: "unrelated", skill: "unrelated", studio: undefined, lane: "none" as const }] };
 for (const trigger of ["one", "two", "three"]) enqueueJob(config, r.journal, "ivy-think", now, { ...r.params, trigger });
 const unrelated = enqueueJob(config, r.journal, "unrelated", now);
 r.journal.setPaused(true);
 await jobPass({ ...r, config, now: () => now, spawnJob: async () => process.pid });
 expect(r.requests()).toBe(0);
 r.journal.setPaused(false);
 const pass = await jobPass({ ...r, config, now: () => now, spawnJob: async () => process.pid });
 expect(r.requests()).toBe(1); expect(pass.waiting).toHaveLength(3);
 expect(r.journal.getJobRun(unrelated.runId)?.status).toBe("running");
 await jobPass({ ...r, config, now: () => now, spawnJob: async () => process.pid });
 expect(r.requests()).toBe(2);
});

test("final content reread preserves a manual edit injected during git-log lookup", async () => {
 const r = rig(); const id = await reserve(r);
 const snapshot = await prepareStudio(r.job, r.params);
 const row = r.journal.getJobRun(id);
 if (snapshot.kind !== "ready" || !row) throw new Error("Fixture not ready");
 const changed = thread().replace("Carefully.", "Saved during git log.");
 let injected = false;
 const runGit = async (dir: string, args: string[]) => {
  const child = Bun.spawnSync(["git", ...args], { cwd: dir });
  if (args[0] === "log") { writeFileSync(join(r.repo, "threads/alpha.md"), changed); injected = true; }
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
 };
 await expect(finishStudio(snapshot, r.job, row, "claude", response, now, runGit)).rejects.toThrow("final git lookup");
 expect(injected).toBe(true); expect(readFileSync(join(r.repo, "threads/alpha.md"), "utf8")).toBe(changed);
 expect(r.git("rev-list", "--count", "HEAD")).toBe("1");
});

test("local policy rejects model endpoint overrides, unknown IDs and untrusted APIs", async () => {
 const r = rig("work");
 const prior = process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR = r.dir;
 cleanup.push(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
 const endpoint = r.job.studio?.localEndpoint;
 const catalog = (models: object[], overrides: object = {}, api = "openai-completions") => writeFileSync(join(r.dir, "models.json"), JSON.stringify({ providers: { "test-local": { baseUrl: endpoint, api, models, modelOverrides: overrides } } }));
 for (const [models, overrides] of [
  [[{ id: "local-model", baseUrl: "https://cloud.example.invalid/v1" }], {}],
  [[{ id: "local-model" }], { "local-model": { baseUrl: "https://cloud.example.invalid/v1" } }],
  [[{ id: "another-model" }], {}],
  [[{ id: "local-model" }, { id: "local-model" }], {}],
 ] satisfies [object[], object][]) {
  catalog(models, overrides);
  expect(await studioSubstrates(r.job, r.config, "local")).toEqual([]);
 }
 catalog([{ id: "local-model" }], {}, "openai-codex-responses");
 expect(await studioSubstrates(r.job, r.config, "local")).toEqual([]);
 catalog([{ id: "local-model", baseUrl: endpoint }], { "local-model": { baseUrl: endpoint } });
 expect(await studioSubstrates(r.job, r.config, "local")).toEqual(["pi"]);
});


test("person request receipts survive completion and journal reopen without another budget attempt", async () => {
 const r = rig();
 const params = { ...r.params, mode: "red-team", requestId: "request-red-team" };
 const runId = await reserve(r, params);
 const result = await runJob(runId, { ...r, substrate: "claude", now: () => now, runSession: async () => ({ code: 0, stdout: response, stderr: "" }) });
 expect(result.status).toBe("succeeded");
 const reopened = openJournal(r.config);
 try {
  expect(enqueueJob(r.config, reopened, "ivy-think", now, params)).toMatchObject({ runId, queued: false });
  expect(() => enqueueJob(r.config, reopened, "ivy-think", now, { ...params, mode: "grill" })).toThrow("another job request");
  expect(() => enqueueJob(r.config, reopened, "ivy-think", now, { ...params, thread: "beta" })).toThrow("another job request");
  expect(() => enqueueJob(r.config, reopened, "ivy-think", now, { ...params, trigger: "Different trigger" })).toThrow("another job request");
  expect(reopened.listJobRuns()).toHaveLength(1);
  expect(readFileSync(join(r.repo, "threads/alpha.md"), "utf8")).toContain(`run: ${reopened.getJobRun(runId)?.runUuid}`);
 } finally { reopened.close(); }
});


test("native CLI receipt survives independent process restarts and Studio readback exposes no endpoint secrets", async () => {
 const r = rig();
 const cli = (...args: string[]) => Bun.spawnSync(["bun", "src/cli.ts", "job", ...args, "--config", r.configPath], { cwd: import.meta.dir + "/..", env: { ...process.env, RANGER_UNDER_TEST: "1", RANGER_JOURNAL_PATH: r.config.state.journalPath } });
 const args = ["enqueue", "ivy-think", "--param", "thread=alpha", "--param", "mode=red-team", "--param", "trigger=You asked: red-team", "--param", "requestId=restart-request"];
 const first = cli(...args); expect(first.exitCode).toBe(0);
 const receipt = JSON.parse(first.stdout.toString());
 r.journal.updateJobRun(receipt.runId, "queued", { status: "failed", finishedAt: now.toISOString() });
 const second = cli(...args); expect(second.exitCode).toBe(0);
 expect(JSON.parse(second.stdout.toString())).toMatchObject({ runId: receipt.runId, queued: false });
 const status = cli("list", "--studio"); expect(status.exitCode).toBe(0);
 const readback = JSON.parse(status.stdout.toString());
 expect(readback.directory).toBe(r.repo); expect(readback.dailyRuns).toEqual({ local: 5, cloud: 5 }); expect(readback.runs).toHaveLength(1);
 expect(status.stdout.toString()).not.toContain("localEndpoint");
});

test("only a due closed decision accepts an automatic review and keeps local policy", async () => {
 const r = rig("work");
 const params = { thread: "alpha", trigger: "Decision review due 2000-01-01" };
 for (const front of ["outcome: shipped\nreviewOn: 2000-01-01", "outcome: dropped\nreviewOn: 2000-01-01", "outcome: decided\nreviewOn: 2999-01-01"]) {
  writeFileSync(join(r.repo, "threads/alpha.md"), thread("work").replace("state: active", `state: closed\n${front}`));
  expect(await prepareStudio(r.job, params)).toMatchObject({ kind: "deferred" });
 }
 writeFileSync(join(r.repo, "threads/alpha.md"), thread("work").replace("state: active", "state: closed\noutcome: decided\nreviewOn: 2000-01-01"));
 r.git("add", "."); r.git("commit", "-qm", "Decided fixture");
 expect(await prepareStudio(r.job, r.params)).toMatchObject({ kind: "deferred" });
 expect(await prepareStudio(r.job, params)).toMatchObject({ kind: "ready", policy: "local" });
});


test("a due closed decision receives a review note while retaining outcome and stand", async () => {
 const r = rig();
 const text = thread().replace("state: active", "state: closed\noutcome: decided\nreviewOn: 2000-01-01");
 writeFileSync(join(r.repo, "threads/alpha.md"), text);
 r.git("add", "."); r.git("commit", "-qm", "Decided fixture");
 const params = { thread: "alpha", trigger: "Decision review due 2000-01-01" };
 const runId = await reserve(r, params);
 const outcome = await runJob(runId, { ...r, substrate: "claude", now: () => now, runSession: async () => ({ code: 0, stdout: response, stderr: "" }) });
 expect(outcome.status).toBe("succeeded");
 const updated = readFileSync(join(r.repo, "threads/alpha.md"), "utf8");
 expect(updated).toContain("state: closed\noutcome: decided\nreviewOn: 2000-01-01");
 expect(updated).toContain("## Where I stand\n\nCarefully.");
 expect(updated).toContain("trigger: Decision review due 2000-01-01");
});


test("successful automatic think-tonight consumes its request in the note commit", async () => {
 const r = rig();
 writeFileSync(join(r.repo, "threads/alpha.md"), thread().replace("state: active", "state: active\nthinkTonight: true"));
 r.git("add", "."); r.git("commit", "-qm", "Tonight fixture");
 const params = { thread: "alpha", trigger: "Asked to think tonight; New Material committed" };
 const runId = await reserve(r, params);
 const outcome = await runJob(runId, { ...r, substrate: "claude", now: () => now, runSession: async () => ({ code: 0, stdout: response, stderr: "" }) });
 expect(outcome.status).toBe("succeeded");
 expect(readFileSync(join(r.repo, "threads/alpha.md"), "utf8")).toContain("thinkTonight: false");
});


test("failed automatic work and successful explicit modes retain think-tonight", async () => {
 for (const mode of [undefined, "grill"]) {
  const r = rig();
  writeFileSync(join(r.repo, "threads/alpha.md"), thread().replace("state: active", "state: active\nthinkTonight: true"));
  r.git("add", "."); r.git("commit", "-qm", "Tonight fixture");
  const params = { thread: "alpha", trigger: "Asked to think tonight", ...(mode ? { mode } : {}) };
  const runId = await reserve(r, params);
  const outcome = await runJob(runId, { ...r, substrate: "claude", now: () => now, runSession: async () => ({ code: 0, stdout: mode ? response : "invalid JSON", stderr: "" }) });
  expect(outcome.status).toBe(mode ? "succeeded" : "failed");
  expect(readFileSync(join(r.repo, "threads/alpha.md"), "utf8")).toContain("thinkTonight: true");
 }
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeCooldown, MAX_THROTTLE_MS } from "../src/budget.ts";
import { openJournal } from "../src/journal.ts";
import { activeRecovery, nodeRecoveryScope, recordRecovery, recoverablePending, recoveryHold } from "../src/recovery.ts";
import { processResumeQueue } from "../src/resume.ts";
import { ReviewError, sageReview } from "../src/review.ts";
import { runNode } from "../src/worker.ts";
import { fixturesBin, restoreEnv, rig, type Rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const NODE = "20";
const SCOPE = nodeRecoveryScope(REPO, NODE);
const READ_TOKEN_ENV = "RANGER_RO_TEST";
const fakeSage = join(fixturesBin, "fake-sage");
const T0 = new Date("2026-11-08T20:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const marker = (fields: unknown) => `SAGE_PREFLIGHT_FAILURE ${JSON.stringify(fields)}`;
const refused = (line: string) => `gh refused the preflight\n${line}`;
const RATE_LIMITED = { kind: "rate-limit", http_status: 403, reset_at: minutes(20).toISOString() };
const NO_SLEEP = { sleep: () => Promise.resolve() };

function stubSage(stderr: string, exit = 2): void {
 process.env.SAGE_FAKE_MODE = "preflight";
 process.env.SAGE_FAKE_STDERR = stderr;
 process.env.SAGE_FAKE_EXIT = String(exit);
}

function clearSageStub(): void {
 for (const name of ["SAGE_FAKE_MODE", "SAGE_FAKE_STDERR", "SAGE_FAKE_EXIT", "SAGE_FAKE_CALLS"]) Reflect.deleteProperty(process.env, name);
}

async function waitingRig(stderr: string, exit = 2) {
 const r = await rig({});
 const scripted = r.ctx.reviewer;
 let clock = T0;
 r.ctx.now = () => clock;
 r.ctx.reviewer = (repo, pr, token, opts) => sageReview(repo, pr, token, { ...opts, command: fakeSage, retry: NO_SLEEP });
 stubSage(stderr, exit);
 return { r, scripted, setClock: (at: Date) => { clock = at; } };
}

const row = (r: Rig) => r.journal.getWorker(NODE, REPO);
const events = (r: Rig) => r.journal.listEvents(REPO, 300, NODE);
const cooldown = (r: Rig, at: Date) => activeCooldown(r.journal, READ_TOKEN_ENV, at);
const unqueue = (r: Rig) => r.journal.removeResume(r.journal.listResumeQueue()[0], "resume-cancelled", "test");

function queue(r: Rig, at: Date, spawned: string[]) {
 process.env.RANGER_WRITE_TEST = r.ctx.token;
 return processResumeQueue({ config: r.ctx.config, configPath: join(r.dir, "ranger.yaml"), journal: r.journal,
  github: r.github, hostLoad: () => ({ load: 0, cores: 1 }), now: () => at,
  spawnRunNode: ({ nodeId }) => { spawned.push(nodeId); return Promise.resolve(process.pid); },
 }, [{ map: r.ctx.map, token: r.ctx.token, errors: [] }], new Set(), () => {});
}

describe("a rate-limited sage review (ranger#492)", () => {
 const cleanup: string[] = [];
 const track = <T extends { r: Rig }>(made: T): T => { cleanup.push(made.r.dir); return made; };
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSageStub();
  restoreEnv();
 });

 test("defers the node, resumes it after the reset, and leaves the recovery budget unspent", async () => {
  const { r, scripted, setClock } = track(await waitingRig(refused(marker(RATE_LIMITED))));
  const outcome = await runNode(NODE, r.ctx);

  expect(outcome.status).toBe("failed");
  expect(row(r)?.status).toBe("failed");
  expect(row(r)?.outcome).toContain(`until ${minutes(20).toISOString()}`);
  expect(r.journal.listResumeQueue().map((q) => q.nodeId)).toEqual([NODE]);
  expect(activeRecovery(r.journal, SCOPE)).toBeNull();
  expect(r.journal.deadmanCount()).toBe(0);
  expect(cooldown(r, T0)?.until).toEqual(minutes(20));
  const wait = events(r).filter((e) => e.kind === "transient");
  expect(wait).toHaveLength(1);
  expect(wait[0].detail).toContain("rate limit");
  expect(wait[0].detail).toContain("HTTP 403");
  expect(wait[0].detail).toContain(minutes(20).toISOString());

  const spawned: string[] = [];
  await queue(r, minutes(19), spawned);
  expect(spawned).toEqual([]);
  expect(r.journal.listResumeQueue()).toHaveLength(1);
  expect(events(r).some((e) => (e.detail ?? "").includes(`waits until ${minutes(20).toISOString()}`))).toBe(true);

  await queue(r, minutes(21), spawned);
  expect(spawned).toEqual([NODE]);
  expect(r.journal.listResumeQueue()).toEqual([]);

  clearSageStub();
  r.ctx.reviewer = scripted;
  setClock(minutes(21));
  const resumed = await runNode(NODE, { ...r.ctx, generation: row(r)?.generation });
  expect(resumed.status).toBe("awaiting-merge");
  expect(activeRecovery(r.journal, SCOPE)?.attempts ?? 0).toBe(0);
  expect(r.journal.deadmanCount()).toBe(0);
 }, 120_000);

 test("a wait survives a restart: journal records carry all of it", async () => {
  const { r } = track(await waitingRig(refused(marker(RATE_LIMITED))));
  await runNode(NODE, r.ctx);
  const reopened = openJournal(r.ctx.config);
  try {
   expect(reopened.listResumeQueue().map((q) => q.nodeId)).toEqual([NODE]);
   expect(activeCooldown(reopened, READ_TOKEN_ENV, T0)?.until).toEqual(minutes(20));
   expect(reopened.getWorker(NODE, REPO)?.status).toBe("failed");
  } finally { reopened.close(); }
 }, 120_000);

 test("a run already spending a recovery attempt gets it back", async () => {
  const { r } = track(await waitingRig(refused(marker(RATE_LIMITED))));
  recordRecovery(r.journal, SCOPE, { kind: "infrastructure", operation: "worker-supervisor", evidence: "supervisor died", action: "retry" }, { now: new Date(T0.getTime() - 3_600_000) });
  await runNode(NODE, r.ctx);
  expect(activeRecovery(r.journal, SCOPE)).toMatchObject({ attempts: 1, status: "waiting", nextEligibleAt: null });
  expect(recoveryHold(r.journal, SCOPE, T0)).toBeNull();
 }, 120_000);

 test("a reset absurdly far away is clamped to the longest throttle", async () => {
  const { r } = track(await waitingRig(refused(marker({ kind: "rate-limit", reset_at: "2099-01-01T00:00:00.000Z" }))));
  await runNode(NODE, r.ctx);
  expect(cooldown(r, T0)?.until).toEqual(new Date(T0.getTime() + MAX_THROTTLE_MS));
 }, 120_000);

 test.each([
  ["no reset", { kind: "rate-limit", http_status: 429 }],
  ["a reset already past", { kind: "rate-limit", reset_at: minutes(-5).toISOString() }],
 ])("%s falls back to the budget cooldown, which doubles per throttle", async (_name, fields) => {
  const { r, setClock } = track(await waitingRig(refused(marker(fields))));
  await runNode(NODE, r.ctx);
  expect(cooldown(r, T0)).toMatchObject({ kind: "throttled", strikes: 1, until: minutes(10) });
  unqueue(r);
  setClock(minutes(11));
  await runNode(NODE, r.ctx);
  expect(cooldown(r, minutes(11))).toMatchObject({ strikes: 2, until: minutes(31) });
 }, 120_000);

 test("while the token cools, a review makes no sage call and adds no strike", async () => {
  const { r } = track(await waitingRig(refused(marker(RATE_LIMITED))));
  const calls = join(r.dir, "sage-calls");
  writeFileSync(calls, "");
  process.env.SAGE_FAKE_CALLS = calls;
  await runNode(NODE, r.ctx);
  expect(readFileSync(calls, "utf8")).toBe("call\n");
  unqueue(r);
  const again = await runNode(NODE, r.ctx);
  expect(again.status).toBe("failed");
  expect(readFileSync(calls, "utf8")).toBe("call\n");
  expect(cooldown(r, T0)?.strikes).toBe(1);
  expect(r.journal.listResumeQueue()).toHaveLength(1);
 }, 120_000);

 test("a verdict clears the strikes, so the next throttle starts from the first cooldown", async () => {
  const { r, scripted, setClock } = track(await waitingRig(refused(marker({ kind: "rate-limit" }))));
  await runNode(NODE, r.ctx);
  expect(cooldown(r, T0)?.strikes).toBe(1);
  clearSageStub();
  r.ctx.reviewer = scripted;
  setClock(minutes(11));
  unqueue(r);
  expect((await runNode(NODE, r.ctx)).status).toBe("awaiting-merge");
  expect(JSON.parse(r.journal.getHealth(`ratelimit:${READ_TOKEN_ENV}`) ?? "{}").strikes).toBe(0);
 }, 120_000);
});

describe("what still parks (ranger#492)", () => {
 const cleanup: string[] = [];
 afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSageStub();
  restoreEnv();
 });

 test.each([
  ["an auth failure", marker({ kind: "auth", http_status: 401 }), 2],
  ["an unknown failure", marker({ kind: "unknown", http_status: 403 }), 2],
  ["malformed JSON", "SAGE_PREFLIGHT_FAILURE {not json}", 2],
  ["an unknown kind", marker({ kind: "maintenance" }), 2],
  ["an unparseable reset_at", marker({ kind: "rate-limit", reset_at: "after lunch" }), 2],
  ["a marker that is not the last line", `${marker(RATE_LIMITED)}\ntrailing noise`, 2],
  ["a marker on another exit code", marker(RATE_LIMITED), 3],
  ["an old sage with no marker", "gh auth is not configured", 2],
 ])("%s parks for the principal with its evidence and no wait", async (_name, line, exit) => {
  const { r } = await waitingRig(refused(line), exit);
  cleanup.push(r.dir);
  const outcome = await runNode(NODE, r.ctx);
  expect(outcome.status).toBe("parked");
  expect(row(r)?.status).toBe("parked");
  expect(row(r)?.outcome).toContain("unknown recovery 1/3 exhausted");
  expect(row(r)?.outcome).toContain(line.split("\n").at(-1) ?? line);
  expect(r.journal.listResumeQueue()).toEqual([]);
  expect(activeCooldown(r.journal, READ_TOKEN_ENV, T0)).toBeNull();
 }, 120_000);

 test("a failure still transient after the retries takes the bounded recovery backoff, not the principal", async () => {
  const { r } = await waitingRig(refused(marker({ kind: "transient", http_status: 502 })));
  cleanup.push(r.dir);
  const outcome = await runNode(NODE, r.ctx);
  expect(outcome.status).toBe("parked");
  expect(activeRecovery(r.journal, SCOPE)).toMatchObject({ kind: "infrastructure", attempts: 1, status: "waiting" });
  expect(recoverablePending(r.journal, SCOPE)).toBe(true);
  expect(r.journal.listResumeQueue()).toEqual([]);
 }, 120_000);
});

describe("sageReview's retries on the preflight marker (ranger#492)", () => {
 const run = async (stderr: string) => {
  const r = await rig({});
  const calls = join(r.dir, "sage-calls");
  writeFileSync(calls, "");
  stubSage(stderr);
  process.env.SAGE_FAKE_CALLS = calls;
  const sleeps: number[] = [];
  try {
   const error = await sageReview(REPO, 7, r.ctx.readOnlyToken ?? "", { command: fakeSage, substrate: "claude",
    retry: { sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); } } }).catch((e: unknown) => e);
   expect(error).toBeInstanceOf(ReviewError);
   return { calls: readFileSync(calls, "utf8").trim().split("\n").length, sleeps };
  } finally {
   r.journal.close();
   rmSync(r.dir, { recursive: true, force: true });
   clearSageStub();
   restoreEnv();
  }
 };

 test("transient retries with the existing backoff even when its text matches no pattern", async () => {
  expect(await run(`socket closed\n${marker({ kind: "transient" })}`)).toEqual({ calls: 3, sleeps: [10_000, 30_000] });
 }, 120_000);

 test("a rate limit is never retried, even when its message reads as transient", async () => {
  expect(await run(`HTTP 503\n${marker(RATE_LIMITED)}`)).toEqual({ calls: 1, sleeps: [] });
 }, 120_000);

 test("an auth failure is never retried, even when its message reads as transient", async () => {
  expect(await run(`HTTP 503\n${marker({ kind: "auth" })}`)).toEqual({ calls: 1, sleeps: [] });
 }, 120_000);
});

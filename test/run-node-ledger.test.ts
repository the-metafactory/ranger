import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { validateExecutionRunFinished, type ExecutionRunFinishedEvent, type RunOutcome } from "@the-metafactory/myelin";
import { runRunNode } from "../src/cli.ts";
import { nodeKey } from "../src/forge-ref.ts";
import type { ChangeRequest } from "../src/forge.ts";
import { WriteGateError } from "../src/identity.ts";
import { runNodeRunOutcome } from "../src/run-ledger.ts";
import type { RunNodeOutcome } from "../src/worker.ts";
import { workerLogFile } from "../src/worker-log.ts";
import { AT, cleanup, controlled, deps, failures, fixture, forge, graphFixture, result, spool, valid } from "./run-node-ledger-support.ts";
import { createCanonicalRepo, fixturesBin, runCli } from "./support.ts";

afterEach(cleanup);

describe("run-node run ledger", () => {
 const mappings: [RunNodeOutcome["status"], RunOutcome | null][] = [
  ["success", "succeeded"], ["failed", "failed"], ["parked", "blocked"],
  ["released", "cancelled"], ["awaiting-merge", "succeeded"], ["proposed", "succeeded"],
  ["refused", "blocked"], ["skipped", null],
 ];
 for (const [status, outcome] of mappings) {
  test(`${status} maps to ${outcome} and emits at most once for its generation`, async () => {
   expect(runNodeRunOutcome(status)).toBe(outcome);
   const f = fixture();
   const events: ExecutionRunFinishedEvent[] = [];
   const output = await runRunNode("10", undefined, f.configPath, deps(f, {
    publisher: async event => { expect(f.closed()).toBe(false); events.push(event); },
   }, { runNode: controlled(status) }));
   expect(output).toBe(JSON.stringify(result(status), null, 2));
   expect(f.closed()).toBe(true);
   expect(events).toHaveLength(outcome === null ? 0 : 1);
   if (outcome !== null) valid(events[0], outcome);
   expect(existsSync(f.spool)).toBe(false);
  });
 }

 test("entry and completion times bracket context and worker; node owns serves, log and fresh UUID", async () => {
  const events: ExecutionRunFinishedEvent[] = [];
  for (const [repo, row, goal] of [["acme/widgets", true, "goal-17"], ["gitlab:example.test/acme/widgets", false, ""]] as const) {
   const f = fixture("  principal: jc\n  stack: work\n", repo, row);
   const ordered: string[] = [];
   let time = 0;
   await runRunNode("10", undefined, f.configPath, deps(f, {
    env: { MF_SERVES_GOAL: goal, MF_SERVES_NODE: "wrong#99", MF_CORRELATION_ID: "origin-correlation" },
    publisher: async event => { ordered.push("emit"); events.push(event); expect(f.closed()).toBe(false); },
   }, {
    now: () => { ordered.push("time"); return new Date(Date.parse(AT) + time++ * 1000); },
    loadCtx: () => { ordered.push("load"); return { config: f.config, journal: f.journal }; },
    runNodeContext: async () => { ordered.push("gate"); return { token: "fake", botIdentity: "ivy-bot" }; },
    runNode: async (id, ctx) => { ordered.push("worker"); return controlled("success")!(id, ctx); },
   }));
   expect(ordered).toEqual(["time", "load", "gate", "worker", "time", "emit"]);
   const event = events.at(-1)!;
   valid(event, "succeeded");
   const ref = nodeKey(repo, "10");
   expect(event.subject).toBe("local.jc.work.execution.run.finished");
   expect(event.input.source).toBe("jc.ranger.run");
   expect(event.input.payload).toMatchObject({
    producer: "ranger", ran: { kind: "node", ref },
    serves: { node: ref, ...(goal ? { goal } : {}) },
    started_at: AT, ended_at: "2026-10-14T07:00:01.000Z",
    detail_ref: workerLogFile(f.journal.path, repo, "10", row ? 2 : 1),
    correlation_id: "origin-correlation",
   });
   if (!goal) expect(event.input.payload.serves).not.toHaveProperty("goal");
  }
  expect(events[0].input.payload.run_id).not.toBe(events[1].input.payload.run_id);
 });

 for (const path of ["unsupported kind", "ratifyFor refusal", "fenced"] as const) {
  test(`real runNode ${path} emits blocked after beginning a generation`, async () => {
   const f = fixture();
   graphFixture(f, { kind: path === "unsupported kind" ? "grilling" : "task", autonomy: "approve", status: path === "fenced" ? "closed" : "open" });
   const events: ExecutionRunFinishedEvent[] = [];
   const output = await runRunNode("10", undefined, f.configPath, deps(f, { publisher: async event => { events.push(event); } }, {
    worker: {
     worker: async () => { throw new Error("refused runs must not spawn a worker"); },
     github: forge(async () => { f.journal.beginGeneration("10", "acme/widgets"); return null; }),
    },
   }));
   expect(JSON.parse(output).status).toBe("refused");
   expect(JSON.parse(output).detail).toMatch(path === "unsupported kind" ? /kind 'grilling'/ : path === "fenced" ? /superseded/ : /waits for the principal/);
   expect(events).toHaveLength(1);
   valid(events[0], "blocked");
   expect(events[0].input.payload.detail_ref).toBe(workerLogFile(f.journal.path, "acme/widgets", "10", 2));
  });
 }

 for (const merged of [true, false]) for (const readableRoot of [true, false]) {
  test(`real runNode reconciles a closed node as ${merged ? "success" : "released"} with root readable=${readableRoot}`, async () => {
   const f = fixture();
   graphFixture(f, { status: "closed" });
   const rootPath = join(f.dir, "acme__widgets-node-1.json");
   if (readableRoot) {
    const root = JSON.parse(readFileSync(rootPath, "utf8"));
    root.node.serves = "G5";
    writeFileSync(rootPath, JSON.stringify(root));
   } else rmSync(rootPath);
   const events: ExecutionRunFinishedEvent[] = [];
   const pr: ChangeRequest = { iid: 42, state: "merged", draft: false, headRef: "node/10", headSha: "abc", baseRef: "main", mergeState: "mergeable", webUrl: "https://github.com/acme/widgets/pull/42", author: "ivy-bot", title: "work", body: "", mergeCommitSha: "abc", mergedBy: "alice" };
   const output = await runRunNode("10", undefined, f.configPath, deps(f, { env: { MF_SERVES_GOAL: "G7" }, publisher: async event => { events.push(event); } }, {
    worker: { github: forge(async () => merged ? pr : null), worker: async () => { throw new Error("closed node must not spawn a worker"); } },
   }));
   expect(JSON.parse(output).status).toBe(merged ? "success" : "released");
   expect(events).toHaveLength(1);
   valid(events[0], merged ? "succeeded" : "cancelled");
   expect(events[0].input.payload.serves).toEqual({ node: "acme/widgets#10", goal: readableRoot ? "G5" : "G7" });
  });
 }

 for (const status of ["failed", "parked"] as const) {
  test(`real injected research worker ends ${status} and emits its generation`, async () => {
   const f = fixture();
   graphFixture(f, { kind: "research" });
   const { canonical } = await createCanonicalRepo(f.dir);
   f.config.maps[0].canonical = canonical;
   let workers = 0;
   const events: ExecutionRunFinishedEvent[] = [];
   const output = await runRunNode("10", undefined, f.configPath, deps(f, { publisher: async event => { events.push(event); } }, {
    worker: {
     github: forge(async () => null),
     worker: async () => {
      workers++;
      return status === "failed" ? { code: 7, stdout: "", stderr: "worker failed" } :
       { code: 0, stdout: "Operation stopped by hook: blocked by policy\n", stderr: "" };
     },
    },
   }));
   expect(workers).toBe(1);
   expect(JSON.parse(output).status).toBe(status);
   expect(events).toHaveLength(1);
   valid(events[0], status === "failed" ? "failed" : "blocked");
   expect(existsSync(events[0].input.payload.detail_ref!)).toBe(true);
  });
 }

 test("lane-credential refusal at runNode entry emits nothing", async () => {
  const f = fixture(undefined, "gitlab:ledger.invalid/acme/widgets");
  let published = 0;
  const output = await runRunNode("10", undefined, f.configPath, deps(f, { publisher: async () => { published++; } }));
  expect(JSON.parse(output).status).toBe("refused");
  expect(JSON.parse(output).detail).toMatch(/no GitLab credentials/);
  expect(published).toBe(0);
  expect(f.closed()).toBe(true);
  expect(existsSync(f.spool)).toBe(false);
 });

 test("WriteGateError preserves the error, closes journal and emits nothing", async () => {
  const f = fixture();
  const error = new WriteGateError("identity refused");
  let published = 0;
  await expect(runRunNode("10", undefined, f.configPath, deps(f, { publisher: async () => { published++; } }, {
   runNodeContext: async () => { throw error; },
   runNode: async () => { throw new Error("must not run"); },
  }))).rejects.toBe(error);
  expect(published).toBe(0);
  expect(f.closed()).toBe(true);
  expect(existsSync(f.spool)).toBe(false);
 });

 test("a pending proposal refuses before generation and emits nothing", async () => {
  const f = fixture();
  f.journal.updateWorker("10", "acme/widgets", { status: "proposed", phase: "implement" });
  let published = 0;
  const output = await runRunNode("10", undefined, f.configPath, deps(f, { publisher: async () => { published++; } }));
  expect(JSON.parse(output).status).toBe("refused");
  expect(published).toBe(0);
 });

 for (const began of [true, false]) {
  test(`thrown runNode ${began ? "after" : "before"} generation preserves the same error`, async () => {
   const f = fixture();
   const events: ExecutionRunFinishedEvent[] = [];
   const error = new Error("worker exploded");
   await expect(runRunNode("10", undefined, f.configPath, deps(f, { publisher: async event => { expect(f.closed()).toBe(false); events.push(event); } }, {
    runNode: async (id, ctx) => { if (began) ctx.journal.beginGeneration(id, ctx.map.repo); throw error; },
   }))).rejects.toBe(error);
   expect(events).toHaveLength(began ? 1 : 0);
   if (began) valid(events[0], "failed");
   expect(f.closed()).toBe(true);
  });
 }

 test("no bus builds nothing and touches no spool even with invalid ledger input", async () => {
  const f = fixture(null);
  let called = 0;
  const output = await runRunNode("10", undefined, f.configPath, deps(f, {
   env: { MF_SERVES_GOAL: " " },
   publisher: async () => { called++; }, makeTransport: () => { called++; throw new Error("must not construct transport"); },
  }, { runNode: controlled("success") }));
  expect(output).toBe(JSON.stringify(result("success"), null, 2));
  expect(called).toBe(0);
  expect(existsSync(join(f.dir, "run-ledger"))).toBe(false);
  expect(failures(f)).toEqual([]);
 });

 for (const status of ["success", "failed", "parked"] as const) {
  test(`publisher failure preserves ${status} output and logs before close`, async () => {
   const f = fixture();
   const output = await runRunNode("10", undefined, f.configPath, deps(f, { publisher: async () => { throw new Error("ledger offline"); } }, { runNode: controlled(status) }));
   expect(output).toBe(JSON.stringify(result(status), null, 2));
   expect(f.closed()).toBe(true);
   expect(failures(f)).toHaveLength(1);
   expect(failures(f)[0].detail).toContain("ledger offline");
  });
 }

 test("throwing runNode and publisher preserve the worker error", async () => {
  const f = fixture();
  const error = new WriteGateError("worker gate failed after generation");
  await expect(runRunNode("10", undefined, f.configPath, deps(f, { publisher: async () => { throw new Error("ledger offline"); } }, {
   runNode: async (id, ctx) => { ctx.journal.beginGeneration(id, ctx.map.repo); throw error; },
  }))).rejects.toBe(error);
  expect(failures(f)[0].detail).toContain("ledger offline");
 });

 for (const throws of [true, false]) {
 test(`real CLI ${throws ? "throw" : "JSON outcome"} is unchanged with unreachable NATS and retains a put`, async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const outputs = [];
  for (const configured of [false, true]) {
   const f = fixture(configured ? `  principal: jc\n  url: nats://127.0.0.1:${port}\n` : null);
   if (!throws) graphFixture(f, { status: "closed" });
   const statePath = join(f.dir, "state.json");
   writeFileSync(statePath, "{}");
   f.journal.close();
   if (throws) {
    const db = new Database(f.journal.path);
    try {
     // runNode takes the generation, then sets its PID outside its own catch.
     db.exec("CREATE TRIGGER fail_run_node BEFORE UPDATE OF pid ON workers WHEN NEW.pid IS NOT NULL BEGIN SELECT RAISE(ABORT, 'run-node exploded'); END;");
    } finally { db.close(); }
   }
   const output = await runCli(["run-node", "10", "-c", f.configPath], {
    ...process.env, PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, RANGER_WRITE_TEST: "ghp_write",
    RANGER_JOURNAL_PATH: f.journal.path,
    FAKE_SOMA_DIR: f.dir, FAKE_SOMA_STATE: statePath,
   }, f.dir);
   if (throws) expect(output.stdout).toBe("");
   else expect(JSON.parse(output.stdout).status).toBe("released");
   expect(output.stderr).toBe(throws ? "ranger run-node: run-node exploded\n" : "");
   expect(output.code).toBe(throws ? 1 : 0);
   outputs.push(output);
   if (configured) {
    expect(failures(f)).toHaveLength(1);
    expect(failures(f)[0].detail).toMatch(/refused/i);
    const records = spool(f);
    expect(records.map(record => record.op)).toEqual(["put"]);
    expect(records[0].envelope.payload.outcome).toBe(throws ? "failed" : "cancelled");
    expect(validateExecutionRunFinished(records[0].envelope)).toEqual({ valid: true, errors: [] });
   } else expect(existsSync(f.spool)).toBe(false);
  }
  expect(outputs[1]).toEqual(outputs[0]);
 });
 }
});

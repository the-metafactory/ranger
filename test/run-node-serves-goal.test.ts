import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { runRunNode } from "../src/cli.ts";
import { Journal } from "../src/journal.ts";
import { cleanup, deps, env, fixture, graphFixture, spool, valid } from "./run-node-ledger-support.ts";
import { runCli } from "./support.ts";

afterEach(cleanup);

// The checkpoint of node #263 (mfp-ranger-root-serves-goal) names this file.
describe("run-node serves.goal from the map root (node #263)", () => {
 for (const [rootGoal, fallback, expected] of [
  ["G5", undefined, "G5"], ["G5", "G7", "G5"],
  [undefined, "G7", "G7"], [undefined, undefined, undefined],
  ["invalid", "G7", "G7"], ["G5\n", undefined, undefined],
  [7, "G7", "G7"], [null, undefined, undefined],
 ] as const) {
  test(`root serves ${JSON.stringify(rootGoal)} precedes fallback ${fallback}`, async () => {
   const f = fixture();
   graphFixture(f, { kind: "grilling" });
   const rootPath = join(f.dir, "acme__widgets-node-1.json");
   const root = JSON.parse(readFileSync(rootPath, "utf8"));
   root.node.serves = rootGoal;
   writeFileSync(rootPath, JSON.stringify(root));
   const nodePath = join(f.dir, "acme__widgets-node-10.json");
   const node = JSON.parse(readFileSync(nodePath, "utf8"));
   node.node.serves = "G99";
   writeFileSync(nodePath, JSON.stringify(node));
   const calls = join(f.dir, "graph-calls");
   env("FAKE_SOMA_CALLS", calls);
   const events: ExecutionRunFinishedEvent[] = [];
   const output = await runRunNode("10", undefined, f.configPath, deps(f, {
    env: { MF_SERVES_GOAL: fallback }, publisher: async event => { events.push(event); },
   }));
   expect(JSON.parse(output).status).toBe("refused");
   expect(events).toHaveLength(1);
   valid(events[0], "blocked");
   expect(events[0].input.payload.serves).toEqual({ node: "acme/widgets#10", ...(expected ? { goal: expected } : {}) });
   // The node and root are the only reads: publication reuses the root.
   expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
   const journal = new Journal(f.journal.path);
   try {
    const diagnostics = journal.listEvents().filter(event => event.kind === "ledger-root-serves-invalid");
    expect(diagnostics).toHaveLength(rootGoal !== undefined && rootGoal !== "G5" ? 1 : 0);
    if (diagnostics.length) expect(diagnostics[0]).toMatchObject({ repo: "acme/widgets", nodeId: "1", detail: expect.stringContaining("acme/widgets#1") });
   } finally { journal.close(); }
  });
 }

 test("unreadable root preserves real CLI output and exit code and publishes fallback", async () => {
  const outputs = [];
  for (const bus of [null, "  principal: jc\n"] as const) {
   const f = fixture(bus);
   graphFixture(f, { kind: "grilling" });
   rmSync(join(f.dir, "acme__widgets-node-1.json"));
   f.journal.close();
   const output = await runCli(["run-node", "10", "-c", f.configPath], {
    ...process.env, RANGER_WRITE_TEST: "ghp_write", MF_SERVES_GOAL: "G7",
    RANGER_JOURNAL_PATH: f.journal.path,
   }, f.dir);
   expect(output.code).toBe(0);
   expect(JSON.parse(output.stdout).status).toBe("failed");
   // The fake's error includes this run's temporary fixture directory.
   outputs.push({ ...output, stdout: output.stdout.replaceAll(f.dir, "FIXTURE") });
   if (bus !== null) {
    const puts = spool(f).filter(op => op.op === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0].envelope.payload.serves).toEqual({ node: "acme/widgets#10", goal: "G7" });
   }
  }
  expect(outputs[0]).toEqual(outputs[1]);
 });

 test("root metadata survives a later worker exception without replacing it", async () => {
  const f = fixture();
  const root = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/data/acme__widgets-node-1.json"), "utf8"));
  root.node.serves = "G5";
  const error = new Error("worker failed after root read");
  const events: ExecutionRunFinishedEvent[] = [];
  await expect(runRunNode("10", undefined, f.configPath, deps(f, {
   env: { MF_SERVES_GOAL: "G7" }, publisher: async event => { events.push(event); },
  }, {
   runNode: async (id, ctx) => {
    ctx.journal.beginGeneration(id, ctx.map.repo);
    ctx.onMapRootRead?.(root);
    throw error;
   },
  }))).rejects.toBe(error);
  expect(events).toHaveLength(1);
  valid(events[0], "failed");
  expect(events[0].input.payload.serves).toEqual({ node: "acme/widgets#10", goal: "G5" });
 });

 test("malformed-root diagnostic failure still publishes fallback and preserves output", async () => {
  const f = fixture();
  graphFixture(f, { kind: "grilling" });
  const rootPath = join(f.dir, "acme__widgets-node-1.json");
  const root = JSON.parse(readFileSync(rootPath, "utf8"));
  root.node.serves = "private malformed text";
  writeFileSync(rootPath, JSON.stringify(root));
  const recordEvent = f.journal.recordEvent.bind(f.journal);
  f.journal.recordEvent = (kind, opts) => {
   if (kind === "ledger-root-serves-invalid") throw new Error("journal diagnostic unavailable");
   recordEvent(kind, opts);
  };
  const events: ExecutionRunFinishedEvent[] = [];
  const output = await runRunNode("10", undefined, f.configPath, deps(f, {
   env: { MF_SERVES_GOAL: "G7" }, publisher: async event => { events.push(event); },
  }));
  expect(JSON.parse(output).status).toBe("refused");
  expect(events).toHaveLength(1);
  expect(events[0].input.payload.serves).toEqual({ node: "acme/widgets#10", goal: "G7" });
 });
});

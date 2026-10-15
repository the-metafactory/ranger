import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";
import { workerLogFile } from "../src/worker-log.ts";
import { baseConfigLines, runCli } from "./support.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ranger-journal-cli-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ranger journal (ranger issue #229)", () => {
 test("a config it cannot read exits non-zero and says so on stderr", async () => {
  const empty = join(dir, "empty");
  mkdirSync(empty);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: empty };
  delete env.RANGER_CONFIG;
  const result = await runCli(["journal", "--repo", "acme/widgets"], env, empty);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`cannot read config at ${join(empty, ".config", "ranger", "ranger.yaml")}`);
 });

 test("--node keeps one node's rows and names each worker's log file", async () => {
  const config = join(dir, "ranger.yaml");
  writeFileSync(config, baseConfigLines(dir).join("\n") + "\n");
  const journalPath = join(dir, "state.sqlite");
  const j = new Journal(journalPath);
  j.upsertWorker({ root: 1, nodeId: "769", repo: "acme/widgets", status: "parked", attempts: 1, outcome: "probes failed" });
  j.upsertWorker({ root: 1, nodeId: "843", repo: "acme/widgets", status: "running", attempts: 1 });
  j.recordEvent("parked", { nodeId: "769", repo: "acme/widgets", detail: "FAILED: probe-system-sweep.mjs" });
  // Newer events of another node must not push 769's out of the window.
  for (let i = 0; i < 60; i++) j.recordEvent("reviewed", { nodeId: "843", repo: "acme/widgets", detail: `round ${i}` });
  j.close();

  // From another directory, with -c: the command the session prompt hands out.
  const result = await runCli(["journal", "--repo", "acme/widgets", "--node", "769", "-c", config], process.env, tmpdir());
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout) as {
   workers: { nodeId: string; generation: number; workerLog: string }[];
   events: { nodeId: string; detail: string }[];
  };
  expect(out.workers.map((w) => w.nodeId)).toEqual(["769"]);
  expect(out.workers[0].workerLog).toBe(workerLogFile(journalPath, "acme/widgets", "769", out.workers[0].generation));
  expect(out.events).toHaveLength(1);
  expect(out.events[0].detail).toBe("FAILED: probe-system-sweep.mjs");
 });

 test("--node refuses a non-numeric id", async () => {
  const result = await runCli(["journal", "--node", "769; rm -rf /", "-c", join(dir, "ranger.yaml")], process.env, dir);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("--node must be a numeric id");
 });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import type { CiFailedRun } from "../src/forge.ts";

const RUNS: CiFailedRun[] = [
 { id: 9, name: "build", conclusion: "failure" },
 { id: 10, name: "lint", conclusion: "cancelled" },
 { id: 11, name: "test", conclusion: "failure" },
];

async function rerun(status: number) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gh-rerun-"));
 try {
  const callsPath = join(dir, "calls.jsonl");
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, "maps:\n  - repo: other-owner/other-map\n    root: 1\n    walk: full\n");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.RERUN_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.GH_TOKEN !== "machine") process.exit(95);
process.stdout.write("HTTP/2.0 ${status} Status\\r\\n\\r\\n{}");
if (${status} >= 400) { console.error("gh: Resource not accessible by integration (HTTP ${status})"); process.exit(1); }
`, { mode: 0o755 });
  const result = await runCmd(process.execPath, ["-e", `
import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config.ts"))};
import { lanePort } from ${JSON.stringify(join(import.meta.dir, "..", "src", "forge-lanes.ts"))};
const { config } = loadConfig(${JSON.stringify(configPath)});
const github = lanePort(config, config.maps[0].repo);
if (github.rerunFailedJobs === undefined) { console.error("no rerun call on the GitHub port"); process.exit(1); }
try { console.log(await github.rerunFailedJobs("other-owner/other-map", ${JSON.stringify(RUNS)}, "machine")); }
catch (error) { console.error(error.message); process.exit(1); }
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RERUN_CALLS: callsPath } });
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
 } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("node #521 — the GitHub port reruns the failed jobs of a red head", () => {
 test("one POST per job concluded failure, a cancelled job left alone, and the count returned", async () => {
  const result = await rerun(201);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("2");
  expect(result.calls).toEqual([
   ["api", "repos/other-owner/other-map/actions/jobs/9/rerun", "--method", "POST"],
   ["api", "repos/other-owner/other-map/actions/jobs/11/rerun", "--method", "POST"],
  ]);
 });

 test("a refusal names the job and does not retry the POST", async () => {
  const result = await rerun(403);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("rerun job 9");
  expect(result.stderr).toContain("HTTP 403");
  expect(result.calls).toEqual([["api", "repos/other-owner/other-map/actions/jobs/9/rerun", "--method", "POST"]]);
 });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

async function deletion(status: number, body = "") {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gh-delete-"));
 try {
  const callsPath = join(dir, "calls.jsonl");
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, "maps:\n  - repo: other-owner/other-map\n    root: 1\n    walk: full\n");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.DELETE_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.GH_TOKEN !== "machine") process.exit(95);
process.stdout.write("HTTP/2.0 ${status} Status\\r\\n\\r\\n");
process.stdout.write(${JSON.stringify(body)});
if (${status} >= 400) console.error("gh: " + ${JSON.stringify(body || "delete refused")} + " (HTTP ${status})");
process.exit(${status} >= 400 ? 1 : 0);
`, { mode: 0o755 });
  const result = await runCmd(process.execPath, ["-e", `
import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config.ts"))};
import { lanePort } from ${JSON.stringify(join(import.meta.dir, "..", "src", "forge-lanes.ts"))};
const { config } = loadConfig(${JSON.stringify(configPath)});
const github = lanePort(config, config.maps[0].repo);
try { await github.deleteBranch("other-owner/other-map", "node/470-some#branch", "machine"); }
catch (error) { console.error(error.message); process.exit(1); }
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DELETE_CALLS: callsPath } });
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  return { ...result, calls };
 } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("node #470 — production GitHub lane remote branch deletion", () => {
 test.each([
  { status: 204, body: "" },
  { status: 404, body: JSON.stringify({ message: "Not Found" }) },
  { status: 422, body: JSON.stringify({ message: "Reference does not exist" }) },
 ])("HTTP $status succeeds with one remote DELETE ($body)", async ({ status, body }) => {
  const result = await deletion(status, body);
  expect(result.code).toBe(0);
  expect(result.calls).toEqual([[
   "api", "repos/other-owner/other-map/git/refs/heads/node%2F470-some%23branch", "--method", "DELETE", "--include",
  ]]);
 });

 test.each([
  { status: 403, body: "" },
  { status: 500, body: "" },
  { status: 422, body: JSON.stringify({ message: "Cannot delete protected branch" }) },
  { status: 422, body: "" },
  { status: 422, body: "invalid JSON" },
  { status: 422, body: JSON.stringify({}) },
  { status: 422, body: "null" },
 ])("HTTP $status reports the reason without retrying deletion ($body)", async ({ status, body }) => {
  const result = await deletion(status, body);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`HTTP ${status}`);
  expect(result.stderr).toContain("delete branch node/470-some#branch");
  if (body) expect(result.stderr).toContain(body);
  expect(result.calls).toHaveLength(1);
 });
});

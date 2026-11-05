import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

async function deletion(status: number) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gh-delete-"));
 try {
  const callsPath = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.DELETE_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.GH_TOKEN !== "machine") process.exit(95);
process.stdout.write("HTTP/2.0 ${status} Status\\r\\n\\r\\n");
if (${status} >= 400) console.error("gh: delete refused (HTTP ${status})");
process.exit(${status} >= 400 ? 1 : 0);
`, { mode: 0o755 });
  const result = await runCmd(process.execPath, ["-e", `
import { deleteBranch } from ${JSON.stringify(join(import.meta.dir, "..", "src", "github.ts"))};
try { await deleteBranch("other-owner/other-map", "node/470-some#branch", "machine"); }
catch (error) { console.error(error.message); process.exit(1); }
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DELETE_CALLS: callsPath } });
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
  return { ...result, calls };
 } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("node #470 — GitHub remote branch deletion", () => {
 test.each([204, 404, 422])("HTTP %i succeeds with one remote DELETE", async status => {
  const result = await deletion(status);
  expect(result.code).toBe(0);
  expect(result.calls).toEqual([[
   "api", "repos/other-owner/other-map/git/refs/heads/node%2F470-some%23branch", "--method", "DELETE", "--include",
  ]]);
 });

 test.each([403, 500])("HTTP %i reports the reason without retrying deletion", async status => {
  const result = await deletion(status);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`HTTP ${status}`);
  expect(result.stderr).toContain("delete branch node/470-some#branch");
  expect(result.calls).toHaveLength(1);
 });
});

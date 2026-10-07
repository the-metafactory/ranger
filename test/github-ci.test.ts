import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

const SHA = "a".repeat(40);

/** Exercise the real gh adapter with isolated, already-paginated REST responses. */
async function readCi(method: string, pages: unknown) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gh-ci-"));
 try {
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.env.GH_TOKEN !== "machine" || !args.includes("--paginate") || !args.includes("--slurp")) process.exit(95);
console.log(process.env.CI_PAGES);
`, { mode: 0o755 });
  return await runCmd(process.execPath, ["-e", `
import * as gh from ${JSON.stringify(join(import.meta.dir, "..", "src", "github.ts"))};
try { console.log(JSON.stringify(await gh[process.env.CI_METHOD]("acme/widgets", ${JSON.stringify(SHA)}, "machine"))); }
catch (e) { console.error(e.message); process.exit(1); }
`], {
   env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CI_PAGES: JSON.stringify(pages), CI_METHOD: method },
  });
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
}

test("check runs include failures on later REST pages", async () => {
 const r = await readCi("checkRunsFor", [
  { check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] },
  { check_runs: [{ id: 2, name: "late", status: "completed", conclusion: "failure" }] },
 ]);
 expect(r.code).toBe(0);
 expect(JSON.parse(r.stdout)).toHaveLength(2);
 expect(JSON.parse(r.stdout)[1].conclusion).toBe("failure");
});

test("the GitHub port includes the cited run URL in a green verdict", async () => {
 const r = await readCi("ciVerdictFor", [
  { check_runs: [{ id: 17, name: "test", status: "completed", conclusion: "success" }] },
 ]);
 expect(r.code).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject({ state: "green", runId: 17, runUrl: "https://github.com/acme/widgets/runs/17" });
});

test("commit statuses include pending external CI on later pages", async () => {
 const r = await readCi("commitStatusesFor", [
  { statuses: [{ id: 1, context: "test", state: "success" }] },
  { statuses: [{ id: 2, context: "late", state: "pending" }] },
 ]);
 expect(r.code).toBe(0);
 expect(JSON.parse(r.stdout)[1]).toEqual({ id: 2, context: "late", state: "pending" });
});

const workflow = { id: 10, workflow_id: 1, head_sha: SHA, name: "test", status: "completed", conclusion: "failure", event: "push", run_attempt: 1 };

test("workflow pagination keeps the latest run per workflow and trigger", async () => {
 const r = await readCi("workflowRunsFor", [
  { total_count: 3, workflow_runs: [workflow] },
  { total_count: 3, workflow_runs: [{ ...workflow, id: 11, conclusion: "success" }, { ...workflow, id: 12, event: "pull_request", status: "queued", conclusion: null }] },
 ]);
 expect(r.code).toBe(0);
 expect(JSON.parse(r.stdout)).toMatchObject([
  { id: 11, conclusion: "success" }, { id: 12, status: "queued" },
 ]);
});

for (const page of [
 { total_count: 1000, workflow_runs: [] },
 { total_count: 1, workflow_runs: [{ ...workflow, head_sha: "other" }] },
 { total_count: 1 },
]) {
 test(`invalid or incomplete workflow evidence is refused: ${JSON.stringify(page)}`, async () => {
  expect((await readCi("workflowRunsFor", [page])).code).toBe(1);
 });
}

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveNode } from "../src/approve-node.ts";
import { approvalVersion } from "../src/approval-spec.ts";
import { loadConfig } from "../src/config.ts";
import type { RunOptions } from "../src/exec.ts";
import { runApproveAction } from "../src/serve-approve.ts";

const repo = "acme/widgets";
const spec = { autonomy: "approve", kind: "build", checkpointId: "cp-build" };
const prose = "## Deliverable\nBuild this.\n\n## Acceptance criteria\nTests pass.";
const body = `${prose}\n\n<!-- soma:work-graph-node\n${JSON.stringify(spec)}\n-->`;
const version = approvalVersion({ ...spec, title: "Build this" }, prose);
const directory = mkdtempSync(join(tmpdir(), "ranger-approve-test-"));
const configFile = join(directory, "config.yaml");
writeFileSync(configFile, JSON.stringify({ maps: [{ repo, root: 1, walk: "full" }], principal: { login: "alice" }, bot: { identity: "ivy-agent" } }));
const { config } = loadConfig(configFile);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function setup(over: Record<string, unknown> = {}, login = "alice") {
 let issue: Record<string, unknown> = { title: "Build this", body, state: "open", assignees: [], user: { login: "alice" }, ...over };
 const calls: { argv: string[]; opts: RunOptions }[] = [];
 const runner = async (command: string, args: string[], opts: RunOptions = {}) => {
  calls.push({ argv: [command, ...args], opts });
  if (args.includes("PATCH")) issue = { ...issue, ...JSON.parse(opts.stdin ?? "{}") };
  return { code: 0, stderr: "", stdout: JSON.stringify(args[1] === "user" ? { login } : issue) };
 };
 return { runner, calls, issue: () => issue };
}

test("approval under the principal releases only the pre-work gate and preserves the brief and checkpoint", async () => {
 const fixture = setup();
 await expect(approveNode({ config, map: config.maps[0], id: "12", version }, fixture.runner)).resolves.toEqual({ approved: true, dryRun: false });
 const saved = String(fixture.issue().body);
 expect(saved).toContain(prose);
 expect(saved).toContain('"autonomy": "propose"');
 expect(saved).toContain('"checkpointId": "cp-build"');
 expect(saved).toContain("Ranger execution approved by @alice");
 expect(fixture.calls.filter((c) => c.argv.includes("PATCH"))).toHaveLength(1);
 for (const call of fixture.calls) {
  expect(call.opts.env?.GH_TOKEN).toBeUndefined();
  expect(call.opts.env?.GH_CONFIG_DIR).toBeUndefined();
 }
});

for (const [name, changes, login] of [
 ["wrong identity", {}, "ivy-agent"],
 ["changed title", { title: "A different task" }, "alice"],
 ["changed scope", { body: body.replace("Build this.", "Deploy everything.") }, "alice"],
 ["claimed node", { assignees: [{ login: "worker" }] }, "alice"],
 ["closed node", { state: "closed" }, "alice"],
 ["untyped node", { body: prose }, "alice"],
 ["already approved", { body: body.replace('"approve"', '"propose"') }, "alice"],
 ["human decision", { body: body.replace('"build"', '"prototype"') }, "alice"],
 ["bot authored", { user: { login: "ivy-agent" } }, "alice"],
 ["unreadable author", { user: {} }, "alice"],
] as const) {
 test(`approval refuses ${name} without writing`, async () => {
  const fixture = setup(changes, login);
  await expect(approveNode({ config, map: config.maps[0], id: "12", version }, fixture.runner)).rejects.toThrow();
  expect(fixture.calls.some((c) => c.argv.includes("PATCH"))).toBe(false);
 });
}

test("a live validation dry run writes nothing", async () => {
 const fixture = setup();
 await approveNode({ config, map: config.maps[0], id: "12", version, dryRun: true }, fixture.runner);
 expect(fixture.calls).toHaveLength(2);
});

test("a node edited between validation and writing is refused", async () => {
 const fixture = setup();
 let reads = 0;
 const runner: typeof fixture.runner = async (command, args, opts) => {
  const result = await fixture.runner(command, args, opts);
  if (args[1] !== "user" && ++reads === 2) result.stdout = JSON.stringify({ ...fixture.issue(), body: body + "\nChanged." });
  return result;
 };
 await expect(approveNode({ config, map: config.maps[0], id: "12", version }, runner)).rejects.toThrow("changed during approval");
 expect(fixture.calls.some((c) => c.argv.includes("PATCH"))).toBe(false);
});

test("GitLab approval checks the host principal and preserves the issue description", async () => {
 const map = { ...config.maps[0], repo: "gitlab:git.example/acme/widgets" };
 const gitlabConfig = { ...config, principal: { ...config.principal, login: { "gitlab:git.example": "alice" } } };
 let issue = { title: "Build this", description: body, state: "opened", assignees: [], author: { username: "alice" } };
 const runner = async (command: string, args: string[], opts: RunOptions = {}) => {
  expect(command).toBe("glab");
  expect(args).toContain("git.example");
  if (args.includes("PUT")) issue = { ...issue, ...JSON.parse(opts.stdin ?? "{}") };
  return { code: 0, stderr: "", stdout: JSON.stringify(args[1] === "user" ? { username: "alice" } : issue) };
 };
 await approveNode({ config: gitlabConfig, map, id: "12", version }, runner);
 expect(issue.description).toContain('"autonomy": "propose"');
 expect(issue.description).toContain(prose);
});

test("the dashboard approval action uses the registered map, version and an allowlisted environment", async () => {
 const calls: string[][] = [];
 const deps = {
  maps: [{ key: repo + "#1", walk: "full", servedOnly: false, decisions: [{ id: "12", kind: "build", autonomy: "approve", approvalVersion: version, approvable: true }] }],
  configPath: "/tmp/ranger.yaml", rangerBin: "/bin/ranger", inFlight: new Set<string>(), env: { HOME: "/tmp", GH_TOKEN: "machine" },
  run: async (argv: string[], env: Record<string, string>) => {
   expect(env.GH_TOKEN).toBeUndefined();
   calls.push(argv);
   return { code: 0, stderr: "" };
  },
 };
 const result = await runApproveAction({ key: repo + "#1", id: "12", version }, deps);
 expect(result.status).toBe(200);
 expect(calls[0]).toEqual(["/bin/ranger", "approve-node", "12", "--map", repo + "#1", "--version", version, "-c", "/tmp/ranger.yaml"]);
 expect((await runApproveAction({ key: repo + "#1", id: "12", version: "0".repeat(64) }, deps)).status).toBe(409);
 expect((await runApproveAction({ key: repo + "#1", id: "12;false", version }, deps)).status).toBe(400);
 expect((await runApproveAction({ key: repo + "#1", id: "12", version }, { ...deps, maps: deps.maps.map((m) => ({ ...m, servedOnly: true })) })).status).toBe(409);
 expect(calls).toHaveLength(1);
});

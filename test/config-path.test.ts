import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigPath } from "../src/config.ts";
import { jobRunArgv } from "../src/jobs.ts";
import { buildNowArgv } from "../src/serve.ts";
import { runNodeArgv } from "../src/spawn.ts";
import { baseConfigLines, cliPath, runCli } from "./support.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ranger-config-path-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveConfigPath", () => {
 test("explicit absolute flag wins over RANGER_CONFIG", () => {
  expect(resolveConfigPath("/flag/ranger.yaml", { RANGER_CONFIG: "/env/ranger.yaml" }, dir))
   .toBe("/flag/ranger.yaml");
 });

 test("explicit relative flag resolves against cwd and wins over RANGER_CONFIG", () => {
  expect(resolveConfigPath("flag/ranger.yaml", { RANGER_CONFIG: "/env/ranger.yaml" }, dir))
   .toBe(join(dir, "flag/ranger.yaml"));
 });

 test("absent flag uses absolute RANGER_CONFIG", () => {
  expect(resolveConfigPath(undefined, { RANGER_CONFIG: "/env/ranger.yaml" }, dir))
   .toBe("/env/ranger.yaml");
 });

 test("relative RANGER_CONFIG resolves against cwd", () => {
  expect(resolveConfigPath(undefined, { RANGER_CONFIG: "../env/ranger.yaml" }, join(dir, "caller")))
   .toBe(join(dir, "env/ranger.yaml"));
 });

 test("absent flag and environment read ~/.config/ranger/ranger.yaml, not the working directory", () => {
  expect(resolveConfigPath(undefined, {}, dir)).toBe(join(homedir(), ".config", "ranger", "ranger.yaml"));
 });

 test("child commands carry the same absolute environment-selected path through --config", () => {
  const configPath = resolveConfigPath(undefined, { RANGER_CONFIG: "config/ranger.yaml" }, dir);
  const commands = [
   runNodeArgv({ cliEntry: cliPath, nodeId: "308", repo: "acme/widgets", root: 1, configPath }),
   jobRunArgv({ cliEntry: cliPath, runId: 1, configPath }),
   buildNowArgv({ bin: "ranger", nodeId: "308", key: "acme/widgets#1", configPath }),
  ];
  for (const argv of commands) {
   expect(argv.slice(-2)).toEqual(["--config", join(dir, "config/ranger.yaml")]);
  }
 });
});

describe("CLI config path", () => {
 test("job list outside the checkout reads RANGER_CONFIG without --config", async () => {
  const config = join(dir, "external.yaml");
  writeFileSync(config, baseConfigLines(dir).join("\n") + "\n");
  const cwd = join(dir, "empty-caller");
  mkdirSync(cwd);
  for (const path of [config, "../external.yaml"]) {
   const result = await runCli(["job", "list"], { ...process.env, RANGER_CONFIG: path }, cwd);
   expect(result.stderr).toBe("");
   expect(result.code).toBe(0);
   expect(JSON.parse(result.stdout)).toEqual([]);
  }
 });

 test("explicit --config overrides a missing environment-selected file", async () => {
  const cwd = join(dir, "flag-caller");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "selected.yaml"), baseConfigLines(cwd).join("\n") + "\n");
  const result = await runCli(["job", "list", "--config", "selected.yaml"], {
   ...process.env, RANGER_CONFIG: join(dir, "missing-env.yaml"),
  }, cwd);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
 });

 test("missing RANGER_CONFIG reports its path even when ~/.config/ranger/ranger.yaml exists", async () => {
  const cwd = join(dir, "default-caller");
  mkdirSync(cwd);
  const home = join(dir, "default-home");
  mkdirSync(join(home, ".config", "ranger"), { recursive: true });
  writeFileSync(join(home, ".config", "ranger", "ranger.yaml"), baseConfigLines(cwd).join("\n") + "\n");
  const missing = join(dir, "does-not-exist.yaml");
  const result = await runCli(["job", "list"], { ...process.env, HOME: home, RANGER_CONFIG: missing }, cwd);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`cannot read config at ${missing}`);

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.RANGER_CONFIG;
  const fallback = await runCli(["job", "list"], env, cwd);
  expect(fallback.stderr).toBe("");
  expect(fallback.code).toBe(0);
  expect(JSON.parse(fallback.stdout)).toEqual([]);
 });

 test("config option help names RANGER_CONFIG and the ~/.config/ranger fallback", async () => {
  const result = await runCli(["job", "list", "--help"], process.env, dir);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("$RANGER_CONFIG");
  expect(result.stdout).toContain("~/.config/ranger/ranger.yaml");
 });
});

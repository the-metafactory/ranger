import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { runNode } from "../src/worker.ts";
import { BOT, restoreEnv, rig } from "./implement-rig.ts";
import { GIT_ENV } from "./support.ts";

const cleanup: string[] = [];

afterEach(() => {
 for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
 restoreEnv();
});

test.each(["local hooksPath", "default hooks"])("gate tests run %s while worker and repo commands exclude global hooks", async mode => {
 const r = await rig({});
 cleanup.push(r.dir);
 const home = join(r.dir, "home"), globalHooks = join(home, "hooks");
 const globalMarker = join(r.dir, "global-hook-fired"), localMarker = join(r.dir, "repo-hook-fired");
 mkdirSync(globalHooks, { recursive: true });
 writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${globalHooks}\n[user]\n\tname = Principal\n\temail = principal@example.invalid\n`);
 writeFileSync(join(globalHooks, "pre-commit"), `#!/bin/sh\ntouch "${globalMarker}"\n`, { mode: 0o755 });
 const fixture = join(r.dir, "hook-fixture");
 mkdirSync(fixture);
 const controlEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...GIT_ENV };
 const git = async (args: string[]) => {
  const result = await runCmd("git", args, { cwd: fixture, env: controlEnv });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
 };
 await git(["init", "-b", "main"]);
 await git(["commit", "--allow-empty", "-m", "prove global hook is active"]);
 expect(existsSync(globalMarker)).toBe(true);
 rmSync(globalMarker);

 const hooks = join(fixture, mode === "local hooksPath" ? "repo-hooks" : ".git/hooks");
 mkdirSync(hooks, { recursive: true });
 if (mode === "local hooksPath") {
  const configPath = join(fixture, ".git/config");
  writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[core]\n\thooksPath = ${hooks}\n`);
 }
 writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${localMarker}"\n`, { mode: 0o755 });
 const script = join(r.dir, "test-hooks.sh");
 writeFileSync(script, [
  "set -eu",
  `cd "${fixture}"`,
  'git commit --allow-empty -m "repo test commit"',
  `test -f "${localMarker}"`,
  `test ! -e "${globalMarker}"`,
 ].join("\n"));
 r.ctx.map.commands.test = `sh "${script}"`;
 process.env.HOME = home;
 process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
 process.env.GIT_CONFIG_PARAMETERS = "'core.hooksPath'='/dev/null'";

 const outcome = await runNode("20", r.ctx);
 expect(existsSync(localMarker), outcome.detail).toBe(true);
 expect(existsSync(globalMarker)).toBe(false);
 expect(outcome.status, outcome.detail).toBe("awaiting-merge");
 const identity = await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
 expect(identity).toBe(`${BOT} <${BOT}@users.noreply.github.com>|${BOT} <${BOT}@users.noreply.github.com>`);
}, 60_000);

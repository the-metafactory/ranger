import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { runNode } from "../src/worker.ts";
import { BOT, implementWorker, restoreEnv, rig } from "./implement-rig.ts";
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

test("worker, install and gate tests use explicit repo git settings without global config", async () => {
 const r = await rig({});
 cleanup.push(r.dir);
 const home = join(r.dir, "home"), fixture = join(r.dir, "git-settings");
 mkdirSync(home);
 mkdirSync(fixture);
 const globalMarker = join(r.dir, "global-helper-fired");
 const globalHelper = join(r.dir, "global-helper");
 const localHelper = join(r.dir, "repo-helper");
 const globalExcludes = join(r.dir, "global-excludes");
 const localExcludes = join(r.dir, "repo-excludes");
 writeFileSync(globalHelper, `#!/bin/sh\ntouch "${globalMarker}"\nprintf 'username=principal\\npassword=principal\\n'\n`, { mode: 0o755 });
 writeFileSync(localHelper, "#!/bin/sh\nprintf 'username=fixture\\npassword=fixture\\n'\n", { mode: 0o755 });
 writeFileSync(globalExcludes, "global-cache\n");
 writeFileSync(localExcludes, "repo-cache\n");
 writeFileSync(join(home, ".gitconfig"), [
  "[credential]", `helper = ${globalHelper}`,
  `[url "${r.origin}"]`, "insteadOf = global-dependency",
  "[core]", `excludesFile = ${globalExcludes}`,
  "[safe]", "directory = *",
 ].join("\n"));
 const controlEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...GIT_ENV };
 const init = await runCmd("git", ["init", "-b", "main"], { cwd: fixture, env: controlEnv });
 expect(init.code, init.stderr).toBe(0);
 const credentialInput = "protocol=https\nhost=fixture.invalid\n\n";
 const control = await runCmd("git", ["credential", "fill"], { cwd: fixture, env: controlEnv, stdin: credentialInput });
 expect(control.code, control.stderr).toBe(0);
 expect(existsSync(globalMarker)).toBe(true);
 rmSync(globalMarker);
 const explicit = join(r.dir, "explicit-settings");
 const clone = await runCmd("git", ["clone", r.origin, explicit], { cwd: r.dir, env: controlEnv });
 expect(clone.code, clone.stderr).toBe(0);
 const configPath = join(explicit, ".git/config");
 writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n[credential]\nhelper = ${localHelper}\n[url "${r.origin}"]\ninsteadOf = repo-dependency\n[core]\nexcludesFile = ${localExcludes}\n`);
 writeFileSync(join(fixture, "global-cache"), "global ignore must not hide this\n");
 writeFileSync(join(explicit, "repo-cache"), "repo ignore applies\n");
 const script = join(r.dir, "check-git-settings.sh");
 writeFileSync(script, [
  "set -eu",
  `cd "${fixture}"`,
  "for key in '^credential\\.helper$' '^core\\.excludesfile$' '^safe\\.directory$' '^url\\..*\\.insteadof$'; do",
  ' if git config --get-regexp "$key"; then exit 1; fi',
  "done",
  "test \"$(git status --porcelain)\" = '?? global-cache'",
  `cd "${explicit}"`,
  `printf '${credentialInput.replaceAll("\n", "\\n")}' | git credential fill > "${r.dir}/credentials-$1"`,
  `grep -qx 'username=fixture' "${r.dir}/credentials-$1"`,
  `grep -qx 'password=fixture' "${r.dir}/credentials-$1"`,
  `git ls-remote repo-dependency HEAD > "${r.dir}/dependency-$1"`,
  `test -s "${r.dir}/dependency-$1"`,
  "test \"$(git check-ignore repo-cache)\" = repo-cache",
  `test ! -e "${globalMarker}"`,
  `touch "${r.dir}/checked-$1"`,
 ].join("\n"));
 process.env.HOME = home;
 process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
 process.env.GIT_CONFIG_NOSYSTEM = "1";
 r.ctx.map.commands.install = `sh "${script}" install`;
 r.ctx.map.commands.test = `sh "${script}" test`;
 r.ctx.worker = async (prompt, opts) => {
  const check = await runCmd("sh", [script, "worker"], opts);
  expect(check.code, check.stderr).toBe(0);
  return runCmd(implementWorker, ["build", prompt], opts);
 };
 const outcome = await runNode("20", r.ctx);
 expect(outcome.status, outcome.detail).toBe("awaiting-merge");
 for (const stage of ["worker", "install", "test"]) expect(existsSync(join(r.dir, `checked-${stage}`))).toBe(true);
 expect(existsSync(globalMarker)).toBe(false);
}, 60_000);

test("a repo commit hook that leaves an untracked build cache fails before tests or push", async () => {
 const r = await rig({});
 cleanup.push(r.dir);
 const hook = join(r.canonical, ".git/hooks/pre-commit");
 writeFileSync(hook, "#!/bin/sh\nprintf 'built by repo hook\\n' > hook-build-cache\n", { mode: 0o755 });
 const tested = join(r.dir, "tests-ran");
 r.ctx.map.commands.test = `touch "${tested}"`;
 const outcome = await runNode("20", r.ctx);
 const worktree = r.journal.getWorker("20", "acme/widgets")!.worktree!;
 expect(readFileSync(join(worktree, "hook-build-cache"), "utf8")).toBe("built by repo hook\n");
 expect(outcome.status, outcome.detail).toBe("failed");
 expect(outcome.detail).toContain("uncommitted or untracked");
 expect(outcome.detail).toContain("hook-build-cache");
 expect(existsSync(tested)).toBe(false);
 expect(r.github.prs.size).toBe(0);
 expect(await r.github.sha("node/20-add-the-feature-module")).toBe("");
}, 60_000);

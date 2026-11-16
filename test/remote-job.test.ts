import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { ConfigError, loadConfig } from "../src/config.ts";
import { remoteJobArgv, remoteJobResult, REMOTE_KILL_GRACE_S, REMOTE_RESULT_MARK, REMOTE_TIMED_OUT } from "../src/remote-job.ts";

const spec = { host: "macjcf.local", cwd: "~/work/abacus-timesheet", name: "abacus-friday", runId: 7, wallClockMin: 60 };

function runScript(script: string, home: string) {
 return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: home } });
}

function goneWithin(pattern: string, ms: number): boolean {
 const end = Date.now() + ms;
 while (Date.now() < end) {
  if (spawnSync("pgrep", ["-f", pattern]).status === 1) return true;
  spawnSync("/bin/sleep", ["0.2"]);
 }
 return spawnSync("pgrep", ["-f", pattern]).status === 1;
}

function withRemoteHome(scenario: (home: string, cwd: string) => void, makeCwd = true) {
 const home = mkdtempSync(join(tmpdir(), "ranger-remote-"));
 const cwd = join(home, "work/abacus-timesheet");
 try {
  if (makeCwd) mkdirSync(cwd, { recursive: true });
  scenario(home, cwd);
 } finally {
  rmSync(home, { recursive: true, force: true });
 }
}

describe("jobs on another host", () => {
 test("the session runs over ssh in batch mode, never asking for a password", () => {
  const argv = remoteJobArgv(spec, ["pi", "-p", "--model", "spark/longctx-think"], "Read the skill");
  expect(argv.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "macjcf.local"]);
  expect(argv).toHaveLength(7);
 });

 test("on the host it runs the worker in the job's cwd, logs there, and prints only the log path and the result", () => {
  withRemoteHome((home, cwd) => {
   const worker = join(home, "worker.sh");
   writeFileSync(worker, `pwd\necho "hours for Mo: 8111200 4.0"\nprintf 'soma:outputs/G8-2026-w47.md\\n' > "$RANGER_JOB_RESULT_FILE"\n`);
   const script = remoteJobArgv(spec, ["/bin/sh", worker], "prompt text").at(-1)!;
   const run = runScript(script, home);
   expect(run.status).toBe(0);
   expect(run.stdout).not.toContain("hours for Mo");
   expect(remoteJobResult(run.stdout)).toBe("soma:outputs/G8-2026-w47.md");
   const logPath = /remote log: [^:]+:(\S+)/.exec(run.stdout)?.[1];
   expect(logPath).toBe(join(home, ".local/state/ranger-jobs/abacus-friday-7.log"));
   const log = readFileSync(logPath!, "utf8");
   expect(log).toContain("hours for Mo: 8111200 4.0");
   expect(log).toContain(join(home, "work/abacus-timesheet"));
  });
 });

 test("the worker's exit code comes back, and a run with no result has none", () => {
  withRemoteHome((home, cwd) => {
   const script = remoteJobArgv(spec, ["/bin/sh", "-c", "exit 3"], "").at(-1)!;
   const run = runScript(script, home);
   expect(run.status).toBe(3);
   expect(remoteJobResult(run.stdout)).toBeNull();
  });
 });

 test("a missing cwd on the host fails before the worker starts", () => {
  withRemoteHome((home, cwd) => {
   const script = remoteJobArgv(spec, ["/bin/sh", "-c", "exit 0"], "").at(-1)!;
   expect(runScript(script, home).status).toBe(97);
  }, false);
 });

 test("the host stops the worker at the wall clock and reports a timeout, not a success", () => {
  withRemoteHome((home, cwd) => {
   const script = remoteJobArgv({ ...spec, wallClockMin: 1 / 60 }, ["/bin/sh", "-c", "/bin/sleep 30"], "prompt").at(-1)!;
   const started = Date.now();
   const run = runScript(script, home);
   expect(Date.now() - started).toBeLessThan(10_000);
   expect(run.status).toBe(REMOTE_TIMED_OUT);
   expect(remoteJobResult(run.stdout)).toBeNull();
  });
 });

 test("the session log is readable by its owner only", () => {
  withRemoteHome((home, cwd) => {
   const script = remoteJobArgv(spec, ["/bin/sh", "-c", "echo secret"], "").at(-1)!;
   runScript(script, home);
   expect(statSync(join(home, ".local/state/ranger-jobs")).mode & 0o777).toBe(0o700);
   expect(statSync(join(home, ".local/state/ranger-jobs/abacus-friday-7.log")).mode & 0o777).toBe(0o600);
  });
 });

 test("prompt and arguments reach the worker as single words, whatever they contain", () => {
  withRemoteHome((home, cwd) => {
   const worker = join(home, "args.sh");
   writeFileSync(worker, `printf '%s|' "$@" > "$RANGER_JOB_RESULT_FILE"\n`);
   const script = remoteJobArgv(spec, ["/bin/sh", worker, "a b"], "it's $HOME; `x`").at(-1)!;
   const run = runScript(script, home);
   expect(remoteJobResult(run.stdout)).toBe("a b|it's $HOME; `x`|");
  });
 });

 test("only the marked line is the result", () => {
  expect(remoteJobResult(`remote log: h:/x.log\n${REMOTE_RESULT_MARK} soma:outputs/a.md\n`)).toBe("soma:outputs/a.md");
  expect(remoteJobResult("soma:outputs/a.md\n")).toBeNull();
 });

 const onMac = process.platform === "darwin";
 const loginSpec = () => ({ ...spec, session: "login" as const, runId: 900_000 + Math.floor(Math.random() * 99_999) });
 const labelGone = (runId: number) => spawnSync("launchctl", ["list", `ranger-job.abacus-friday.${runId}`]).status !== 0;

 test.skipIf(!onMac)("login: the worker runs as a launchd job in the user's session, and its label is gone afterwards", () => {
  withRemoteHome((home, cwd) => {
   const s = loginSpec();
   const worker = join(home, "worker.sh");
   writeFileSync(worker, `pwd\necho "launchd says hello"\nprintf 'soma:outputs/G8-2026-w46.md\\n' > "$RANGER_JOB_RESULT_FILE"\n`);
   const run = runScript(remoteJobArgv(s, ["/bin/sh", worker], "prompt").at(-1)!, home);
   expect(run.status).toBe(0);
   expect(remoteJobResult(run.stdout)).toBe("soma:outputs/G8-2026-w46.md");
   expect(run.stdout).not.toContain("launchd says hello");
   const log = readFileSync(join(home, `.local/state/ranger-jobs/abacus-friday-${s.runId}.log`), "utf8");
   expect(log).toContain("launchd says hello");
   expect(log).toContain(cwd);
   expect(labelGone(s.runId)).toBe(true);
  });
 }, 30_000);

 for (const session of ["ssh", "login"] as const) {
  const skip = session === "login" && !onMac;
  const specFor = () => ({ ...spec, session, runId: 900_000 + Math.floor(Math.random() * 99_999) });

  test.skipIf(skip)(`${session}: a worker that ignores TERM is killed with its children at the deadline, with exit 124 and no result`, () => {
   withRemoteHome(home => {
    const s = { ...specFor(), wallClockMin: 1 / 60 };
    const marker = `sleep ${40 + (s.runId % 1000) / 100}`;
    const worker = join(home, "stubborn.sh");
    writeFileSync(worker, `trap '' TERM\nprintf 'soma:outputs/late.md\\n' > "$RANGER_JOB_RESULT_FILE"\n/bin/${marker} &\nwait\n`);
    const started = Date.now();
    const run = runScript(remoteJobArgv(s, ["/bin/sh", worker], "prompt").at(-1)!, home);
    expect(Date.now() - started).toBeLessThan((REMOTE_KILL_GRACE_S + 8) * 1000);
    expect(run.status).toBe(REMOTE_TIMED_OUT);
    expect(remoteJobResult(run.stdout)).toBeNull();
    expect(goneWithin(marker, 3000)).toBe(true);
    if (session === "login") expect(labelGone(s.runId)).toBe(true);
   });
  }, 40_000);

  test.skipIf(skip)(`${session}: the worker gets only the allowlisted environment of the host`, () => {
   withRemoteHome((home, cwd) => {
    const script = remoteJobArgv(specFor(), ["/bin/sh", "-c", "env > env.txt"], "prompt").at(-1)!;
    spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, GH_TOKEN: "gh-secret", RANGER_DISCORD_TOKEN: "d-secret", FOO: "x", OPENROUTER_API_KEY: "kept" } });
    const seen = readFileSync(join(cwd, "env.txt"), "utf8");
    expect(seen).not.toContain("gh-secret");
    expect(seen).not.toContain("d-secret");
    expect(seen).not.toContain("FOO=");
    expect(seen).toContain("OPENROUTER_API_KEY=kept");
    expect(seen).toContain(`HOME=${home}`);
   });
  }, 30_000);
 }

 test("ranger.yaml: a job host is a plain host name, never an ssh option", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-remote-cfg-"));
  try {
   const load = (host: string | undefined, extra: Record<string, unknown> = {}) => {
    const path = join(dir, "ranger.yaml");
    writeFileSync(path, stringify({
     version: 1,
     maps: [{ repo: "acme/x", root: 1, walk: "full" }],
     state: { journalPath: join(dir, "s.sqlite") },
     jobs: [{ name: "abacus-friday", skill: "abacus-friday", lane: "headless", wallClockMin: 60, cwd: "~/work/abacus-timesheet", substrates: ["pi"], ...(host === undefined ? {} : { host }), ...extra }],
    }));
    return loadConfig(path, {}).config;
   };
   expect(load("macjcf.local").jobs?.[0]?.host).toBe("macjcf.local");
   expect(load("macjcf.local", { hostSession: "login" }).jobs?.[0]?.hostSession).toBe("login");
   expect(() => load(undefined, { hostSession: "login" })).toThrow(ConfigError);
   expect(load("macjcf.local", { pi: { provider: "spark", model: "longctx-think" } }).jobs?.[0]?.pi).toEqual({ provider: "spark", model: "longctx-think" });
   expect(() => load("macjcf.local", { pi: { provider: "spark", model: "longctx-think" }, substrates: ["pi", "claude"] })).toThrow(ConfigError);
   expect(() => load("macjcf.local", { pi: { provider: "spark; rm", model: "x" } })).toThrow(ConfigError);
   expect(() => load("-oProxyCommand=evil")).toThrow(ConfigError);
   expect(() => load("a b")).toThrow(ConfigError);
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

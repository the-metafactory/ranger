import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessGroup, pidAlive, runCmd } from "../src/exec.ts";

function observeGroupKills(getPid: () => number, miss: (attempt: number) => boolean = () => false) {
  const realKill = process.kill.bind(process);
  const outcomes: string[] = [];
  const signal = spyOn(process, "kill").mockImplementation((target, sig) => {
    const pid = getPid();
    if (pid <= 0 || target !== -pid || sig !== "SIGKILL") return realKill(target, sig);
    try {
      if (miss(outcomes.length + 1)) {
        throw Object.assign(new Error("group not ready"), { code: "ESRCH" });
      }
      const result = realKill(target, sig);
      outcomes.push("killed");
      return result;
    } catch (error) {
      outcomes.push((error as NodeJS.ErrnoException).code ?? "unknown");
      throw error;
    }
  });
  return { signal, realKill, outcomes };
}

function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
}

function releaseFileLater(path: string) {
  let timer: ReturnType<typeof setTimeout>;
  const released = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      writeFileSync(path, "release");
      resolve();
    }, 100);
  });
  return { timer: timer!, released };
}

async function withFixture(prefix: string, run: (fixture: {
  dir: string;
  gate: string;
  ready: string;
  marker: string;
  pid: number;
  release?: ReturnType<typeof releaseFileLater>;
}) => Promise<void>) {
  const realKill = process.kill.bind(process);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const fixture = {
    dir,
    gate: join(dir, "release"),
    ready: join(dir, "ready"),
    marker: join(dir, "grandchild-ran"),
    pid: 0,
    release: undefined as ReturnType<typeof releaseFileLater> | undefined,
  };
  try {
    await run(fixture);
  } finally {
    if (fixture.release !== undefined) clearTimeout(fixture.release.timer);
    killProcessGroup(fixture.pid);
    if (fixture.pid > 0 && pidAlive(fixture.pid)) realKill(fixture.pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runCmd process-group timeout cleanup", () => {
  test("cleanup before onSpawn removes the fixture without signaling the runner", async () => {
    let dir = "";
    const failure = new Error("failed before onSpawn");
    const signal = spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(withFixture("ranger-before-spawn-", async (fixture) => {
        dir = fixture.dir;
        expect(fixture.pid).toBe(0);
        throw failure;
      })).rejects.toBe(failure);
      expect(signal).not.toHaveBeenCalled();
      expect(dir).not.toBe("");
      expect(existsSync(dir)).toBe(false);
    } finally {
      signal.mockRestore();
    }
  });

  test("a transient group miss kills the child and retries before a forked grandchild can run", () => withFixture("ranger-group-kill-", async (fixture) => {
    const { gate, marker, ready } = fixture;
    let aliveAtMiss = false;
    const { signal, realKill, outcomes } = observeGroupKills(() => fixture.pid, (attempt) => {
      if (attempt === 1) {
        aliveAtMiss = pidAlive(fixture.pid);
        fixture.release = releaseFileLater(gate);
        return true;
      }
      return false;
    });
    try {
      const result = await runCmd("/bin/sh", ["-c", '( touch "$3"; while [ ! -f "$1" ]; do sleep 0.01; done; touch "$2" ) & wait', "stub", gate, marker, ready], {
        processGroup: true,
        timeoutMs: 300,
        onSpawn: (spawned) => {
          fixture.pid = spawned;
          waitForFile(ready);
        },
      });
      await fixture.release?.released;
      expect(result.timedOut).toBe(true);
      expect(existsSync(ready)).toBe(true);
      expect(aliveAtMiss).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(pidAlive(fixture.pid)).toBe(false);
      expect(outcomes).toEqual(["ESRCH", "killed"]);
      expect(() => realKill(-fixture.pid, 0)).toThrow();
    } finally {
      signal.mockRestore();
    }
  }));

  test("a genuinely absent group kills the live child before it can fork, even when the retry also gets ESRCH", () => withFixture("ranger-no-group-", async (fixture) => {
    const { dir, gate, ready, marker } = fixture;
    const stub = join(dir, "stub.ts");
    writeFileSync(stub, `
      import { existsSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(ready)}, "ready");
      const timer = setInterval(async () => {
        if (!existsSync(${JSON.stringify(gate)})) return;
        clearInterval(timer);
        const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.write(${JSON.stringify(marker)}, "escaped")`)}]);
        await child.exited;
      }, 10);
    `);
    let aliveAtMiss = false;
    const { signal, realKill, outcomes } = observeGroupKills(() => fixture.pid, (attempt) => {
      if (attempt === 1) aliveAtMiss = pidAlive(fixture.pid);
      return false;
    });
    const spawn = childProcess.spawn;
    const launch = spyOn(childProcess, "spawn").mockImplementation(((
      bin: string,
      args: readonly string[],
      opts: childProcess.SpawnOptions,
    ) => spawn(bin, args, { ...opts, detached: false })) as typeof spawn);
    try {
      const pending = runCmd(process.execPath, [stub], {
        processGroup: true,
        timeoutMs: 0,
        onSpawn: (spawned) => {
          fixture.pid = spawned;
          waitForFile(ready);
        },
      });
      launch.mockRestore();
      expect(existsSync(ready)).toBe(true);
      expect(pidAlive(fixture.pid)).toBe(true);
      expect(() => realKill(-fixture.pid, 0)).toThrow();
      fixture.release = releaseFileLater(gate);
      const result = await pending;
      await fixture.release.released;
      expect(result.timedOut).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(result.code).not.toBe(0);
      expect(aliveAtMiss).toBe(true);
      expect(pidAlive(fixture.pid)).toBe(false);
      expect(outcomes).toEqual(["ESRCH", "ESRCH"]);
    } finally {
      launch.mockRestore();
      signal.mockRestore();
    }
  }));
});

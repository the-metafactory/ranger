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

describe("runCmd process-group timeout cleanup", () => {
  test("a transient group miss kills the child and retries before a forked grandchild can run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-group-kill-"));
    const gate = join(dir, "release");
    const marker = join(dir, "grandchild-ran");
    const ready = join(dir, "ready");
    let pid = 0;
    let aliveAtMiss = false;
    let release: ReturnType<typeof releaseFileLater> | undefined;
    const { signal, realKill, outcomes } = observeGroupKills(() => pid, (attempt) => {
      if (attempt === 1) {
        aliveAtMiss = pidAlive(pid);
        release = releaseFileLater(gate);
        return true;
      }
      return false;
    });
    try {
      const result = await runCmd("/bin/sh", ["-c", '( touch "$3"; while [ ! -f "$1" ]; do sleep 0.01; done; touch "$2" ) & wait', "stub", gate, marker, ready], {
        processGroup: true,
        timeoutMs: 300,
        onSpawn: (spawned) => {
          pid = spawned;
          waitForFile(ready);
        },
      });
      await release?.released;
      expect(result.timedOut).toBe(true);
      expect(existsSync(ready)).toBe(true);
      expect(aliveAtMiss).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(pidAlive(pid)).toBe(false);
      expect(outcomes).toEqual(["ESRCH", "killed"]);
      expect(() => realKill(-pid, 0)).toThrow();
    } finally {
      signal.mockRestore();
      if (release !== undefined) clearTimeout(release.timer);
      killProcessGroup(pid);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a genuinely absent group kills the live child before it can fork, even when the retry also gets ESRCH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-no-group-"));
    const gate = join(dir, "release");
    const ready = join(dir, "ready");
    const marker = join(dir, "grandchild-ran");
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
    let pid = 0;
    let aliveAtMiss = false;
    const { signal, realKill, outcomes } = observeGroupKills(() => pid, (attempt) => {
      if (attempt === 1) aliveAtMiss = pidAlive(pid);
      return false;
    });
    const spawn = childProcess.spawn;
    const launch = spyOn(childProcess, "spawn").mockImplementation(((
      bin: string,
      args: readonly string[],
      opts: childProcess.SpawnOptions,
    ) => spawn(bin, args, { ...opts, detached: false })) as typeof spawn);
    let release: ReturnType<typeof releaseFileLater> | undefined;
    try {
      const pending = runCmd(process.execPath, [stub], {
        processGroup: true,
        timeoutMs: 0,
        onSpawn: (spawned) => {
          pid = spawned;
          waitForFile(ready);
        },
      });
      launch.mockRestore();
      expect(existsSync(ready)).toBe(true);
      expect(pidAlive(pid)).toBe(true);
      expect(() => realKill(-pid, 0)).toThrow();
      release = releaseFileLater(gate);
      const result = await pending;
      await release.released;
      expect(result.timedOut).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(result.code).not.toBe(0);
      expect(aliveAtMiss).toBe(true);
      expect(pidAlive(pid)).toBe(false);
      expect(outcomes).toEqual(["ESRCH", "ESRCH"]);
    } finally {
      launch.mockRestore();
      signal.mockRestore();
      if (release !== undefined) clearTimeout(release.timer);
      if (pidAlive(pid)) realKill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

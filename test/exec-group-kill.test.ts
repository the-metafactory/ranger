import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessGroup, pidAlive, runCmd } from "../src/exec.ts";

describe("runCmd process-group timeout cleanup", () => {
  test("a missing group kills the child and retries before a forked grandchild can run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranger-group-kill-"));
    const gate = join(dir, "release");
    const marker = join(dir, "grandchild-ran");
    const ready = join(dir, "ready");
    const kill = process.kill.bind(process);
    let pid = 0;
    let groupAttempts = 0;
    let aliveAtMiss = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    let released: Promise<void> = Promise.resolve();
    const signal = spyOn(process, "kill").mockImplementation((target, sig) => {
      if (pid > 0 && target === -pid && sig === "SIGKILL") {
        groupAttempts++;
        if (groupAttempts === 1) {
          aliveAtMiss = pidAlive(pid);
          released = new Promise((resolve) => {
            release = setTimeout(() => {
              writeFileSync(gate, "release");
              resolve();
            }, 100);
          });
          throw Object.assign(new Error("group not ready"), { code: "ESRCH" });
        }
      }
      return kill(target, sig);
    });
    try {
      const result = await runCmd("/bin/sh", ["-c", '( touch "$3"; while [ ! -f "$1" ]; do sleep 0.01; done; touch "$2" ) & wait', "stub", gate, marker, ready], {
        processGroup: true,
        timeoutMs: 300,
        onSpawn: (spawned) => {
          pid = spawned;
          const deadline = Date.now() + 10_000;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
        },
      });
      await released;
      expect(result.timedOut).toBe(true);
      expect(existsSync(ready)).toBe(true);
      expect(aliveAtMiss).toBe(true);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(pidAlive(pid)).toBe(false);
      expect(groupAttempts).toBeGreaterThanOrEqual(2);
      expect(() => kill(-pid, 0)).toThrow();
    } finally {
      signal.mockRestore();
      if (release !== undefined) clearTimeout(release);
      killProcessGroup(pid);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an immediate timeout still kills the direct child when no group is found", async () => {
    const kill = process.kill.bind(process);
    let pid = 0;
    let attempts = 0;
    const signal = spyOn(process, "kill").mockImplementation((target, sig) => {
      if (pid > 0 && target === -pid && sig === "SIGKILL") {
        attempts++;
        throw Object.assign(new Error("group not ready"), { code: "ESRCH" });
      }
      return kill(target, sig);
    });
    try {
      const result = await runCmd("/bin/sh", ["-c", "exec sleep 1"], {
        processGroup: true,
        timeoutMs: 0,
        onSpawn: (spawned) => { pid = spawned; },
      });
      expect(result.timedOut).toBe(true);
      expect(result.code).not.toBe(0);
      expect(pidAlive(pid)).toBe(false);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      signal.mockRestore();
      killProcessGroup(pid);
    }
  });
});

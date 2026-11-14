import { expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fs = { ...realFs };
let beforeLockUnlink: (() => void) | null = null;
let lockPath = "";

mock.module("node:fs", () => ({
  ...fs,
  rmSync: (path: realFs.PathLike, opts?: realFs.RmOptions) => {
    if (path === lockPath && beforeLockUnlink !== null) {
      const step = beforeLockUnlink;
      beforeLockUnlink = null;
      step();
    }
    return fs.rmSync(path, opts);
  },
}));

const lock = await import("../../../../src/lock.ts");

function owner(name: string): string {
  return JSON.stringify({ nonce: name, pid: process.pid, startedAt: Date.now(), leaseUntil: Date.now() + 60_000 });
}

function nonce(): string {
  return (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { nonce: string }).nonce;
}

test("TLC trace: a reclaim that read a missing lock unlinks the lock a third process just created", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "lease-replay-"));
  lockPath = join(dir, ".claim.lock");
  const marker = `${lockPath}.reclaiming`;

  const p1 = await lock.acquireLease(lockPath, marker);
  expect(lock.tryAcquireLock(lockPath, owner("p2"))).toBe(false);
  const hb = lock.startHeartbeat(p1);
  lock.releaseLease(p1, hb.heartbeat, hb.lostOwnership);
  expect(lock.lockOwnerStale(lockPath)).toBe(true);

  let p3Holds = false;
  beforeLockUnlink = () => {
    p3Holds = lock.tryAcquireLock(lockPath, owner("p3"));
  };
  const p2 = lock.reclaimDeadLock(lockPath, marker, owner("p2"));

  expect(p3Holds).toBe(true);
  expect(p2).toBe("acquired");
  expect(nonce()).toBe("p2");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("TLC trace: a reclaim that read a half-written lock unlinks it once its writer finishes", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "lease-replay-"));
  lockPath = join(dir, ".claim.lock");
  const marker = `${lockPath}.reclaiming`;

  const p1fd = fs.openSync(lockPath, "wx");
  expect(lock.tryAcquireLock(lockPath, owner("p2"))).toBe(false);
  expect(lock.lockOwnerStale(lockPath)).toBe(true);

  beforeLockUnlink = () => {
    fs.writeSync(p1fd, owner("p1"));
    fs.closeSync(p1fd);
    expect(nonce()).toBe("p1");
  };
  const p2 = lock.reclaimDeadLock(lockPath, marker, owner("p2"));

  expect(p2).toBe("acquired");
  expect(nonce()).toBe("p2");
  fs.rmSync(dir, { recursive: true, force: true });
});

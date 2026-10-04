import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";

describe("Journal — SQLite state (design §8)", () => {
 test("workers: upsert, read, list by repo, attempts bump", () => {
  const j = new Journal(":memory:");
  j.upsertWorker({ root: 1, nodeId: "10", repo: "acme/widgets", status: "claimed", attempts: 0 });
  let row = j.getWorker("10", "acme/widgets");
  expect(row?.status).toBe("claimed");
  expect(row?.repo).toBe("acme/widgets");

  j.upsertWorker({ root: 1, nodeId: "10", repo: "acme/widgets", status: "running", attempts: 1, pid: 4242, worktree: "/tmp/wt" });
  row = j.getWorker("10", "acme/widgets");
  expect(row?.status).toBe("running");
  expect(row?.attempts).toBe(1);
  expect(row?.pid).toBe(4242);

  expect(j.listWorkers("acme/widgets")).toHaveLength(1);
  expect(j.listWorkers("other/repo")).toHaveLength(0);
  j.close();
 });

 test("events are append-only, newest first", () => {
  const j = new Journal(":memory:");
  j.recordEvent("announced", { nodeId: "10", repo: "acme/widgets", detail: "msg-1" });
  j.recordEvent("claimed", { nodeId: "10", repo: "acme/widgets", detail: "by bot" });
  const events = j.listEvents("acme/widgets");
  expect(events).toHaveLength(2);
  expect(events[0].kind).toBe("claimed"); // newest first
  expect(events[1].kind).toBe("announced");
  j.close();
 });

 test("dead-man counter: reset, bump, threshold is the caller's, pause is sticky", () => {
  const j = new Journal(":memory:");
  expect(j.deadmanCount()).toBe(0);
  expect(j.bumpDeadman()).toBe(1);
  expect(j.bumpDeadman()).toBe(2);
  expect(j.deadmanCount()).toBe(2);
  j.resetDeadman();
  expect(j.deadmanCount()).toBe(0);
  expect(j.isPaused()).toBe(false);
  j.setPaused(true);
  expect(j.isPaused()).toBe(true);
  j.close();
 });

 test("spawn ledger is day-keyed", () => {
  const j = new Journal(":memory:");
  const now = new Date("2026-08-16T12:00:00Z");
  expect(j.spawnsToday(now)).toBe(0);
  j.recordSpawn(now);
  j.recordSpawn(now);
  expect(j.spawnsToday(now)).toBe(2);
  const later = new Date("2026-08-17T08:00:00Z");
  expect(j.spawnsToday(later)).toBe(0);
  j.close();
 });

 test("one node's events read through the (repo, node_id, id) index, not a journal scan (node #54)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-events-idx-"));
  try {
   const path = join(dir, "state.sqlite");
   const j = new Journal(path);
   j.recordEvent("parked", { nodeId: "54", repo: "acme/widgets", detail: "review cap" });
   j.recordEvent("parked", { nodeId: "55", repo: "acme/widgets", detail: "other" });
   expect(j.listNodeEvents("acme/widgets", "54").map((e) => e.nodeId)).toEqual(["54"]);
   j.close();
   const raw = new Database(path, { readonly: true });
   const plan = raw
    .query("EXPLAIN QUERY PLAN SELECT * FROM events WHERE repo = ? AND node_id = ? ORDER BY id DESC LIMIT 60")
    .all("acme/widgets", "54") as { detail: string }[];
   raw.close();
   const steps = plan.map((r) => r.detail).join(" | ");
   expect(steps).toContain("events_repo_node_id_idx");
   expect(steps).not.toContain("TEMP B-TREE");
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test("vetoes are durable (journal is a cache of the node comment record)", () => {
  const j = new Journal(":memory:");
  expect(j.hasVeto("5")).toBe(false);
  j.recordVeto("5", "comment-123", "principal 👎");
  expect(j.hasVeto("5")).toBe(true);
  j.close();
 });
});

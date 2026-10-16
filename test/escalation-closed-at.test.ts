import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Journal } from "../src/journal.ts";
import { seedLegacyRoots } from "../src/store/legacy-roots.ts";

const card = {
 key: "acme/widgets:332", repo: "acme/widgets", root: 1, nodeId: "332",
 messageId: "card-332", createdAt: "2026-10-01T08:00:00.000Z",
};
const firstClose = "2026-10-16T09:00:00.000Z";
const later = "2026-10-17T10:00:00.000Z";

describe("escalation close times", () => {
 let dir: string;
 let path: string;
 let journal: Journal | undefined;
 beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ranger-escalation-closed-at-"));
  path = join(dir, "journal.sqlite");
 });
 afterEach(() => {
  journal?.close();
  journal = undefined;
  rmSync(dir, { recursive: true, force: true });
 });

 test("open inserts and edits need no closedAt and persist null", () => {
  journal = new Journal(path);
  journal.upsertEscalation(card);
  expect(journal.getEscalation(card.repo, card.nodeId)).toMatchObject({ status: "open", closedAt: null });
  journal.upsertEscalation({ ...card, status: "open", lastEditedAt: later });
  expect(journal.getEscalation(card.repo, card.nodeId)?.closedAt).toBeNull();
  const raw = new Database(path, { readonly: true });
  try {
   expect(raw.query("SELECT closed_at FROM escalations WHERE key = ?").get(card.key)).toEqual({ closed_at: null });
  } finally { raw.close(); }
 });

 test("closing an open row without closedAt records the transition's ISO time", () => {
  journal = new Journal(path);
  journal.upsertEscalation(card);
  const before = Date.now();
  journal.upsertEscalation({ ...card, status: "closed" });
  const after = Date.now();
  const row = journal.getEscalation(card.repo, card.nodeId)!;
  expect(row.status).toBe("closed");
  expect(row.closedAt).not.toBeNull();
  expect(new Date(row.closedAt!).toISOString()).toBe(row.closedAt!);
  expect(Date.parse(row.closedAt!)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(row.closedAt!)).toBeLessThanOrEqual(after);
 });

 test("closed edits and queue-exit notes preserve the first close; reopen clears it and a new close replaces it", () => {
  journal = new Journal(path);
  journal.upsertEscalation(card);
  journal.upsertEscalation({ ...card, status: "closed", closedAt: firstClose });
  journal.upsertEscalation({ ...card, title: "Edited title", lastEditedAt: later });
  expect(journal.getEscalation(card.repo, card.nodeId)?.closedAt).toBe(firstClose);
  journal.upsertEscalation({ ...card, status: "closed", closedAt: later, notedAt: later });
  expect(journal.getEscalation(card.repo, card.nodeId)).toMatchObject({ closedAt: firstClose, notedAt: later });
  journal.upsertEscalation({ ...card, status: "closed", closedAt: null });
  expect(journal.getEscalation(card.repo, card.nodeId)?.closedAt).toBe(firstClose);
  journal.close();
  journal = new Journal(path);
  expect(journal.getEscalation(card.repo, card.nodeId)?.closedAt).toBe(firstClose);
  journal.upsertEscalation({ ...card, status: "open" });
  expect(journal.getEscalation(card.repo, card.nodeId)).toMatchObject({ status: "open", closedAt: null });
  journal.upsertEscalation({ ...card, status: "open", closedAt: firstClose });
  expect(journal.getEscalation(card.repo, card.nodeId)?.closedAt).toBeNull();
  journal.upsertEscalation({ ...card, status: "closed", closedAt: later });
  expect(journal.getEscalation(card.repo, card.nodeId)?.closedAt).toBe(later);
 });

 test("migration leaves old open and closed rows null, including later edits of old closed rows", () => {
  const raw = new Database(path, { create: true });
  try {
   seedLegacyRoots(raw, [], {});
   raw.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
   const migrations = readMigrationFiles({ migrationsFolder: join(import.meta.dir, "../drizzle") });
   for (const migration of migrations.filter(entry => entry.folderMillis < 1_792_195_200_000)) {
    for (const statement of migration.sql) raw.exec(statement);
    raw.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [migration.hash, migration.folderMillis]);
   }
   expect(raw.query("PRAGMA table_info(escalations)").all().some((column: any) => column.name === "closed_at")).toBe(false);
   for (const status of ["open", "closed"]) {
    raw.run("INSERT INTO escalations (key, repo, root, node_id, message_id, created_at, last_edited_at, status, noted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
     [`${card.repo}:${status}`, card.repo, card.root, status, card.messageId, card.createdAt, firstClose, status, firstClose]);
   }
  } finally { raw.close(); }
  journal = new Journal(path);
  expect(journal.listEscalations(card.repo).map(row => [row.nodeId, row.status, row.closedAt]).sort()).toEqual([
   ["closed", "closed", null], ["open", "open", null],
  ]);
  journal.upsertEscalation({ ...card, key: `${card.repo}:closed`, nodeId: "closed", status: "closed", closedAt: later, notedAt: later });
  expect(journal.getEscalation(card.repo, "closed")).toMatchObject({ closedAt: null, notedAt: later, lastEditedAt: firstClose });
 });
});

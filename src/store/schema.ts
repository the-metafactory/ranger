import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Ranger journal schema (design §8) — SQLite at `~/.config/ranger/state.sqlite`.
 *
 * Holds only what the graph cannot: worker liveness/outcomes, the dead-man
 * counter + spawn ledger, the veto cache, and an append-only event log.
 * Everything topological is re-derived per tick. Deleting the journal degrades
 * to re-announcing and re-trying once — never to incorrect graph state and
 * never to forgetting a veto.
 */

export const workers = sqliteTable("workers", {
 nodeId: text("node_id").primaryKey(),
 repo: text("repo").notNull(),
 pid: integer("pid"),
 /** claimed | running | success | failed | parked | released */
 status: text("status").notNull().default("claimed"),
 /** Respawn attempts for this node (design §7: attempt < max → respawn). */
 attempts: integer("attempts").notNull().default(0),
 worktree: text("worktree"),
 startedAt: text("started_at"),
 finishedAt: text("finished_at"),
 /** Outcome summary: worker exit, close receipt, or refusal reason. */
 outcome: text("outcome"),
 /** Discord message id of the confirmed claim-announce. */
 messageId: text("message_id"),
});

export const events = sqliteTable("events", {
 id: integer("id").primaryKey({ autoIncrement: true }),
 at: text("at").notNull(),
 nodeId: text("node_id"),
 repo: text("repo"),
 /** claimed | announced | worker-start | worker-success | closed | decisions-written | refused | parked | released | sweep | deadman-paused | veto */
 kind: text("kind").notNull(),
 detail: text("detail"),
});

export const health = sqliteTable("health", {
 key: text("key").primaryKey(),
 value: text("value").notNull(),
});

export const vetoes = sqliteTable("vetoes", {
 nodeId: text("node_id").primaryKey(),
 commentId: text("comment_id").notNull(),
 at: text("at").notNull(),
 detail: text("detail"),
});

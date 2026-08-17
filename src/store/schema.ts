import {
 index,
 integer,
 primaryKey,
 sqliteTable,
 text,
} from "drizzle-orm/sqlite-core";

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

/**
 * Escalation cards (design §5, build-path step 2) — one row per HITL/
 * provisioning card, keyed `repo:nodeId`. The Discord message id + first-post
 * timestamp back the announce-once / edit-not-repost / age-banding contract:
 * a card is posted once, edited in place thereafter, and aged from `createdAt`.
 */

export const escalations = sqliteTable(
 "escalations",
 {
  /** `${repo}:${nodeId}` — one card per node per map. */
  key: text("key").primaryKey(),
  repo: text("repo").notNull(),
  nodeId: text("node_id").notNull(),
  /** Node title at first post — the closed note keeps a readable remnant. */
  title: text("title"),
  /** The §3 route class at (last) post/edit — escalate-hitl | provisioning. */
  route: text("route"),
  /** The content last sent to Discord — edit-on-change skips identical re-edits. */
  lastContent: text("last_content"),
  /** The Discord channel the card lives in — a moved destination reposts. */
  channelId: text("channel_id"),
  messageId: text("message_id").notNull(),
  createdAt: text("created_at").notNull(),
  lastEditedAt: text("last_edited_at"),
  /** open | closed — the write-side (node #21) transitions to closed on a
   *  principal response or operator verb (design §5); the desk only ever
   *  writes open. */
  status: text("status").notNull().default("open"),
  /** When the queue-exit note was written — reconciles the absent-card scan. */
  notedAt: text("noted_at"),
 },
 (table) => [
  // Repo-scoped escalation lookups (listEscalations) stay indexed as history grows.
  index("escalations_repo_idx").on(table.repo),
  // Hot tick lookups: the active pass (repo+node_id batch) and the absent
  // pass / digest (repo+status open, unreconciled) — composite so the
  // synchronous per-tick queries don't scan every row of the repo.
  index("escalations_repo_node_idx").on(table.repo, table.nodeId),
  index("escalations_repo_status_noted_idx").on(
   table.repo,
   table.status,
   table.notedAt,
  ),
  // The digest's oldest-first capped read (repo, status open, ordered by
  // created_at) — without this it scans+sorts every open card per day.
  index("escalations_repo_status_created_idx").on(
   table.repo,
   table.status,
   table.createdAt,
  ),
  // The absent-card reconciliation reads open+unnoted rows ORDERED BY
  // created_at (oldest first) with a LIMIT — a covering index for the sort,
  // so historical open cards don't make the per-tick reconciliation scan
  // sort every matching row (round-29 review).
  index("escalations_repo_status_noted_created_idx").on(
   table.repo,
   table.status,
   table.notedAt,
   table.createdAt,
  ),
 ],
);

/**
 * One card message per (card, destination-channel) pair: when a map's
 * channel moves away and back, the original message is recovered instead of
 * posting a duplicate (design §5 — one card per node).
 */
export const escalationDestinations = sqliteTable(
 "escalation_destinations",
 {
  /** `${repo}:${nodeId}` — matches escalations.key. */
  key: text("key").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  createdAt: text("created_at").notNull(),
 },
 (table) => [primaryKey({ columns: [table.key, table.channelId] })],
);

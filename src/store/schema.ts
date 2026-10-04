import {
 index,
 integer,
 primaryKey,
 sqliteTable,
 text,
} from "drizzle-orm/sqlite-core";

/** The substrates a worker session or review runs on (node #45). */
export const SUBSTRATE_NAMES = ["claude", "codex", "pi"] as const;
export type SubstrateName = (typeof SUBSTRATE_NAMES)[number];

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
 /** research | implement — the §3 lane the node was claimed into. */
 lane: text("lane"),
 /** The substrate the worker session ran on (claude | codex | pi). */
 substrate: text("substrate", { enum: SUBSTRATE_NAMES }),
 /**
  * Occupant generation (the OpenRig occupant-generation pattern, #23
  * amendment): bumped by every run-node start. A supervisor re-checks its
  * generation before each outward action, so a superseded occupant can
  * never push, open a PR, review or close after it was replaced.
  */
 generation: integer("generation").notNull().default(0),
 /** Process group of the headless worker session — sweep kills a dead
  *  supervisor's orphaned group before respawning (F1). */
 workerPgid: integer("worker_pgid"),
 /** Implement-lane phase: implement | review | awaiting-merge | close. */
 phase: text("phase"),
 /** The implement lane's PR number (the F2 resume anchor on GitHub). */
 prNumber: integer("pr_number"),
 /** Sage review rounds run on the PR (the 2-round cap, design §4). */
 reviewRound: integer("review_round").notNull().default(0),
 /** Head SHA of ranger's last recorded sage verdict, and its blocker count. */
 verdictSha: text("verdict_sha"),
 verdictBlockers: integer("verdict_blockers"),
 /** Discord message id of the merge-request card (posted once, idempotent). */
 mergeMessageId: text("merge_message_id"),
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
  // Hot tick lookups: the active pass (repo+node_id batch) and the absent
  // pass / digest (repo+status open, unreconciled) — composite so the
  // synchronous per-tick queries don't scan every row of the repo. The plain
  // (repo) and (repo,status,noted_at) indexes are REDUNDANT (covered by the
  // composite ones below) and were dropped in migration 0011 — each kept
  // index is maintained on every bounded but frequent card upsert (round-35
  // suggestion).
  index("escalations_repo_node_idx").on(table.repo, table.nodeId),
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

/**
 * Substrate quota readings (node #45): one row per substrate, upserted on
 * every read. `ranger serve` and successive ticks share them through SQLite.
 */
export const substrateReadings = sqliteTable("substrate_readings", {
 /** claude | codex | pi */
 substrate: text("substrate", { enum: SUBSTRATE_NAMES }).primaryKey(),
 /** ISO timestamp of the reading. */
 readAt: text("read_at").notNull(),
 /** 5-hour window usage percent (0–100), null when the substrate doesn't report one. */
 fiveHourUsedPct: integer("five_hour_used_pct"),
 /** 7-day window usage percent (0–100), null when the substrate doesn't report one. */
 sevenDayUsedPct: integer("seven_day_used_pct"),
 /** Per-window reset times; old rows remain null until the next quota read. */
 fiveHourResetsAt: text("five_hour_resets_at"),
 sevenDayResetsAt: text("seven_day_resets_at"),
 /** ISO timestamp: the earliest resetsAt across reported windows. */
 resetsAt: text("resets_at"),
 /** True when the substrate is capped (rate limit hit). */
 capped: integer("capped", { mode: "boolean" }).notNull().default(false),
 /** ISO timestamp: capped until this time (from the substrate's own resetsAt). */
 cappedUntil: text("capped_until"),
});

/**
 * Which substrate wrote each pushed SHA (node #45), keyed per repo: review
 * selection reads the PR head's author here. An unknown SHA counts as
 * Pi-written. Rows past the retention window are pruned on write.
 */
export const headSubstrates = sqliteTable(
 "head_substrates",
 {
  repo: text("repo").notNull(),
  sha: text("sha").notNull(),
  nodeId: text("node_id").notNull(),
  /** claude | codex | pi */
  substrate: text("substrate", { enum: SUBSTRATE_NAMES }).notNull(),
  recordedAt: text("recorded_at").notNull(),
 },
 (table) => [
  primaryKey({ columns: [table.repo, table.sha] }),
  index("head_substrates_recorded_at_idx").on(table.recordedAt),
 ],
);

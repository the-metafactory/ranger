import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RangerMapConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import { clearTransientStreak, MAX_TRANSIENT_RESUME_DEFERRALS, recordTransientDeferral } from "../src/resume-escalation.ts";

const REPO = "acme/widgets";
const map = { repo: REPO, root: 1 } as RangerMapConfig;
let dir: string;
let journal: Journal;
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "ranger-resume-escalation-"));
 journal = new Journal(join(dir, "journal.sqlite"));
});
afterEach(() => {
 journal.close();
 rmSync(dir, { recursive: true, force: true });
});

const deferrals = () => journal.listEvents(REPO, 1_000).filter((e) => e.detail?.startsWith("queued resume #40 deferred")).length;

test("only transient deferrals in a row escalate; another outcome restarts the count", async () => {
 const entry = { id: 1, repo: REPO, nodeId: "40", lane: "headless" as const };
 const posts: string[] = [];
 const post = async (content: string) => { posts.push(content); return "card"; };
 for (let i = 1; i < MAX_TRANSIENT_RESUME_DEFERRALS; i++) await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 clearTransientStreak(journal, entry);
 for (let i = 1; i < MAX_TRANSIENT_RESUME_DEFERRALS; i++) await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 expect(posts).toEqual([]);
 await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 expect(posts).toHaveLength(1);
 const journaled = deferrals();
 await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 expect(deferrals()).toBe(journaled);
 expect(posts).toHaveLength(1);
});

test("a card that never posts is retried on every deferral and journaled once", async () => {
 const entry = { id: 1, repo: REPO, nodeId: "40", lane: "headless" as const };
 let attempts = 0;
 const post = async () => { attempts += 1; throw new Error("discord 503"); };
 for (let i = 0; i < MAX_TRANSIENT_RESUME_DEFERRALS + 5; i++) await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 expect(attempts).toBe(6);
 expect(journal.listEvents(REPO, 1_000).filter((e) => e.detail?.includes("card for #40 not posted")).length).toBe(1);
});

test("a card that fails to post is retried on the next deferral", async () => {
 const entry = { id: 1, repo: REPO, nodeId: "40", lane: "headless" as const };
 let up = false;
 const posts: string[] = [];
 const post = async (content: string) => { if (!up) throw new Error("discord 503"); posts.push(content); return "card"; };
 for (let i = 0; i < MAX_TRANSIENT_RESUME_DEFERRALS; i++) await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 expect(posts).toEqual([]);
 up = true;
 await recordTransientDeferral({ journal, map, entry, reason: "gh down", post });
 expect(posts).toHaveLength(1);
});

test("a new queue entry for the same node starts a fresh streak", async () => {
 const posts: string[] = [];
 const post = async (content: string) => { posts.push(content); return "card"; };
 for (let i = 1; i < MAX_TRANSIENT_RESUME_DEFERRALS; i++) await recordTransientDeferral({ journal, map, entry: { id: 1, repo: REPO, nodeId: "40", lane: "headless" }, reason: "gh down", post });
 await recordTransientDeferral({ journal, map, entry: { id: 2, repo: REPO, nodeId: "40", lane: "headless" }, reason: "gh down", post });
 expect(posts).toEqual([]);
});

test("a map with no channel journals the escalation once and posts the card once a channel exists", async () => {
 const entry = { id: 1, repo: REPO, nodeId: "40", lane: "headless" as const };
 for (let i = 0; i < MAX_TRANSIENT_RESUME_DEFERRALS + 2; i++) await recordTransientDeferral({ journal, map, entry, reason: "gh down", post: null });
 const escalations = () => journal.listEvents(REPO, 1_000).filter((e) => e.detail?.startsWith("queued resume #40 escalated")).length;
 expect(escalations()).toBe(1);
 const posts: string[] = [];
 await recordTransientDeferral({ journal, map, entry, reason: "gh down", post: async (content) => { posts.push(content); return "card"; } });
 expect(posts).toHaveLength(1);
 expect(escalations()).toBe(1);
});

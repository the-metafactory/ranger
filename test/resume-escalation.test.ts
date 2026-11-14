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

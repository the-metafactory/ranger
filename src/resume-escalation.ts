import { z } from "zod";
import { DiscordAnnouncer } from "./announce.ts";
import { renderCard } from "./card-render.ts";
import type { RangerMapConfig } from "./config.ts";
import type { Journal, ResumeQueueRow } from "./journal.ts";
import { mapKey } from "./maps.ts";

/**
 * A queued resume that defers on a transient failure (a forge or graph read
 * that fails, an infrastructure or dependency outage) this many times in a
 * row is escalated once and keeps its place: an outage drops nothing, and a
 * failure that never clears reaches the principal instead of the journal alone.
 */
export const MAX_TRANSIENT_RESUME_DEFERRALS = 3;

const streakSchema = z.object({ entryId: z.number(), count: z.number(), escalated: z.boolean(), posted: z.boolean() });
type Streak = z.infer<typeof streakSchema>;
type Entry = Pick<ResumeQueueRow, "id" | "repo" | "nodeId" | "lane">;
export type Post = (content: string, label: string) => Promise<string>;

const streakKey = (entry: Entry) => `resume.transientDeferrals.${entry.repo}#${entry.nodeId}`;

function readStreak(journal: Journal, entry: Entry): Streak | null {
 const raw = journal.getHealth(streakKey(entry));
 if (raw === null || raw === "") return null;
 const parsed = streakSchema.safeParse(JSON.parse(raw));
 return parsed.success && parsed.data.entryId === entry.id ? parsed.data : null;
}

export function clearTransientStreak(journal: Journal, entry: Entry): void {
 if (journal.getHealth(streakKey(entry)) !== null) journal.setHealth(streakKey(entry), "");
}

export function mapAnnouncer(map: RangerMapConfig): Post | null {
 if (map.discord === undefined) return null;
 let announcer: DiscordAnnouncer | undefined;
 return async (content, label) => (announcer ??= DiscordAnnouncer.fromMap(map)).post(content, label);
}

/**
 * Count one transient deferral. Journals each one until the streak escalates,
 * journals the escalation once, then stays silent while the same entry keeps
 * waiting. The card goes to the map's channel as soon as there is one: a post
 * that fails, or a map that has no channel yet, is retried on a later deferral.
 */
export async function recordTransientDeferral(args: {
 journal: Journal;
 map: RangerMapConfig | undefined;
 entry: Entry;
 reason: string;
 post: Post | null;
}): Promise<void> {
 const { journal, entry, reason } = args;
 const previous = readStreak(journal, entry);
 const streak: Streak = { entryId: entry.id, count: (previous?.count ?? 0) + 1,
  escalated: previous?.escalated ?? false, posted: previous?.posted ?? false };
 const detail = `queued resume #${entry.nodeId} escalated: ${streak.count} transient deferrals in a row, last: ${reason}. ` +
  `It keeps its place in the ${entry.lane} queue and starts once the failure clears; \`ranger resume-node ${entry.nodeId} --cancel\` drops it`;
 if (!streak.escalated) {
  journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo, detail: `queued resume #${entry.nodeId} deferred: ${reason}` });
  if (streak.count >= MAX_TRANSIENT_RESUME_DEFERRALS) {
   journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo, detail });
   streak.escalated = true;
  }
 }
 if (streak.escalated && !streak.posted && args.post !== null && args.map !== undefined) {
  try {
   await args.post(renderCard({
    emoji: "⏳", status: "queued resume stuck", nodeId: entry.nodeId,
    meta: [`map: ${mapKey(args.map)}`], body: detail, bodyMax: 1_500,
   }), `queued resume escalation for #${entry.nodeId}`);
   streak.posted = true;
  } catch (error) {
   journal.recordEvent("sweep", { nodeId: entry.nodeId, repo: entry.repo,
    detail: `queued resume escalation card for #${entry.nodeId} not posted: ${String(error).slice(0, 400)}` });
  }
 }
 journal.setHealth(streakKey(entry), JSON.stringify(streak));
}

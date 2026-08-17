import { type EscalationDiscord, DiscordMessageGoneError } from "./discord.ts";
import type { Journal } from "./journal.ts";
import type { OwnedCheck } from "./lock.ts";
import type { RangerMapConfig } from "./config.ts";
import type { AuditResult } from "./graph.ts";
import {
  ageBand,
  ageText,
  localDateKey,
  sanitizeGraphText,
} from "./card-sync.ts";

/**
 * Daily digest delivery + rendering (design §5) — extracted from escalate.ts
 * (round-37 maintainability finding). The digest is one per-map post per
 * host-local day: fresh post on a new day, in-place edit on a same-day
 * content change, no-op on an unchanged same-day digest — with deleted-
 * message recovery. The orchestration (digestOneMap/runDigest) lives in
 * escalate.ts.
 */

// ---- the daily digest ----

interface DigestCard {
  nodeId: string;
  title: string;
  route: string;
  ageDays: number;
  messageId: string;
}

export interface DigestMapResult {
  repo: string;
  /** discriminates digest results from cards-pass results in renderers. */
  kind: "digest";
  ok: boolean;
  error?: string;
  cards: DigestCard[];
  receiptLessCloses: string[];
  openWithoutCheckpoint: string[];
  openClaims: { id: string; assignees: string[] }[];
  budget: {
    spawnsToday: number;
    spawnCapPerDay: number;
    deadman: number;
    paused: boolean;
  };
  digestMessageId: string;
  posted: boolean;
  /** what happened to today's digest message: fresh post | in-place edit | no-op. */
  action: "posted" | "edited" | "unchanged";
}

export interface DigestResult {
  generatedAt: string;
  maps: DigestMapResult[];
}

interface DigestInputs {
  map: RangerMapConfig;
  cards: DigestCard[];
  /** total open cards (cards is capped at what the message can render). */
  openCount: number;
  /** age-band counts over ALL open cards (the header must not under-report
   *  an overdue card that falls outside the rendered ≤15 list). */
  ageCounts: { aged: number; overdue: number };
  audit: AuditResult;
  budget: DigestMapResult["budget"];
  principal: string;
  principalDiscordId?: string;
  now: Date;
}

export function digestContent(inputs: DigestInputs): string {
  const {
    map,
    cards,
    openCount,
    ageCounts,
    audit,
    budget,
    principal,
    principalDiscordId,
    now,
  } = inputs;
  const header = [
    `:newspaper: **ranger digest** — ${map.repo} (root ${map.root}, walk: ${map.walk}) · ${localDateKey(now)}`,
    "",
    `**Cards: ${openCount}**${ageCounts.aged > 0 ? ` (${ageCounts.aged} aged 3+d, ${ageCounts.overdue} 7+d${principalDiscordId ? " @-mentioned" : " no ping"})` : ""}`,
  ];
  const summarize = (items: string[], max: number): string => {
    if (items.length === 0) return "";
    // Every item is graph-derived — sanitize so a crafted `<@principal-id>`
    // audit value can't ping the principal before the 7-day policy
    // (round-26 review).
    const inert = items.map(sanitizeGraphText);
    const head = inert.slice(0, max).join(", ");
    return items.length > max ? `${head}, …+${items.length - max}` : head;
  };
  const auditLines: string[] = [
    `**Audit:** receipt-less closes ${audit.closedWithoutReceipt.length}${audit.closedWithoutReceipt.length > 0 ? ` (${summarize(audit.closedWithoutReceipt, 8)})` : ""} · open w/o checkpoint ${audit.openWithoutCheckpoint.length}${audit.openWithoutCheckpoint.length > 0 ? ` (${summarize(audit.openWithoutCheckpoint, 8)})` : ""} · open claims ${audit.openClaimed.length}`,
  ];
  if (audit.openClaimed.length > 0) {
    for (const c of audit.openClaimed.slice(0, 8)) {
      auditLines.push(
        `    #${sanitizeGraphText(c.id)} [${c.assignees.map(sanitizeGraphText).join(", ")}]`,
      );
    }
    if (audit.openClaimed.length > 8) {
      auditLines.push(
        `    … and ${audit.openClaimed.length - 8} more open claims`,
      );
    }
  }
  const budgetLine = `**Budget:** spawns today ${budget.spawnsToday}/${budget.spawnCapPerDay} · dead-man ${budget.deadman} · ${budget.paused ? "PAUSED" : "running"}`;
  // Reserve room for the audit + budget sections so a long card list can
  // never evict the promised parts of a "cards + audit + budget" digest —
  // the card list is capped to fit, not the tail sliced off.
  const reserved =
    header.join("\n").length +
    2 +
    auditLines.join("\n").length +
    1 +
    budgetLine.length;
  const cardBudget = 1950 - reserved - 80; // +80 slack for the "… N more" line
  const cardLines: string[] = [];
  if (cards.length === 0) {
    cardLines.push("  none open — clean");
  } else {
    let shown = 0;
    for (const card of cards) {
      if (shown >= 15) break; // hard cap on per-message card count
      const band = ageBand(card.ageDays);
      const line = `  #${sanitizeGraphText(card.nodeId)} ${sanitizeGraphText(card.title)} — ${card.route} · ${ageText(
        band,
        card.ageDays,
        principal,
        principalDiscordId,
      )}`;
      if (
        cardBudget > 0 &&
        cardLines.join("\n").length + line.length + 1 > cardBudget
      ) {
        break; // stop before the promised sections would be evicted
      }
      cardLines.push(line);
      shown++;
    }
    // skipped counts against the TRUE total (openCount), not the capped
    // query's length — with 16+ open cards the query returns 15 but the
    // remainder must still be reported (round-20 review).
    const skipped = openCount - shown;
    if (skipped > 0) {
      cardLines.push(
        `  … and ${skipped} more open cards (full list in the thread)`,
      );
    }
  }
  const joined = [...header, ...cardLines, "", ...auditLines, budgetLine].join(
    "\n",
  );
  // Final guard (should not trigger — audit/budget are reserved above).
  return joined.length > 1950 ? `${joined.slice(0, 1949)}…` : joined;
}

/** The daily digest's cached post/edit/repost delivery state machine —
 *  separated from data collection + rendering (round-34 suggestion), so a
 *  change to digest DATA or DELIVERY doesn't require navigating the whole
 *  function.
 *
 *  Edit-not-repost within a day, and edit-on-change within the day: the cache
 *  is {today, messageId, lastContent}; a new (host-local) day posts a fresh
 *  digest, a same-day content change edits in place, and an unchanged
 *  same-day digest is a no-op (no Discord write — re-runs must not churn
 *  rate limits). A DELETED cached message is only noticed via a read: if it
 *  is definitively gone (404), repost so the daily audit/budget digest never
 *  silently vanishes.
 */
/** The digest delivery operation's full context, bundled so the stateful
 *  dependency set can't be misordered (round-37 suggestion). */
interface DigestSyncContext {
  client: EscalationDiscord;
  journal: Journal;
  repo: string;
  content: string;
  now: Date;
  deadline: number;
  owned: OwnedCheck;
}

export async function syncDailyDigest(
  ctx: DigestSyncContext,
): Promise<{ messageId: string; posted: boolean; edited: boolean }> {
  const { client, journal, repo, content, now, deadline, owned } = ctx;
  const today = localDateKey(now);
  const cachedRaw = journal.getHealth(`digest.${repo}`);
  let cached: {
    today: string;
    messageId: string;
    lastContent: string;
  } | null = null;
  if (cachedRaw !== null) {
    try {
      cached = JSON.parse(cachedRaw) as {
        today: string;
        messageId: string;
        lastContent: string;
      };
    } catch {
      cached = null; // pre-edit-on-change cache format — treat as fresh
    }
  }
  let messageId = "";
  let posted = false;
  let edited = false;
  if (cached !== null && cached.today === today) {
    messageId = cached.messageId;
    if (cached.lastContent === content) {
      // Unchanged same-day digest is a write no-op — but a DELETED cached
      // message is only noticed via a read. Verify it still exists; if it
      // is definitively gone (404), repost so the daily audit/budget digest
      // never silently vanishes.
      if (!(await client.messageExists(messageId, deadline))) {
        // A resumed holder whose lease was reclaimed must stop before its
        // next mutation (round-35 blocker).
        owned();
        messageId = await client.post(content, deadline);
        posted = true;
      }
    } else {
      try {
        // Fence the edit: same rule as the post.
        owned();
        await client.edit(messageId, content, deadline);
        edited = true;
      } catch (editError) {
        if (!(editError instanceof DiscordMessageGoneError)) throw editError;
        // The cached digest message was deleted (or moved): post a fresh
        // digest and replace the cached message id — otherwise unchanged
        // runs would no-op against the stale cache and leave NO digest
        // until the next day.
        owned();
        messageId = await client.post(content, deadline);
        posted = true;
      }
    }
    // Fence the cache write: a resumed holder must not overwrite the new
    // owner's digest cache (round-35).
    owned();
    journal.setHealth(
      `digest.${repo}`,
      JSON.stringify({ today, messageId, lastContent: content }),
    );
  } else {
    // Fence the fresh post + ITS cache write (round-37 blocker): if the
    // lease is reclaimed while the POST awaits, the stale holder must NOT
    // overwrite the new owner's digest cache — re-assert immediately before
    // the setHealth too.
    owned();
    messageId = await client.post(content, deadline);
    owned();
    journal.setHealth(
      `digest.${repo}`,
      JSON.stringify({ today, messageId, lastContent: content }),
    );
    posted = true;
  }
  return { messageId, posted, edited };
}


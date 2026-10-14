import { describe, expect, test } from "bun:test";
import { DiscordAnnouncer } from "../src/announce.ts";
import { DISCORD_MESSAGE_LIMIT, plainBody, renderCard } from "../src/card-render.ts";
import { CARD_HEADS, cardContent, closedGraphContent } from "../src/card-sync.ts";
import { digestContent } from "../src/digest.ts";
import type { RangerMapConfig } from "../src/config.ts";
import type { EscalationRow } from "../src/journal.ts";
import type { NodeResult } from "../src/graph.ts";
import type { ClassifiedNode, RouteClass } from "../src/route.ts";
import { parkCardText } from "../src/worker.ts";

const MAP = { repo: "acme/widgets", root: 1 };
const URL = "https://github.com/acme/widgets/issues/21";

function node(over: Partial<ClassifiedNode> & { route: RouteClass }): ClassifiedNode {
  return {
    id: "21",
    title: "Settle the escalation-desk write-side",
    kind: "grilling",
    autonomy: "propose",
    typed: true,
    url: URL,
    checkpointId: "write-side-settled",
    registryBlocked: false,
    ...over,
  };
}

/** One escalation card per head in CARD_HEADS. */
const HEADS: Record<keyof typeof CARD_HEADS, ClassifiedNode> = {
  grilling: node({ route: { route: "escalate-hitl", reason: "propose-approve" } }),
  prototype: node({ kind: "prototype", route: { route: "escalate-hitl", reason: "propose-approve" } }),
  propose: node({ kind: "task", route: { route: "escalate-hitl", reason: "propose-approve" } }),
  approve: node({ kind: "task", autonomy: "approve", route: { route: "escalate-hitl", reason: "propose-approve" } }),
  untyped: node({ kind: "task", route: { route: "escalate-hitl", reason: "untyped" } }),
  "hitl-kind-as-auto": node({ kind: "task", autonomy: "auto", route: { route: "escalate-hitl", reason: "hitl-kind-as-auto" } }),
  provisioning: node({
    kind: "task",
    autonomy: "auto",
    route: { route: "provisioning" },
    blockedProbes: [{ type: "command", run: "bun test", cwd: "/tmp/x" }],
  }),
  "brief-not-ready": node({ kind: "build", autonomy: "auto", route: { route: "brief-not-ready", missing: ["## Acceptance criteria"] } }),
};

const render = (n: ClassifiedNode, ageDays = 4, discordId?: string) =>
  cardContent(n, MAP, ageDays, "jcfischer", discordId);

const closedRow: EscalationRow = {
  key: "acme/widgets:21", root: 1, repo: "acme/widgets", nodeId: "21",
  title: "Settle the escalation-desk write-side", route: "escalate-hitl", lastContent: null,
  channelId: "1", messageId: "m1", createdAt: "2026-10-08T10:00:00Z", lastEditedAt: null,
  status: "open", notedAt: null,
};
const closedNode = {
  repo: "acme/widgets", ref: { id: "21" }, status: "closed", assignees: [], blockedBy: [],
  author: "alice", url: URL, typed: true,
  node: { id: "21", title: "Settle the escalation-desk write-side", kind: "grilling", autonomy: "propose", checkpointId: "write-side-settled" },
} satisfies NodeResult;

/** Line 1 `<emoji> <status> · **#N** <title>` with only `#N` bold; line 2 subtext. */
function expectFrame(card: string, status: string, id: string) {
  const [line1, line2] = card.split("\n");
  expect(line1).toMatch(new RegExp(`^\\S+ ${status} · \\*\\*#${id}\\*\\* \\S`));
  expect(line1!.match(/\*\*/g)).toHaveLength(2);
  expect(line2).toStartWith("-# ");
}

describe("node #239 — escalation cards: status line + subtext metadata", () => {
  for (const [head, n] of Object.entries(HEADS)) {
    test(`${head}: line 1 is the status line, line 2 the subtext metadata`, () => {
      const card = render(n);
      expectFrame(card, CARD_HEADS[head]!.status.replace(/[()]/g, "\\$&"), "21");
      expect(card).toStartWith(`${CARD_HEADS[head]!.emoji} ${CARD_HEADS[head]!.status} · **#21** Settle the escalation-desk write-side\n`);
      expect(card.split("\n")[1]).toBe(
        `-# map: acme/widgets#1 · ${n.kind} · ${n.autonomy} · checkpoint \`write-side-settled\` · age 4d · <${URL}>`,
      );
    });
  }

  test("the closed-on-the-graph card carries the same frame and metadata", () => {
    const card = closedGraphContent(MAP, closedRow, closedNode, new Date("2026-10-12T09:00:00Z"));
    expectFrame(card, "closed on the graph", "21");
    expect(card.split("\n")[1]).toBe(
      `-# map: acme/widgets#1 · grilling · propose · checkpoint \`write-side-settled\` · age 4d · <${URL}>`,
    );
  });

  test("no checkpoint: the subtext omits it rather than rendering an empty code span", () => {
    const card = render(node({ checkpointId: undefined, route: { route: "escalate-hitl", reason: "propose-approve" } }));
    expect(card.split("\n")[1]).toBe(`-# map: acme/widgets#1 · grilling · propose · age 4d · <${URL}>`);
  });
});

describe("node #239 — the body", () => {
  const BODY = [
    "## Question",
    "",
    "Who writes the card back?",
    "",
    "### Deliverable",
    "A ruling.",
    "# Top heading #",
    "#### Already ends with a colon:",
    "-# sneaky subtext",
    "See https://example.org/a_(b) and (https://example.org/c).",
  ].join("\n");

  test("markdown headings become plain lines; the only `#`-led line is the subtext", () => {
    const card = render(node({ body: BODY, route: { route: "escalate-hitl", reason: "propose-approve" } }));
    expect(card).toContain("\nQuestion:\n");
    expect(card).toContain("\nDeliverable:\nA ruling.\nTop heading:\nAlready ends with a colon:\nsneaky subtext\n");
    const hashLines = card.split("\n").filter((l) => /^\s*-?#/.test(l));
    expect(hashLines).toEqual([card.split("\n")[1]!]);
    expect(hashLines[0]).toStartWith("-# ");
  });

  test("neither the body nor the reason line is wrapped in `_…_`", () => {
    for (const n of Object.values(HEADS)) {
      const card = render({ ...n, body: "Should we ship now or wait?" });
      for (const line of card.split("\n")) expect(line).not.toMatch(/^_.*_$/);
    }
    const card = render(node({ body: "Should we ship now or wait?", route: { route: "escalate-hitl", reason: "propose-approve" } }));
    expect(card).toContain("\npropose/approve — HITL decision, escalates to the principal\nShould we ship now or wait?");
  });

  test("links are wrapped in `<…>`, trailing punctuation stays outside", () => {
    const card = render(node({ body: BODY, route: { route: "escalate-hitl", reason: "propose-approve" } }));
    expect(card).toContain("See <https://example.org/a_(b)> and (<https://example.org/c>).");
  });

  test("a link inside inline code or a fence is not wrapped", () => {
    expect(plainBody("run `curl https://x.test/y`")).toBe("run `curl https://x.test/y`");
    expect(plainBody("```\nhttps://x.test/y\n```")).toBe("```\nhttps://x.test/y\n```");
  });

  test("a long body is cut inside the 2000-char cap and ends in `…`", () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i} of the question`).join("\n");
    const card = render(node({ body, route: { route: "escalate-hitl", reason: "propose-approve" } }), 9, "999");
    expect(card.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    const lines = card.split("\n");
    expect(lines.at(-1)).toBe("📣 <@999> 9d old — needs your attention");
    expect(lines.at(-2)).toEndWith("…");
  });

  test("a non-grilling body is a 140-char gist", () => {
    const card = render(node({ kind: "task", body: "x ".repeat(300), route: { route: "escalate-hitl", reason: "propose-approve" } }), 0);
    const body = card.split("\n").at(-1)!;
    expect(body).toEndWith("…");
    expect(body.length).toBeLessThanOrEqual(140);
  });

  test("a null or empty body leaves no body line, no `__` and no trailing blank line", () => {
    for (const body of [undefined, "", "   \n\n  "]) {
      const card = render(node({ body, route: { route: "escalate-hitl", reason: "propose-approve" } }), 0);
      expect(card).not.toContain("__");
      expect(card).not.toMatch(/\n\s*$/);
      expect(card.split("\n")).toHaveLength(3); // status, subtext, reason
    }
    const bare = renderCard({ emoji: "✅", status: "merged", nodeId: "1", title: "t", body: null });
    expect(bare).toBe("✅ merged · **#1** t");
  });
});

describe("node #239 — mention-inerting holds", () => {
  test("`<@123>` and `<@&456>` in the title or body never reach the card", () => {
    const evil = node({
      title: "Ping <@123> and <@&456>",
      body: "Body pings <@123> and <@&456> too, see https://x.test/<@123>",
      route: { route: "escalate-hitl", reason: "propose-approve" },
    });
    for (const age of [0, 4, 9]) {
      const card = render(evil, age, "999");
      expect(card).not.toContain("<@123>");
      expect(card).not.toContain("<@&456>");
      const pings = card.match(/<@/g) ?? [];
      expect(pings.length).toBe(age >= 7 ? 1 : 0);
      if (age >= 7) expect(card).toContain("<@999>");
      // The only `<` graph text yields is a link wrap.
      for (const lt of card.matchAll(/</g)) {
        expect(card.slice(lt.index)).toMatch(/^<(https?:\/\/[^\s<>‹›]+>|@999>)/);
      }
    }
  });

  test("a title can't add bold beside the node id", () => {
    const card = render(node({ title: "**loud** title", route: { route: "escalate-hitl", reason: "propose-approve" } }));
    expect(card.split("\n")[0]!.match(/(?<!\\)\*\*/g)).toHaveLength(2);
  });
});

describe("node #239 — every poster renders through the one renderer", () => {
  const map = { repo: "acme/widgets", root: 1, walk: "full" } as RangerMapConfig;

  test("the daily digest", () => {
    const digest = digestContent({
      map,
      cards: [{ nodeId: "21", title: "Settle <@123>", route: "escalate-hitl", ageDays: 8, messageId: "m" }],
      openCount: 1,
      ageCounts: { aged: 1, overdue: 1 },
      audit: { repo: "acme/widgets", root: "1", nodes: 3, closedWithoutReceipt: ["7"], openWithoutCheckpoint: [], openClaimed: [] } as never,
      budget: { spawnsToday: 1, spawnCapPerDay: 10, deadman: 0, paused: false },
      principal: "jcfischer",
      principalDiscordId: "999",
      now: new Date("2026-10-12T09:00:00"),
    });
    const lines = digest.split("\n");
    expect(lines[0]).toBe("📰 ranger digest · acme/widgets#1");
    expect(lines[1]).toBe("-# walk: full · 2026-10-12");
    expect(digest).toContain("\n- `#21` Settle ‹@123> — escalate-hitl · 📣 <@999> 8d\n");
    expect(digest).not.toContain("**");
  });

  test("the daily digest with no spawn cap shows the count alone", () => {
    const digest = digestContent({
      map,
      cards: [],
      openCount: 0,
      ageCounts: { aged: 0, overdue: 0 },
      audit: { repo: "acme/widgets", root: "1", nodes: 3, closedWithoutReceipt: [], openWithoutCheckpoint: [], openClaimed: [] } as never,
      budget: { spawnsToday: 31, spawnCapPerDay: Number.POSITIVE_INFINITY, deadman: 0, paused: false },
      principal: "jcfischer",
      principalDiscordId: "999",
      now: new Date("2026-10-14T09:00:00"),
    });
    expect(digest).toContain("Budget: spawns today 31 · dead-man 0");
    expect(digest).not.toContain("Infinity");
  });

  test("the park card", () => {
    const card = parkCardText(MAP, "21", "Settle <@123>", "## Why\nthe worker exited 1");
    expectFrame(card, "parked", "21");
    expect(card).toBe(
      "⏸️ parked · **#21** Settle ‹@123>\n-# map: acme/widgets#1\nWhy:\nthe worker exited 1\n" +
        "Parked work waits for you: `ranger resume-node`, or take it in a session.",
    );
  });

  test("the claim announce", async () => {
    let content = "";
    const fetchFn = (async (_url: string, init: RequestInit) => {
      content = (JSON.parse(String(init.body)) as { content: string }).content;
      return Response.json({ id: "m1" });
    }) as unknown as typeof fetch;
    const announcer = new DiscordAnnouncer("token", "1", "http://discord.test", fetchFn);
    await announcer.announce({ repo: "acme/widgets", root: 1, nodeId: "21", nodeTitle: "Settle it", mapTitle: "Ranger" });
    expect(content).toBe("🙋 claim · **#21** Settle it\n-# map: acme/widgets#1 (Ranger)");
  });
});

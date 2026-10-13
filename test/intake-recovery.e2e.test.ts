import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardedCardContent, draftCardContent, filedCardContent, intakeCardState, type IntakeCardDraft } from "../src/card-sync.ts";
import { loadConfig, type RangerMapConfig } from "../src/config.ts";
import { EscalationDiscord } from "../src/discord.ts";
import { intakeMarker, intakePass, PRINCIPAL_INTAKE_LABEL, type IntakeResult } from "../src/intake.ts";
import { Journal } from "../src/journal.ts";
import { baseConfigLines, FAKE_BOT_ID, fakeDiscord, fixturesBin, type FakeThreadMessage } from "./support.ts";

/**
 * Intake after the journal is lost (node #249; #21 ruling D14, with D1): the
 * pass starts from an empty journal against a fake Discord (thread reads,
 * posts, reactions, edits), fake soma and fake gh. Ranger's own reply cards
 * say which @-mentions are answered; the gate's marker lookup keeps a
 * duplicate draft from filing a second node.
 */

const interval = process.env.RANGER_DISCORD_MIN_INTERVAL_MS;
beforeAll(() => { process.env.RANGER_DISCORD_MIN_INTERVAL_MS = "1"; });
afterAll(() => {
 if (interval === undefined) delete process.env.RANGER_DISCORD_MIN_INTERVAL_MS;
 else process.env.RANGER_DISCORD_MIN_INTERVAL_MS = interval;
});

const PRINCIPAL = "500000000000000005";
const OTHER = "600000000000000006";
const THREAD = "1234567890";
const MAP = { repo: "acme/widgets", root: 1 };

function mention(id: string, text = "The minimap flickers when the window resizes"): FakeThreadMessage {
 return { id, content: `<@${FAKE_BOT_ID}> ${text}`, author: { id: PRINCIPAL }, mentions: [{ id: FAKE_BOT_ID }] };
}

function chatter(id: string): FakeThreadMessage {
 return { id, content: "", author: { id: OTHER }, mentions: [] };
}

const DRAFT: IntakeCardDraft = {
 title: "The minimap flickers when the window resizes",
 parent: 1,
 checkpoint: "the-minimap-flickers-when-the-window-resizes",
 autonomy: "propose",
 drafter: "deterministic",
 body: "The minimap flickers when the window resizes",
 messageUrl: "https://discord.com/channels/1/2/3",
 specHash: "a".repeat(64),
};

/** A ranger card in the thread, replying to `to` unless `reply` is false. */
function card(id: string, to: string, content: string, opts: { reply?: boolean; author?: string } = {}): FakeThreadMessage {
 return {
  id,
  content,
  author: { id: opts.author ?? FAKE_BOT_ID, bot: true },
  mentions: [],
  ...(opts.reply === false ? {} : { message_reference: { message_id: to } }),
 };
}

interface Rig {
 discord: ReturnType<typeof fakeDiscord>;
 journal: Journal;
 tick(): Promise<IntakeResult>;
 issues(): { number: number; body: string }[];
 patchState(patch: (s: Record<string, any>) => void): void;
 close(): void;
}

/** A map whose journal is empty: no cursor, no drafts. */
function rig(): Rig {
 const dir = mkdtempSync(join(tmpdir(), "ranger-intake-recovery-"));
 const discord = fakeDiscord();
 const lines = baseConfigLines(dir, { auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'] });
 lines.push("principal:", "  login: jcfischer", `  discordId: "${PRINCIPAL}"`);
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, lines.join("\n"));
 const { config } = loadConfig(configPath);
 const journal = new Journal(join(dir, "state.sqlite"));
 const statePath = join(dir, "soma-state.json");
 writeFileSync(statePath, JSON.stringify({ nodes: {}, decisions: [] }));
 const env: NodeJS.ProcessEnv = {
  PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
  FAKE_SOMA_DIR: dir,
  FAKE_SOMA_STATE: statePath,
  RANGER_WRITE_TEST: "ghp_write",
  RANGER_RO_TEST: "ghp_ro",
 };
 const clientFor = (map: RangerMapConfig) =>
  new EscalationDiscord("fake-bot-token", map.discord!.channelId, `http://127.0.0.1:${discord.port}`);
 const state = () => JSON.parse(readFileSync(statePath, "utf8"));
 return {
  discord,
  journal,
  async tick() {
   const saved = { ...process.env };
   Object.assign(process.env, env);
   try {
    return await intakePass({ config, journal, clientFor, claude: null });
   } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
   }
  },
  issues: () => Object.values(state().issues ?? {}),
  patchState(patch) {
   const s = state();
   patch(s);
   writeFileSync(statePath, JSON.stringify(s));
  },
  close() {
   journal.close();
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  },
 };
}

const thread = (result: IntakeResult) => result.threads[0]!;

describe("intake recovers after the journal is lost (node #249, D14)", () => {
 test("a qualifying @-mention with no ranger card replying to it gets a draft card, as a reply to it", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, chatter("1001"));
   r.discord.say(THREAD, mention("1002"));
   // A ranger card that answers some other message, and one that is no reply.
   r.discord.say(THREAD, card("1003", "999", filedCardContent(MAP, DRAFT, "50")));
   r.discord.say(THREAD, card("1004", "1002", discardedCardContent(MAP, DRAFT), { reply: false }));
   const result = await r.tick();
   expect(thread(result)).toMatchObject({ rescan: true, read: 4, drafted: ["1002"], answered: [], cursor: "1004" });
   expect(r.discord.threadReads[0]).toEqual({ channelId: THREAD, after: "0" });
   expect(r.discord.posts).toHaveLength(1);
   expect(r.discord.posts[0]!.replyTo).toBe("1002");
   expect(r.journal.getIntakeDraft("1002")).toMatchObject({ status: "draft", cardMessageId: r.discord.posts[0]!.messageId });
  } finally { r.close(); }
 });

 test("a mention whose ranger card says filed as #N or discarded is not redrafted", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, mention("1001"));
   r.discord.say(THREAD, mention("1002", "Export drops the last row"));
   r.discord.say(THREAD, card("1003", "1001", filedCardContent(MAP, DRAFT, "77")));
   r.discord.say(THREAD, card("1004", "1002", discardedCardContent(MAP, DRAFT)));
   // Someone else's reply that looks like a filed card answers nothing.
   r.discord.say(THREAD, card("1005", "1001", filedCardContent(MAP, DRAFT, "78"), { author: OTHER }));
   const result = await r.tick();
   expect(thread(result)).toMatchObject({ drafted: [], answered: ["1001", "1002"], cursor: "1005" });
   expect(r.discord.posts).toHaveLength(0);
   expect(r.journal.getIntakeDraft("1001")).toBeNull();
  } finally { r.close(); }
 });

 test("a mention whose only card is still a draft is redrafted: a visible duplicate, never a lost observation", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, mention("1001"));
   r.discord.say(THREAD, card("1002", "1001", draftCardContent(MAP, DRAFT)));
   const result = await r.tick();
   expect(thread(result)).toMatchObject({ drafted: ["1001"], answered: [] });
   expect(r.discord.posts).toHaveLength(1);
   expect(r.discord.posts[0]!.replyTo).toBe("1001");
  } finally { r.close(); }
 });

 test("a mention already filed on the map: at most a duplicate draft, and its 👍 finds the marker and adds nothing", async () => {
  const r = rig();
  try {
   // The node was filed, then the card edit and the journal were both lost.
   r.patchState((s) => {
    s.issues = { "77": { number: 77, parent: "1", title: "x", autonomy: "propose", checkpoint: "x", labels: [PRINCIPAL_INTAKE_LABEL], body: `words\n\n${intakeMarker("1001")}`, machineAccount: true } };
   });
   r.discord.say(THREAD, mention("1001"));
   r.discord.say(THREAD, card("1002", "1001", draftCardContent(MAP, DRAFT)));
   expect(thread(await r.tick()).drafted).toEqual(["1001"]);
   const duplicate = r.journal.getIntakeDraft("1001")!.cardMessageId;

   r.discord.react(duplicate, "👍", PRINCIPAL);
   const result = await r.tick();
   expect(thread(result).gate!.filed).toEqual([{ messageId: "1001", node: "77", added: false }]);
   expect(r.issues()).toHaveLength(1);
   expect(r.discord.edits).toHaveLength(1);
   expect(r.discord.edits[0]!.messageId).toBe(duplicate);
   expect(r.discord.edits[0]!.content.split("\n")[0]).toStartWith("✅ filed as #77 · ");
   expect(r.journal.getIntakeDraft("1001")).toMatchObject({ status: "filed", filedNode: "77" });
  } finally { r.close(); }
 });

 test("a long thread is read a capped run of pages per tick, and a mention waits until its answer could have been seen", async () => {
  const r = rig();
  try {
   // 1000 messages: a mention on page 2 whose filed card sits on page 6, and an unanswered one on page 9.
   for (let i = 1; i <= 1000; i++) {
    const id = String(10_000 + i);
    if (i === 150) r.discord.say(THREAD, mention(id));
    else if (i === 600) r.discord.say(THREAD, card(id, "10150", filedCardContent(MAP, DRAFT, "77")));
    else if (i === 850) r.discord.say(THREAD, mention(id, "Export drops the last row"));
    else r.discord.say(THREAD, chatter(id));
   }
   // Tick 1 reads five pages (to 10500) and never saw the card: it parks just before the mention.
   const first = await r.tick();
   expect(thread(first)).toMatchObject({ rescan: true, read: 500, drafted: [], answered: [], cursor: "10149" });
   expect(r.discord.threadReads).toHaveLength(5);
   expect(r.discord.posts).toHaveLength(0);

   // Tick 2 starts at the mention and sees its card: answered, not redrafted.
   const second = await r.tick();
   expect(thread(second)).toMatchObject({ drafted: [], answered: ["10150"], cursor: "10649" });
   expect(thread(second).rescan).toBeUndefined();
   expect(r.discord.threadReads[5]).toEqual({ channelId: THREAD, after: "10149" });

   // Tick 3 reaches the end: the unanswered mention gets its draft.
   const third = await r.tick();
   expect(thread(third)).toMatchObject({ drafted: ["10850"], cursor: "11000" });
   expect(r.discord.posts.map((p) => p.replyTo)).toEqual(["10850"]);
  } finally { r.close(); }
 });

 test("a mention on the first page whose answer lies past the whole page run is drafted (the bounded worst case)", async () => {
  const r = rig();
  try {
   for (let i = 1; i <= 700; i++) {
    const id = String(10_000 + i);
    if (i === 10) r.discord.say(THREAD, mention(id));
    else if (i === 650) r.discord.say(THREAD, card(id, "10010", filedCardContent(MAP, DRAFT, "77")));
    else r.discord.say(THREAD, chatter(id));
   }
   const first = await r.tick();
   expect(thread(first)).toMatchObject({ read: 500, drafted: ["10010"], cursor: "10500" });
   expect(r.discord.posts).toHaveLength(1);
  } finally { r.close(); }
 });

 test("a failed rescan read posts nothing, files nothing and moves no cursor (failure case)", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, mention("1001"));
   r.discord.failThreadReads(500);
   const result = await r.tick();
   expect(thread(result).error).toContain("HTTP 500");
   expect(thread(result).gate).toBeUndefined();
   expect(r.discord.posts).toHaveLength(0);
   expect(r.issues()).toHaveLength(0);
   expect(r.journal.intakeCursor(THREAD)).toBeNull();
   expect(r.journal.getIntakeDraft("1001")).toBeNull();
  } finally { r.close(); }
 });

 test("a read that fails on a later page posts nothing from the pages already read (failure case)", async () => {
  const r = rig();
  try {
   for (let i = 1; i <= 150; i++) r.discord.say(THREAD, i === 5 ? mention(String(10_000 + i)) : chatter(String(10_000 + i)));
   // The first page serves; the second is refused.
   r.discord.failThreadReadsAfter(1, 500);
   const result = await r.tick();
   expect(thread(result).error).toContain("HTTP 500");
   expect(r.discord.posts).toHaveLength(0);
   expect(r.journal.intakeCursor(THREAD)).toBeNull();
  } finally { r.close(); }
 });
});

describe("intakeCardState reads ranger's intake cards back (node #249)", () => {
 test("draft, filed with its node, discarded, and anything else", () => {
  expect(intakeCardState(draftCardContent(MAP, DRAFT))).toEqual({ state: "draft" });
  expect(intakeCardState(filedCardContent(MAP, DRAFT, "77"))).toEqual({ state: "filed", node: "77" });
  expect(intakeCardState(discardedCardContent(MAP, DRAFT))).toEqual({ state: "discarded" });
  expect(intakeCardState("✅ filed as #77")).toEqual({ state: "filed", node: "77" });
  expect(intakeCardState("a reply that says ✅ filed as #77")).toBeNull();
  expect(intakeCardState("🗑️ discardedness · x")).toBeNull();
  expect(intakeCardState("")).toBeNull();
 });
});

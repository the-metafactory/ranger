import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type RangerMapConfig } from "../src/config.ts";
import { sanitizeGraphText } from "../src/card-render.ts";
import { EscalationDiscord, snowflakeAt } from "../src/discord.ts";
import { deterministicDraft, intakePass, slugCheckpoint } from "../src/intake.ts";
import { Journal } from "../src/journal.ts";
import type { ClaudeOneShot } from "../src/substrate.ts";
import { walk } from "../src/walk.ts";
import {
 baseConfigLines,
 claudeEnvelope,
 FAKE_BOT_ID,
 FAKE_GUILD_ID,
 fakeDiscord,
 runCli,
 type FakeThreadMessage,
} from "./support.ts";

/**
 * Human-observation intake, slice 1 (node #247): the intake pass of the walk
 * tick against a fake Discord REST server (thread reads, post, edit). Only a
 * principal message that @-mentions the bot gets a deterministic draft card.
 */

// Keep the shared client throttle out of the way of these tests, and only these:
// another file in this process tests the default spacing.
const interval = process.env.RANGER_DISCORD_MIN_INTERVAL_MS;
beforeAll(() => { process.env.RANGER_DISCORD_MIN_INTERVAL_MS = "5"; });
afterAll(() => {
 if (interval === undefined) delete process.env.RANGER_DISCORD_MIN_INTERVAL_MS;
 else process.env.RANGER_DISCORD_MIN_INTERVAL_MS = interval;
});

const PRINCIPAL = "500000000000000005";
const OTHER = "600000000000000006";
const THREAD = "1234567890";
const CURSOR = "1000";

function msg(id: string, author: string, content: string, over: Partial<FakeThreadMessage> = {}): FakeThreadMessage {
 const mentions = [...content.matchAll(/<@!?(\d+)>/g)].map((m) => ({ id: m[1]! }));
 return { id, content, author: { id: author }, mentions, ...over };
}

interface Rig {
 dir: string;
 configPath: string;
 discord: ReturnType<typeof fakeDiscord>;
 journal: Journal;
 config: ReturnType<typeof loadConfig>["config"];
 /** Run one walk tick in-process, its intake client pointed at the fake. */
 tick(intakeClaude?: ClaudeOneShot | null): ReturnType<typeof walk>;
 close(): void;
}

function rig(opts: { extraMaps?: string[]; discordId?: string | null; seed?: boolean } = {}): Rig {
 const dir = mkdtempSync(join(tmpdir(), "ranger-intake-"));
 const discord = fakeDiscord();
 const lines = baseConfigLines(dir);
 const at = lines.indexOf("auth:");
 lines.splice(at, 0, ...(opts.extraMaps ?? []));
 const discordId = opts.discordId === undefined ? PRINCIPAL : opts.discordId;
 lines.push("principal:", "  login: jcfischer", ...(discordId === null ? [] : [`  discordId: "${discordId}"`]));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, lines.join("\n"));
 const { config } = loadConfig(configPath);
 const journal = new Journal(join(dir, "state.sqlite"));
 if (opts.seed !== false) journal.setIntakeCursor(THREAD, CURSOR);
 const intakeClient = (map: RangerMapConfig) =>
  new EscalationDiscord("fake-bot-token", map.discord!.channelId, `http://127.0.0.1:${discord.port}`);
 return {
  dir,
  configPath,
  discord,
  journal,
  config,
  // No write token is configured: every map is gated, and intake still runs.
  tick: (intakeClaude?: ClaudeOneShot | null) =>
   walk({ config, configPath, journal, intakeClient, ...(intakeClaude === undefined ? {} : { intakeClaude }) }),
  close() {
   journal.close();
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  },
 };
}

describe("intake pass of the walk tick (node #247)", () => {
 test("only a principal message that @-mentions the bot gets a draft card; the cursor passes every message read", async () => {
  const r = rig();
  try {
   const observation = `<@${FAKE_BOT_ID}> The minimap flickers when the window resizes\nSeen on <@${OTHER}>'s laptop too.`;
   r.discord.say(THREAD, msg("1001", OTHER, `<@${FAKE_BOT_ID}> please file this`)); // someone else's mention
   r.discord.say(THREAD, msg("1002", PRINCIPAL, "a note without a mention")); // no mention
   r.discord.say(THREAD, msg("1003", PRINCIPAL, observation));
   // A reply to a ranger card pings the bot without an @-mention in its text.
   r.discord.say(THREAD, msg("1004", PRINCIPAL, "agreed", { mentions: [{ id: FAKE_BOT_ID }], message_reference: { message_id: "990" } }));
   r.discord.say(THREAD, msg("1005", FAKE_BOT_ID, `<@${FAKE_BOT_ID}> ranger's own card`, { author: { id: FAKE_BOT_ID, bot: true } }));

   const result = await r.tick();
   expect(result.intake.threads).toEqual([
    { channelId: THREAD, maps: ["acme/widgets#1"], read: 5, drafted: ["1003"], alreadyDrafted: [], cursor: "1005" },
   ]);
   expect(r.discord.meReads).toHaveLength(1);
   expect(r.discord.posts).toHaveLength(1);
   expect(r.discord.edits).toHaveLength(0);
   expect(r.discord.posts[0]!.url).toContain(`/channels/${THREAD}/messages`);

   const card = r.discord.posts[0]!.content;
   expect(card.split("\n")[0]).toBe("📥 draft node · The minimap flickers when the window resizes");
   expect(card).toContain("parent #1");
   expect(card).toContain("checkpoint `the-minimap-flickers-when-the-window-resizes`");
   expect(card).toContain("autonomy propose");
   expect(card).toContain("deterministic draft");
   expect(card).toContain("Deterministic draft:");
   // The message verbatim, mention-inerted, and a link to it.
   expect(card).toContain(sanitizeGraphText(observation));
   expect(card).not.toContain(`<@${OTHER}>`);
   expect(card).toContain(`<https://discord.com/channels/${FAKE_GUILD_ID}/${THREAD}/1003>`);

   expect(r.journal.intakeCursor(THREAD)).toBe("1005");
   expect(r.journal.getIntakeDraft("1003")).toMatchObject({
    repo: "acme/widgets",
    root: 1,
    authorId: PRINCIPAL,
    title: "The minimap flickers when the window resizes",
    checkpoint: "the-minimap-flickers-when-the-window-resizes",
    body: observation,
    drafter: "deterministic",
    cardMessageId: r.discord.posts[0]!.messageId,
    status: "draft",
   });
   for (const id of ["1001", "1002", "1004", "1005"]) expect(r.journal.getIntakeDraft(id)).toBeNull();
   expect(r.journal.listEvents("acme/widgets").some((e) => e.kind === "intake-draft")).toBe(true);

   // The next tick reads after the cursor: nothing new, nothing posted.
   const again = await r.tick();
   expect(again.intake.threads[0]).toMatchObject({ read: 0, drafted: [], cursor: "1005" });
   expect(r.discord.threadReads.at(-1)).toEqual({ channelId: THREAD, after: "1005" });
   expect(r.discord.posts).toHaveLength(1);
  } finally { r.close(); }
 });

 test("anyone else's @-mention, or a principal message without one, posts no card (failure case)", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", OTHER, `<@${FAKE_BOT_ID}> the build is red`));
   r.discord.say(THREAD, msg("1002", PRINCIPAL, `<@${OTHER}> can you look at this?`));
   const result = await r.tick();
   expect(result.intake.threads[0]).toMatchObject({ read: 2, drafted: [], cursor: "1002" });
   expect(r.discord.posts).toHaveLength(0);
  } finally { r.close(); }
 });

 test("a map with walk: none, or with no Discord thread, is not read; a thread two maps share is not read", async () => {
  const r = rig({
   extraMaps: [
    "  - repo: acme/gadgets", "    root: 2", "    walk: research-only",
    "  - repo: acme/tools", "    root: 3", "    walk: none",
    "    discord:", "      tokenEnv: RANGER_DISCORD_TOKEN", '      channelId: "333"',
    "  - repo: acme/kit", "    root: 4", "    walk: research-only",
    "    discord:", "      tokenEnv: RANGER_DISCORD_TOKEN", '      channelId: "444"',
    "  - repo: acme/kit", "    root: 5", "    walk: full",
    "    discord:", "      tokenEnv: RANGER_DISCORD_TOKEN", '      channelId: "444"',
   ],
  });
  try {
   r.discord.say("333", msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> on the walk: none map`));
   r.discord.say("444", msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> on the shared thread`));
   const result = await r.tick();
   expect(r.discord.threadReads.map((t) => t.channelId)).toEqual([THREAD]);
   expect(result.intake.threads.map((t) => t.channelId)).toEqual([THREAD, "444"]);
   expect(result.intake.threads[1]!.skipped).toContain("intake needs one map per thread");
   expect(result.intake.threads[1]!.error).toBeUndefined();
   expect(r.discord.posts).toHaveLength(0);
   expect(r.journal.intakeCursor("333")).toBeNull();
  } finally { r.close(); }
 });

 test("a message read twice (a crash before the cursor write) finds its draft and posts no second card", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> Settings panel loses focus`));
   await r.tick();
   expect(r.discord.posts).toHaveLength(1);
   // The card was posted and recorded, then the process died before the cursor moved.
   r.journal.setIntakeCursor(THREAD, CURSOR);
   const result = await r.tick();
   expect(result.intake.threads[0]).toMatchObject({ read: 1, drafted: [], alreadyDrafted: ["1001"], cursor: "1001" });
   expect(r.discord.posts).toHaveLength(1);
   expect(r.discord.edits).toHaveLength(0);
  } finally { r.close(); }
 });

 test("a failed thread read moves no cursor and posts no card (failure case)", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> Settings panel loses focus`));
   r.discord.failThreadReads(403);
   const result = await r.tick();
   expect(result.intake.threads[0]!.error).toContain("HTTP 403");
   expect(result.intake.threads[0]!.cursor).toBe(CURSOR);
   expect(r.journal.intakeCursor(THREAD)).toBe(CURSOR);
   expect(r.discord.posts).toHaveLength(0);
   // Once the read succeeds, the message is drafted.
   r.discord.failThreadReads(200);
   await r.tick();
   expect(r.discord.posts).toHaveLength(1);
  } finally { r.close(); }
 });

 test("a bot mention whose content Discord withheld stops the thread before it (escalate, not guess)", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", OTHER, "chatter"));
   r.discord.say(THREAD, msg("1002", PRINCIPAL, "", { mentions: [{ id: FAKE_BOT_ID }] }));
   r.discord.say(THREAD, msg("1003", PRINCIPAL, `<@${FAKE_BOT_ID}> later observation`));
   const result = await r.tick();
   expect(result.intake.threads[0]!.error).toContain("returned no content");
   expect(r.journal.intakeCursor(THREAD)).toBe("1001");
   expect(r.discord.posts).toHaveLength(0);
  } finally { r.close(); }
 });

 test("the first tick on a thread starts its cursor at now and drafts nothing older", async () => {
  const r = rig({ seed: false });
  try {
   const before = snowflakeAt(new Date(Date.now() - 60_000));
   r.discord.say(THREAD, msg(before, PRINCIPAL, `<@${FAKE_BOT_ID}> an old mention`));
   const result = await r.tick();
   expect(result.intake.threads[0]).toMatchObject({ seeded: true, read: 0 });
   expect(r.discord.threadReads).toHaveLength(0);
   expect(BigInt(r.journal.intakeCursor(THREAD)!)).toBeGreaterThan(BigInt(before));
   await r.tick();
   expect(r.discord.posts).toHaveLength(0);
  } finally { r.close(); }
 });

 test("without principal.discordId no thread is read", async () => {
  const r = rig({ discordId: null });
  try {
   r.discord.say(THREAD, msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> hello`));
   const result = await intakePass({ config: r.config, journal: r.journal });
   expect(result.skipped).toContain("principal.discordId");
   expect(r.discord.meReads).toHaveLength(0);
   expect(r.discord.threadReads).toHaveLength(0);
  } finally { r.close(); }
 });

 test("`ranger walk` runs the intake pass on the map's own Discord surface", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", PRINCIPAL, `<@!${FAKE_BOT_ID}> Export drops the last row`));
   r.journal.close();
   const out = await runCli(["walk", "-c", r.configPath], {
    ...process.env,
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${r.discord.port}`,
    RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5",
    RANGER_DISCORD_TOKEN: "fake-bot-token",
    RANGER_RO_TEST: "ghp_ro",
   });
   expect(out.code).toBe(0);
   expect(JSON.parse(out.stdout).intake.threads[0]).toMatchObject({ drafted: ["1001"], cursor: "1001" });
   expect(r.discord.posts).toHaveLength(1);
   expect(r.discord.posts[0]!.content).toContain("📥 draft node · Export drops the last row");
  } finally {
   r.journal = new Journal(join(r.dir, "state.sqlite"));
   r.close();
  }
 });
});

describe("the claude drafter on the walk tick (node #252, D12)", () => {
 const answer = {
  title: "Export keeps the last row",
  parent: 1,
  checkpoint: "export-keeps-last-row",
  kind: "task",
  autonomy: "propose",
  probes: [{ type: "git-ref-exists", ref: "main" }],
 };
 const claudeAnswering = (calls: string[]): ClaudeOneShot => async (prompt) => {
  calls.push(prompt);
  return { code: 0, stdout: claudeEnvelope(answer), stderr: "" };
 };

 test("a claude draft is posted as drafted by claude, charged to the spawn ledger, and its whole spec recorded", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> Export drops the last row`));
   const calls: string[] = [];
   const result = await r.tick(claudeAnswering(calls));
   expect(result.intake.threads[0]).toMatchObject({ drafted: ["1001"], cursor: "1001" });
   expect(calls).toHaveLength(1);
   expect(r.journal.spawnsToday()).toBe(1);
   const card = r.discord.posts[0]!.content;
   expect(card.split("\n")[0]).toBe("📥 draft node · Export keeps the last row");
   expect(card).toContain("drafted by claude");
   expect(card).toContain("kind task");
   expect(r.journal.getIntakeDraft("1001")).toMatchObject({
    title: "Export keeps the last row",
    checkpoint: "export-keeps-last-row",
    drafter: "claude",
    parent: 1,
    autonomy: "propose",
    kind: "task",
    probes: JSON.stringify(answer.probes),
   });
   expect(r.journal.listEvents("acme/widgets").find((e) => e.kind === "intake-draft")?.detail).toContain("(claude)");
  } finally { r.close(); }
 });

 test("a failed call posts the deterministic draft and says why", async () => {
  const r = rig();
  try {
   r.discord.say(THREAD, msg("1001", PRINCIPAL, `<@${FAKE_BOT_ID}> Export drops the last row`));
   await r.tick(async () => ({ code: 2, stdout: "", stderr: "auth expired" }));
   const card = r.discord.posts[0]!.content;
   expect(card).toContain("deterministic draft");
   expect(card).toContain("Claude did not draft it: claude exited 2.");
   expect(card).not.toContain("auth expired");
   expect(r.journal.getIntakeDraft("1001")).toMatchObject({ drafter: "deterministic", parent: 1, autonomy: "propose", kind: null, probes: null });
  } finally { r.close(); }
 });
});

describe("the deterministic drafter (node #247, D12)", () => {
 test("title from the first line with text, the bot mention dropped; checkpoint slugged from it", () => {
  const spec = deterministicDraft(`<@${FAKE_BOT_ID}>\n\n  Zürich tiles: render   wrong at zoom 3 \nmore`, FAKE_BOT_ID, 26);
  expect(spec).toEqual({
   title: "Zürich tiles: render wrong at zoom 3",
   parent: 26,
   checkpoint: "zurich-tiles-render-wrong-at-zoom-3",
   autonomy: "propose",
   drafter: "deterministic",
  });
 });

 test("a long title is capped, and its checkpoint ends on a word", () => {
  const spec = deterministicDraft(`<@${FAKE_BOT_ID}> ${"word ".repeat(40)}`, FAKE_BOT_ID, 1);
  expect(spec.title.length).toBeLessThanOrEqual(120);
  expect(spec.checkpoint.length).toBeLessThanOrEqual(48);
  expect(spec.checkpoint).toMatch(/^(word-)*word$/);
 });

 test("a mention with no words drafts a fallback title and checkpoint", () => {
  expect(deterministicDraft(`<@${FAKE_BOT_ID}>`, FAKE_BOT_ID, 1)).toMatchObject({
   title: "Observation from the principal",
   checkpoint: "observation-from-the-principal",
  });
  expect(slugCheckpoint("!!!")).toBe("observation");
 });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intakeCardState, supersededCardContent } from "../src/card-sync.ts";
import { loadConfig, type RangerMapConfig } from "../src/config.ts";
import { EscalationDiscord } from "../src/discord.ts";
import type { FrontierEntry } from "../src/graph.ts";
import { frontierCacheKey } from "../src/frontier-cache.ts";
import {
 deterministicCorrection,
 intakeMarker,
 intakeNodeBody,
 intakePass,
 parseClaudeCorrection,
 PRINCIPAL_INTAKE_LABEL,
 type DraftSpec,
 type IntakeResult,
} from "../src/intake.ts";
import { Journal } from "../src/journal.ts";
import type { ClaudeOneShot } from "../src/substrate.ts";
import { baseConfigLines, claudeEnvelope, FAKE_BOT_ID, FAKE_GUILD_ID, fakeDiscord, fixturesBin, type FakeThreadMessage } from "./support.ts";

/**
 * Intake corrections (node #241; #21 ruling D13) and the `human-intake-shipped`
 * checkpoint: the principal replies to a draft card with a bot @-mention
 * naming changes; ranger posts a new card with the corrected spec and its own
 * hash, edits the old one to "superseded → link", and only a 👍 on the newest
 * card files the node. The pass runs in-process against a fake Discord that
 * echoes ranger's posts into the thread (so a reply can name a card), fake
 * soma (`graph add`/`link`) and fake gh (identity read, marker lookup).
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
const MENTION = "1001";
const OBSERVATION = `<@${FAKE_BOT_ID}> The minimap flickers when the window resizes\nSeen twice today.`;
const MAP = { repo: "acme/widgets", root: 1 };
const TITLE = "The minimap flickers when the window resizes";

/** A principal message; a reply to `to` when given. */
function say(id: string, content: string, opts: { to?: string; author?: string } = {}): FakeThreadMessage {
 const mentions = [...content.matchAll(/<@!?(\d+)>/g)].map((m) => ({ id: m[1]! }));
 // Discord lists a pinged reply's target author as mentioned.
 if (opts.to !== undefined && !mentions.some((m) => m.id === FAKE_BOT_ID)) mentions.push({ id: FAKE_BOT_ID });
 return {
  id,
  content,
  author: { id: opts.author ?? PRINCIPAL },
  mentions,
  ...(opts.to === undefined ? {} : { message_reference: { message_id: opts.to } }),
 };
}

function entry(id: string, title: string): FrontierEntry {
 return {
  ref: { id },
  node: { id, title, kind: "task", autonomy: "propose" },
  status: "open",
  assignees: [],
  blockedBy: [],
  author: "jcfischer",
  url: `https://github.com/acme/widgets/issues/${id}`,
  typed: true,
  parent: { id: "1" },
 } as FrontierEntry;
}

interface Issue { number: number; parent: string | null; title: string; autonomy: string; checkpoint: string; labels: string[]; body: string; machineAccount: boolean; kind?: string }

interface Rig {
 discord: ReturnType<typeof fakeDiscord>;
 journal: Journal;
 /** The card ranger posted for a message (a mention or a correction). */
 card(messageId: string): string;
 tick(extra?: NodeJS.ProcessEnv): Promise<IntakeResult>;
 issues(): Issue[];
 /** Delete the journal and open an empty one: no cursor, no drafts. */
 loseJournal(): void;
 close(): void;
}

async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
 const saved = { ...process.env };
 Object.assign(process.env, env);
 try {
  return await fn();
 } finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
 }
}

/** A map with open node #40 cached, whose thread holds one drafted principal observation. */
async function rig(opts: { claude?: ClaudeOneShot } = {}): Promise<Rig> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-intake-correction-"));
 const discord = fakeDiscord({ echo: true });
 const lines = baseConfigLines(dir, { auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'] });
 lines.push("principal:", "  login: jcfischer", `  discordId: "${PRINCIPAL}"`);
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, lines.join("\n"));
 const { config } = loadConfig(configPath);
 const journal = new Journal(join(dir, "state.sqlite"));
 journal.setIntakeCursor(THREAD, "1000");
 journal.setHealth(
  frontierCacheKey(MAP.repo, MAP.root),
  JSON.stringify({ sentinel: "s", fetchedAt: new Date().toISOString(), frontier: { repo: MAP.repo, root: "1", frontier: [entry("40", "Rendering")] } }),
 );
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
 let losses = 0;
 const r: Rig = {
  discord,
  journal,
  card: (messageId) => journal.getIntakeDraft(messageId)!.cardMessageId,
  tick: (extra = {}) =>
   withEnv({ ...env, ...extra }, () =>
    intakePass({ config, journal: r.journal, clientFor, ...(opts.claude === undefined ? { claude: null } : { claude: opts.claude }) })),
  issues: () => Object.values(JSON.parse(readFileSync(statePath, "utf8")).issues ?? {}),
  loseJournal() {
   r.journal.close();
   rmSync(r.journal.path, { force: true });
   r.journal = new Journal(join(dir, `state-${++losses}.sqlite`));
  },
  close() {
   r.journal.close();
   discord.stop();
   rmSync(dir, { recursive: true, force: true });
  },
 };
 discord.say(THREAD, say(MENTION, OBSERVATION));
 const drafted = await r.tick();
 expect(drafted.threads[0]!.drafted).toEqual([MENTION]);
 return r;
}

const thread = (result: IntakeResult) => result.threads[0]!;
const cardUrl = (id: string) => `https://discord.com/channels/${FAKE_GUILD_ID}/${THREAD}/${id}`;
const firstLine = (content: string) => content.split("\n")[0]!;

describe("intake corrections: a reply re-drafts, the 👍 binds to the newest card (node #241)", () => {
 test("human-intake-shipped: @-mention → draft → correction → new card, old superseded → 👍 on old ignored → 👍 on new files once", async () => {
  const r = await rig();
  try {
   const oldCard = r.card(MENTION);
   const old = r.journal.getIntakeDraft(MENTION)!;
   expect(old).toMatchObject({ parent: 1, kind: null, status: "draft" });

   // The principal replies to the draft card with a bot mention naming changes.
   const CORRECTION = "1100";
   r.discord.say(THREAD, say(CORRECTION, `<@${FAKE_BOT_ID}> parent #40, kind build`, { to: oldCard }));
   const corrected = await r.tick();
   expect(thread(corrected)).toMatchObject({ drafted: [], corrected: [CORRECTION] });
   expect(thread(corrected).error).toBeUndefined();

   // The new card replies to the correction, with the corrected spec and its own hash.
   const next = r.journal.getIntakeDraft(CORRECTION)!;
   expect(next).toMatchObject({
    status: "draft", parent: 40, kind: "build", title: TITLE, autonomy: "propose",
    checkpoint: old.checkpoint, body: OBSERVATION, messageUrl: old.messageUrl,
    supersedes: MENTION, originMessageId: MENTION,
   });
   expect(next.specHash).toMatch(/^[0-9a-f]{64}$/);
   expect(next.specHash).not.toBe(old.specHash);
   const post = r.discord.posts.at(-1)!;
   expect(post.messageId).toBe(next.cardMessageId);
   expect(post.replyTo).toBe(CORRECTION);
   expect(firstLine(post.content)).toBe(`📥 draft node · ${TITLE}`);
   expect(post.content).toContain("parent #40");
   expect(post.content).toContain("kind build");
   expect(post.content).toContain(`spec \`${next.specHash!.slice(0, 12)}\``);
   expect(post.content).toContain(`replacing <${cardUrl(oldCard)}>: changed parent, kind`);
   expect(post.content).toContain("Only this card's 👍 files it.");

   // The old card now says superseded → the new card, and its row is out of the gate.
   const edit = r.discord.edits.find((e) => e.messageId === oldCard)!;
   expect(firstLine(edit.content)).toBe(`↪️ superseded → <${cardUrl(next.cardMessageId)}> · ${TITLE}`);
   expect(intakeCardState(edit.content)).toEqual({ state: "superseded" });
   expect(thread(corrected).gate!.superseded).toEqual([MENTION]);
   expect(r.journal.getIntakeDraft(MENTION)!.status).toBe("superseded");
   expect(r.journal.listEvents("acme/widgets").some((e) => e.kind === "intake-corrected")).toBe(true);

   // A 👍 on the superseded card files nothing: its reactions are never read.
   r.discord.react(oldCard, "👍", PRINCIPAL);
   const onOld = await r.tick();
   expect(r.issues()).toHaveLength(0);
   expect(r.discord.reactionReads.some((read) => read.messageId === oldCard)).toBe(false);
   expect(thread(onOld).gate?.filed ?? []).toEqual([]);
   expect(r.journal.getIntakeDraft(MENTION)!.status).toBe("superseded");

   // The principal's 👍 on the newest card files the corrected spec, once.
   r.discord.react(next.cardMessageId, "👍", PRINCIPAL);
   const filed = await r.tick();
   expect(thread(filed).gate!.filed).toEqual([{ messageId: CORRECTION, node: "100", added: true }]);
   const issues = r.issues();
   expect(issues).toHaveLength(1);
   expect(issues[0]).toMatchObject({
    number: 100, parent: "40", title: TITLE, kind: "build", autonomy: "propose", checkpoint: old.checkpoint,
    labels: [PRINCIPAL_INTAKE_LABEL], machineAccount: true,
   });
   // The body is the observation, its link and the mention's marker: one observation, one marker.
   expect(issues[0]!.body).toBe(intakeNodeBody({ body: OBSERVATION, messageUrl: old.messageUrl, messageId: MENTION }));
   expect(issues[0]!.body.trimEnd().endsWith(intakeMarker(MENTION))).toBe(true);
   expect(firstLine(r.discord.edits.at(-1)!.content)).toBe(`✅ filed as #100 · ${TITLE}`);
   expect(r.journal.getIntakeDraft(CORRECTION)).toMatchObject({ status: "filed", filedNode: "100" });

   // Nothing is added again.
   await r.tick();
   expect(r.issues()).toHaveLength(1);
  } finally { r.close(); }
 });

 test("human-intake-shipped: a crash between the add and the journal write on a corrected card adds no second node", async () => {
  const r = await rig();
  try {
   const CORRECTION = "1100";
   r.discord.say(THREAD, say(CORRECTION, `<@${FAKE_BOT_ID}> autonomy approve`, { to: r.card(MENTION) }));
   await r.tick();
   const next = r.journal.getIntakeDraft(CORRECTION)!;
   expect(next.autonomy).toBe("approve");

   r.discord.react(next.cardMessageId, "👍", PRINCIPAL);
   // The add lands, then the card edit fails: the tick ends with the row still `filing`.
   r.discord.failEdits(403);
   const crashed = await r.tick();
   expect(thread(crashed).gate!.errors[0]).toContain("HTTP 403");
   expect(r.issues()).toHaveLength(1);
   expect(r.journal.getIntakeDraft(CORRECTION)).toMatchObject({ status: "filing", filedNode: null });

   r.discord.failEdits(200);
   const result = await r.tick();
   expect(thread(result).gate!.filed).toEqual([{ messageId: CORRECTION, node: "100", added: false }]);
   expect(r.issues()).toHaveLength(1);
   expect(r.issues()[0]!.autonomy).toBe("approve");
   expect(r.journal.getIntakeDraft(CORRECTION)).toMatchObject({ status: "filed", filedNode: "100" });
  } finally { r.close(); }
 });

 test("a correction naming an unknown parent, kind or autonomy: the new card says which field was not understood and keeps its value", async () => {
  const r = await rig();
  try {
   const CORRECTION = "1100";
   r.discord.say(THREAD, say(CORRECTION, `<@${FAKE_BOT_ID}> parent #999, kind epic, autonomy auto, title: Minimap flickers on resize`, { to: r.card(MENTION) }));
   const result = await r.tick();
   expect(thread(result).corrected).toEqual([CORRECTION]);
   const next = r.journal.getIntakeDraft(CORRECTION)!;
   // The title applied; every field not understood kept its previous value.
   expect(next).toMatchObject({ title: "Minimap flickers on resize", parent: 1, kind: null, autonomy: "propose" });
   const content = r.discord.posts.at(-1)!.content;
   expect(content).toContain("changed title");
   expect(content).toContain('Not understood: parent "#999" is not an open node of this map — kept #1.');
   expect(content).toContain('Not understood: kind "epic" is not one of research, prototype, grilling, task, build — kept no kind.');
   expect(content).toContain('Not understood: autonomy "auto" is not propose or approve — kept propose.');
   expect(r.journal.getIntakeDraft(MENTION)!.status).toBe("superseded");
  } finally { r.close(); }
 });

 test("a reply by anyone but the principal, or a principal reply without a bot mention, changes nothing (failure case)", async () => {
  const r = await rig();
  try {
   const card = r.card(MENTION);
   const posts = r.discord.posts.length;
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> parent #40`, { to: card, author: OTHER }));
   r.discord.say(THREAD, say("1101", "parent #40, kind build", { to: card }));
   const result = await r.tick();
   expect(thread(result)).toMatchObject({ drafted: [], alreadyDrafted: [] });
   expect(thread(result).corrected).toBeUndefined();
   expect(thread(result).ignored).toBeUndefined();
   expect(r.discord.posts).toHaveLength(posts);
   expect(r.discord.edits).toHaveLength(0);
   expect(r.journal.getIntakeDraft(MENTION)).toMatchObject({ status: "draft", parent: 1 });
   expect(r.journal.getIntakeDraft("1100")).toBeNull();
   expect(r.journal.getIntakeDraft("1101")).toBeNull();
  } finally { r.close(); }
 });

 test("only the current draft card takes a correction: a reply to the superseded card changes nothing", async () => {
  const r = await rig();
  try {
   const oldCard = r.card(MENTION);
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> kind build`, { to: oldCard }));
   await r.tick();
   const posts = r.discord.posts.length;
   const edits = r.discord.edits.length;

   r.discord.say(THREAD, say("1200", `<@${FAKE_BOT_ID}> kind task`, { to: oldCard }));
   const result = await r.tick();
   expect(thread(result).ignored).toEqual([{ messageId: "1200", reason: `card ${oldCard} is superseded — only the current draft card takes a correction` }]);
   expect(r.discord.posts).toHaveLength(posts);
   expect(r.discord.edits).toHaveLength(edits);
   expect(r.journal.getIntakeDraft("1200")).toBeNull();

   // A second correction on the newest card chains: the mention stays the origin.
   const newest = r.card("1100");
   r.discord.say(THREAD, say("1300", `<@${FAKE_BOT_ID}> checkpoint minimap-steady`, { to: newest }));
   const chained = await r.tick();
   expect(thread(chained).corrected).toEqual(["1300"]);
   expect(r.journal.getIntakeDraft("1300")).toMatchObject({ kind: "build", checkpoint: "minimap-steady", supersedes: "1100", originMessageId: MENTION });
   expect(r.journal.getIntakeDraft("1100")!.status).toBe("superseded");
  } finally { r.close(); }
 });

 test("a correction read twice finds its journaled draft and posts no second card", async () => {
  const r = await rig();
  try {
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> kind build`, { to: r.card(MENTION) }));
   await r.tick();
   const posts = r.discord.posts.length;
   r.journal.setIntakeCursor(THREAD, "1000");
   const again = await r.tick();
   expect(thread(again).alreadyDrafted).toContain("1100");
   expect(thread(again).corrected).toBeUndefined();
   expect(r.discord.posts).toHaveLength(posts);
  } finally { r.close(); }
 });

 test("a superseded card whose edit failed is edited on the next tick, its reactions never read", async () => {
  const r = await rig();
  try {
   const oldCard = r.card(MENTION);
   r.discord.react(oldCard, "👍", PRINCIPAL);
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> kind build`, { to: oldCard }));
   r.discord.failEdits(403);
   const failed = await r.tick();
   expect(thread(failed).corrected).toEqual(["1100"]);
   expect(thread(failed).gate!.errors).toHaveLength(1);
   expect(r.journal.getIntakeDraft(MENTION)!.status).toBe("superseding");

   r.discord.failEdits(200);
   const result = await r.tick();
   expect(thread(result).gate!.superseded).toEqual([MENTION]);
   expect(r.journal.getIntakeDraft(MENTION)!.status).toBe("superseded");
   expect(r.discord.reactionReads.some((read) => read.messageId === oldCard)).toBe(false);
   expect(r.issues()).toHaveLength(0);
  } finally { r.close(); }
 });
});

describe("the claude corrector (node #241)", () => {
 test("claude applies the correction to the previous spec", async () => {
  const prompts: string[] = [];
  const claude: ClaudeOneShot = async (prompt) => {
   prompts.push(prompt);
   // The first call drafts the observation; the second applies the correction.
   return prompts.length === 1
    ? { code: 0, stderr: "", stdout: claudeEnvelope({ title: TITLE, parent: 1, checkpoint: "minimap-flicker", kind: "task", autonomy: "propose", probes: [] }) }
    : { code: 0, stderr: "", stdout: claudeEnvelope({ title: TITLE, parent: 40, checkpoint: "minimap-flicker", kind: "build", autonomy: "propose", probes: [], not_understood: [] }) };
  };
  const r = await rig({ claude });
  try {
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> parent #40, kind build`, { to: r.card(MENTION) }));
   await r.tick();
   expect(prompts).toHaveLength(2);
   expect(prompts[1]).toContain("<previous_spec>");
   expect(prompts[1]).toContain('"checkpoint": "minimap-flicker"');
   expect(prompts[1]).toContain("parent #40, kind build");
   expect(r.journal.getIntakeDraft("1100")).toMatchObject({ parent: 40, kind: "build", drafter: "claude", checkpoint: "minimap-flicker" });
   expect(r.discord.posts.at(-1)!.content).toContain("Corrected draft, applied by claude");
  } finally { r.close(); }
 });

 test("claude failing falls back to the deterministic reading, and the card says why", async () => {
  let calls = 0;
  const claude: ClaudeOneShot = async () => {
   calls++;
   return calls === 1
    ? { code: 0, stderr: "", stdout: claudeEnvelope({ title: TITLE, parent: 1, checkpoint: "minimap-flicker", kind: "task", autonomy: "propose", probes: [] }) }
    : { code: 0, stderr: "", stdout: claudeEnvelope({ title: TITLE, parent: 999, checkpoint: "minimap-flicker", kind: "build", autonomy: "propose", probes: [] }) };
  };
  const r = await rig({ claude });
  try {
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> kind build`, { to: r.card(MENTION) }));
   await r.tick();
   // The deterministic reading keeps claude's earlier draft (its drafter and probes) and applies the kind.
   expect(r.journal.getIntakeDraft("1100")).toMatchObject({ parent: 1, kind: "build", drafter: "claude", checkpoint: "minimap-flicker" });
   const content = r.discord.posts.at(-1)!.content;
   expect(content).toContain("Corrected draft, read deterministically");
   expect(content).toContain("Claude did not apply it: the parent is not an open node of this map.");
  } finally { r.close(); }
 });
});

describe("after a journal loss (node #241 with #249)", () => {
 test("a chain whose newest card was filed answers its mention: nothing is redrafted", async () => {
  const r = await rig();
  try {
   r.discord.say(THREAD, say("1100", `<@${FAKE_BOT_ID}> kind build`, { to: r.card(MENTION) }));
   await r.tick();
   r.discord.react(r.card("1100"), "👍", PRINCIPAL);
   await r.tick();
   expect(r.issues()).toHaveLength(1);
   const posts = r.discord.posts.length;

   // The journal is lost. The rescan reads ranger's own cards: the filed card
   // answers the correction, whose chain began at the mention.
   r.loseJournal();
   const result = await r.tick();
   expect(thread(result)).toMatchObject({ rescan: true, drafted: [], answered: [MENTION] });
   // The correction's previous spec went with the journal: it changes nothing.
   expect(thread(result).ignored).toEqual([{ messageId: "1100", reason: expect.stringContaining("is not in the journal") }]);
   expect(r.discord.posts).toHaveLength(posts);
   expect(r.issues()).toHaveLength(1);
  } finally { r.close(); }
 });
});

describe("deterministicCorrection (node #241)", () => {
 const prev: DraftSpec = { title: TITLE, parent: 1, checkpoint: "minimap", autonomy: "propose", drafter: "deterministic" };
 const subtree = [{ id: 1, title: "(the map root)" }, { id: 40, title: "Rendering" }];
 const correct = (text: string) => deterministicCorrection(`<@${FAKE_BOT_ID}> ${text}`, FAKE_BOT_ID, prev, subtree);

 test("reads each named field; the rest keep their value", () => {
  expect(correct("parent #40, kind build")).toEqual({ spec: { ...prev, parent: 40, kind: "build" }, changed: ["parent", "kind"], notUnderstood: [] });
  expect(correct("title: Minimap flickers, kind task\ncheckpoint minimap-steady").spec).toEqual({
   ...prev, title: "Minimap flickers, kind task", checkpoint: "minimap-steady",
  });
  expect(correct("autonomy approve.").spec.autonomy).toBe("approve");
 });

 test("a value not understood keeps the previous one and says so; naming nothing says so", () => {
  expect(correct("checkpoint Not_A_Slug").notUnderstood).toEqual(['checkpoint "Not_A_Slug" is not a slug — kept minimap']);
  expect(correct("parent forty").spec.parent).toBe(1);
  const nothing = correct("this looks wrong");
  expect(nothing.spec).toEqual(prev);
  expect(nothing.changed).toEqual([]);
  expect(nothing.notUnderstood[0]).toContain("no field named");
 });
});

describe("a correction that changes only the probes (node #277)", () => {
 const prev: DraftSpec = { title: TITLE, parent: 1, checkpoint: "minimap", kind: "task", autonomy: "propose", drafter: "deterministic" };
 const subtree = [{ id: 1, title: "(the map root)" }];
 const answer = (probes: unknown[]) =>
  claudeEnvelope({ title: TITLE, parent: 1, checkpoint: "minimap", kind: "task", autonomy: "propose", probes });
 const commands = [{ run: "bunx tsc --noEmit", cwd: "/repos/w" }, { run: "bun run test test/x.test.ts", cwd: "/repos/w" }];
 const probe = { type: "command", run: "bunx tsc --noEmit", cwd: "/repos/w", timeoutSec: 60, expectExit: 0 };

 test("the card lists probes when claude adds or changes them", () => {
  const added = parseClaudeCorrection(answer([probe]), prev, subtree, "m", commands);
  expect(added.ok && added.value.changed).toEqual(["probes"]);
  const withProbe = { ...prev, probes: [probe] } as DraftSpec;
  const changed = parseClaudeCorrection(answer([{ ...probe, run: "bun run test test/x.test.ts" }]), withProbe, subtree, "m", commands);
  expect(changed.ok && changed.value.changed).toEqual(["probes"]);
 });

 test("probes claude leaves alone, or leaves empty on a draft with none, are not a change", () => {
  const same = parseClaudeCorrection(answer([]), prev, subtree, "m", commands);
  expect(same.ok && same.value.changed).toEqual([]);
  const kept = parseClaudeCorrection(answer([probe]), { ...prev, probes: [probe] } as DraftSpec, subtree, "m", commands);
  expect(kept.ok && kept.value.changed).toEqual([]);
 });
});

describe("the superseded card (node #241)", () => {
 test("reads back as superseded, not as an answer", () => {
  const content = supersededCardContent(MAP, {
   title: TITLE, parent: 1, checkpoint: "minimap", autonomy: "propose", drafter: "deterministic",
   body: "words", messageUrl: cardUrl(MENTION), specHash: "a".repeat(64),
  }, cardUrl("2000"));
  expect(firstLine(content)).toBe(`↪️ superseded → <${cardUrl("2000")}> · ${TITLE}`);
  expect(intakeCardState(content)).toEqual({ state: "superseded" });
 });
});

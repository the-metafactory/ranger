import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type RangerMapConfig } from "../src/config.ts";
import { EscalationDiscord } from "../src/discord.ts";
import type { ForgeReadPort } from "../src/forge.ts";
import { lanePort } from "../src/forge-lanes.ts";
import {
 intakeMarker,
 intakeNodeBody,
 intakePass,
 intakeSpecHash,
 markedNode,
 PRINCIPAL_INTAKE_LABEL,
 type IntakeResult,
} from "../src/intake.ts";
import { Journal } from "../src/journal.ts";
import type { ClaudeOneShot } from "../src/substrate.ts";
import { walk } from "../src/walk.ts";
import { baseConfigLines, FAKE_BOT_ID, FAKE_GUILD_ID, fakeDiscord, fixturesBin, type FakeThreadMessage } from "./support.ts";

/**
 * The intake gate (node #251): the principal's 👍 on a draft card files the
 * drafted node once, as the machine account, labelled and marked; the
 * principal's ❌ discards it. The pass runs in-process against a fake Discord
 * (thread reads, reactions, edits), fake soma (`graph add`/`link`) and fake gh
 * (the identity read and the labelled-issue marker lookup).
 */

const interval = process.env.RANGER_DISCORD_MIN_INTERVAL_MS;
beforeAll(() => { process.env.RANGER_DISCORD_MIN_INTERVAL_MS = "5"; });
afterAll(() => {
 if (interval === undefined) delete process.env.RANGER_DISCORD_MIN_INTERVAL_MS;
 else process.env.RANGER_DISCORD_MIN_INTERVAL_MS = interval;
});

const PRINCIPAL = "500000000000000005";
const OTHER = "600000000000000006";
const THREAD = "1234567890";
const MESSAGE = "1001";
const OBSERVATION = `<@${FAKE_BOT_ID}> The minimap flickers when the window resizes\nSeen twice today.`;

function msg(id: string, author: string, content: string): FakeThreadMessage {
 const mentions = [...content.matchAll(/<@!?(\d+)>/g)].map((m) => ({ id: m[1]! }));
 return { id, content, author: { id: author }, mentions };
}

interface Issue { number: number; parent: string | null; title: string; autonomy: string; checkpoint: string; labels: string[]; body: string; machineAccount: boolean }

interface Rig {
 dir: string;
 discord: ReturnType<typeof fakeDiscord>;
 journal: Journal;
 /** The draft card's message id, once the first tick posted it. */
 card(): string;
 /** One intake pass under `extra` env, the way the walk tick runs it. */
 tick(extra?: NodeJS.ProcessEnv): Promise<IntakeResult>;
 /** How many times the gate listed the labelled issues (the marker lookup). */
 lookups(): number;
 issues(): Issue[];
 links(): unknown[];
 patchState(patch: (s: Record<string, any>) => void): void;
 close(): void;
}

/** Run `fn` with the fakes on PATH and the test env in process.env (gh and soma read it). */
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

/** A map whose thread holds one drafted principal observation (the draft tick has run). */
async function rig(opts: { claude?: ClaudeOneShot } = {}): Promise<Rig> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-intake-gate-"));
 const discord = fakeDiscord();
 const lines = baseConfigLines(dir, { auth: ["  writeTokens:", '    "acme/*": RANGER_WRITE_TEST'] });
 lines.push("principal:", "  login: jcfischer", `  discordId: "${PRINCIPAL}"`);
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, lines.join("\n"));
 const { config } = loadConfig(configPath);
 const journal = new Journal(join(dir, "state.sqlite"));
 journal.setIntakeCursor(THREAD, "1000");
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
 let lookups = 0;
 const portFor = (repo: string): Pick<ForgeReadPort, "issuesWithLabel"> => {
  const port = lanePort(config, repo);
  return { issuesWithLabel: (on, label, token) => { lookups++; return port.issuesWithLabel!(on, label, token); } };
 };
 const r: Rig = {
  dir,
  discord,
  journal,
  card: () => journal.getIntakeDraft(MESSAGE)!.cardMessageId,
  tick: (extra = {}) => withEnv({ ...env, ...extra }, () => intakePass({ config, journal, clientFor, portFor, ...(opts.claude === undefined ? {} : { claude: opts.claude }) })),
  lookups: () => lookups,
  issues: () => Object.values(state().issues ?? {}),
  links: () => state().links ?? [],
  patchState: (patch) => {
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
 discord.say(THREAD, msg(MESSAGE, PRINCIPAL, OBSERVATION));
 const drafted = await r.tick();
 expect(drafted.threads[0]!.drafted).toEqual([MESSAGE]);
 // A card posted this tick has no reaction yet: the gate does not read it.
 expect(drafted.threads[0]!.gate).toBeUndefined();
 expect(discord.reactionReads).toHaveLength(0);
 return r;
}

const gateOf = (result: IntakeResult) => result.threads[0]!.gate!;

describe("intake gate: the principal's 👍 files the draft (node #251)", () => {
 test("a principal 👍 files the node once, as the machine account, labelled and marked; the card says filed as #N", async () => {
  const r = await rig();
  try {
   const draft = r.journal.getIntakeDraft(MESSAGE)!;
   // The draft card shows the spec hash the 👍 binds to.
   expect(draft.specHash).toMatch(/^[0-9a-f]{64}$/);
   expect(r.discord.posts[0]!.content).toContain(`spec \`${draft.specHash!.slice(0, 12)}\``);
   expect(r.discord.posts[0]!.content).toContain("React 👍 to file it, ❌ to discard it.");

   r.discord.react(r.card(), "👍", PRINCIPAL);
   const result = await r.tick();
   expect(gateOf(result)).toEqual({
    read: [MESSAGE], filed: [{ messageId: MESSAGE, node: "100", added: true }], discarded: [], refused: [], deferred: [], errors: [],
   });

   const issues = r.issues();
   expect(issues).toHaveLength(1);
   const url = `https://discord.com/channels/${FAKE_GUILD_ID}/${THREAD}/${MESSAGE}`;
   expect(issues[0]).toEqual({
    number: 100,
    parent: "1",
    title: "The minimap flickers when the window resizes",
    autonomy: "propose",
    checkpoint: "the-minimap-flickers-when-the-window-resizes",
    labels: [PRINCIPAL_INTAKE_LABEL],
    body: intakeNodeBody({ body: OBSERVATION, messageUrl: url, messageId: MESSAGE }),
    machineAccount: true,
   });
   expect(issues[0]!.body.startsWith(OBSERVATION)).toBe(true);
   expect(issues[0]!.body).toContain(url);
   expect(issues[0]!.body.trimEnd().endsWith(`<!-- ranger:intake discord=${MESSAGE} -->`)).toBe(true);

   expect(r.discord.edits).toHaveLength(1);
   expect(r.discord.edits[0]!.messageId).toBe(r.card());
   expect(r.discord.edits[0]!.content.split("\n")[0]).toBe("✅ filed as #100 · The minimap flickers when the window resizes");
   expect(r.discord.edits[0]!.content).toContain("<https://github.com/acme/widgets/issues/100>");
   expect(r.journal.getIntakeDraft(MESSAGE)).toMatchObject({ status: "filed", filedNode: "100" });
   expect(r.journal.listEvents("acme/widgets").some((e) => e.kind === "intake-filed" && e.nodeId === "100")).toBe(true);

   // A filed draft is read no more, and nothing is added again.
   const reads = r.discord.reactionReads.length;
   const again = await r.tick();
   expect(again.threads[0]!.gate).toBeUndefined();
   expect(r.discord.reactionReads).toHaveLength(reads);
   expect(r.issues()).toHaveLength(1);
  } finally { r.close(); }
 });

 test("a 👍 from anyone but the principal files nothing (failure case)", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", OTHER);
   r.discord.react(r.card(), "👍", FAKE_BOT_ID);
   const result = await r.tick();
   expect(gateOf(result)).toMatchObject({ read: [MESSAGE], filed: [], discarded: [], errors: [] });
   expect(r.issues()).toHaveLength(0);
   expect(r.discord.edits).toHaveLength(0);
   expect(r.journal.getIntakeDraft(MESSAGE)).toMatchObject({ status: "draft", filedNode: null });
   expect(r.journal.getIntakeDraft(MESSAGE)!.gateReadAt).not.toBeNull();
  } finally { r.close(); }
 });

 test("a journaled spec that no longer matches the card's hash files nothing; the card stays a draft (failure case)", async () => {
  const r = await rig();
  try {
   const db = new Database(join(r.dir, "state.sqlite"));
   db.run("UPDATE intake_drafts SET title = 'Something the principal never saw' WHERE message_id = ?", [MESSAGE]);
   db.close();
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([]);
   expect(gateOf(result).refused[0]!.reason).toContain("no longer hashes");
   expect(r.issues()).toHaveLength(0);
   expect(r.discord.edits).toHaveLength(0);
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("draft");

   // A draft from before node #251 carries no hash: nothing binds the 👍.
   const legacy = new Database(join(r.dir, "state.sqlite"));
   legacy.run("UPDATE intake_drafts SET spec_hash = NULL WHERE message_id = ?", [MESSAGE]);
   legacy.close();
   expect(gateOf(await r.tick()).refused[0]!.reason).toContain("no spec hash");
   expect(r.issues()).toHaveLength(0);
  } finally { r.close(); }
 });

 test("a write identity that fails its check files nothing; the card stays a draft (failure case)", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   // The write credential resolves to the principal, not the pinned machine account: no write under it (D4).
   const principal = await r.tick({ RANGER_WRITE_TEST: "ghp_principal" });
   expect(gateOf(principal).errors[0]).toContain("write token's login 'jcfischer'");
   // The identity read itself fails.
   const down = await r.tick({ FAKE_GH_USER_FAIL: "1" });
   expect(gateOf(down).errors).toHaveLength(1);
   expect(r.issues()).toHaveLength(0);
   expect(r.discord.edits).toHaveLength(0);
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("draft");
  } finally { r.close(); }
 });

 test("a principal ❌ discards the draft: the card says discarded and nothing is filed, even beside a 👍", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   r.discord.react(r.card(), "❌", PRINCIPAL);
   const result = await r.tick();
   expect(gateOf(result)).toMatchObject({ read: [MESSAGE], filed: [], discarded: [MESSAGE], errors: [] });
   expect(r.issues()).toHaveLength(0);
   expect(r.discord.edits).toHaveLength(1);
   expect(r.discord.edits[0]!.content.split("\n")[0]).toBe("🗑️ discarded · The minimap flickers when the window resizes");
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("discarded");
   expect(r.journal.listEvents("acme/widgets").some((e) => e.kind === "intake-discarded")).toBe(true);
   // A discarded draft is read no more.
   expect((await r.tick()).threads[0]!.gate).toBeUndefined();
  } finally { r.close(); }
 });

 test("a crash after graph add and before the journal write: the next tick finds the marked node and adds no second", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   // The add lands, then the card edit fails: the tick ends before the journal records the filing.
   r.discord.failEdits(403);
   const crashed = await r.tick();
   expect(gateOf(crashed).errors[0]).toContain("HTTP 403");
   expect(r.issues()).toHaveLength(1);
   expect(r.journal.getIntakeDraft(MESSAGE)).toMatchObject({ status: "filing", filedNode: null });

   r.discord.failEdits(200);
   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "100", added: false }]);
   expect(r.issues()).toHaveLength(1);
   expect(r.discord.edits.at(-1)!.content.split("\n")[0]).toBe("✅ filed as #100 · The minimap flickers when the window resizes");
   expect(r.journal.getIntakeDraft(MESSAGE)).toMatchObject({ status: "filed", filedNode: "100" });
  } finally { r.close(); }
 });

 test("a journal that lost the filing (still draft) finds the marked node on the 👍 and adds no second", async () => {
  const r = await rig();
  try {
   r.patchState((s) => {
    s.issues = { "77": { number: 77, parent: "1", title: "x", autonomy: "propose", checkpoint: "x", labels: [PRINCIPAL_INTAKE_LABEL], body: `words\n\n${intakeMarker(MESSAGE)}`, machineAccount: true } };
   });
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "77", added: false }]);
   expect(r.issues()).toHaveLength(1);
   expect(r.journal.getIntakeDraft(MESSAGE)).toMatchObject({ status: "filed", filedNode: "77" });
  } finally { r.close(); }
 });

 test("an add that failed without saying whether it created a node leaves `filing`; the next tick asks the marker, then adds", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const failed = await r.tick({ FAKE_SOMA_ADD_FAIL: "exit" });
   expect(gateOf(failed).errors[0]).toContain("soma graph add");
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("filing");
   expect(r.issues()).toHaveLength(0);

   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "100", added: true }]);
   expect(r.issues()).toHaveLength(1);
  } finally { r.close(); }
 });

 test("an add that left its node unattached links it below the root instead of adding a second", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const result = await r.tick({ FAKE_SOMA_ADD_FAIL: "unattached" });
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "100", added: true }]);
   expect(r.issues()).toHaveLength(1);
   expect(r.issues()[0]!.parent).toBe("1");
   expect(r.links()).toEqual([{ node: "100", parent: "1" }]);
  } finally { r.close(); }
 });

 test("an unattached add whose link failed is linked by the next tick's recovery, not filed below no parent", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const failed = await r.tick({ FAKE_SOMA_ADD_FAIL: "unattached", FAKE_SOMA_LINK_FAIL: "exit" });
   expect(gateOf(failed).errors[0]).toContain("soma graph link 100 --parent 1");
   expect(r.issues()[0]!.parent).toBeNull();
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("filing");
   expect(r.discord.edits).toHaveLength(0);

   // The marker finds the node; its link failing again files nothing.
   const again = await r.tick({ FAKE_SOMA_LINK_FAIL: "exit" });
   expect(gateOf(again).errors[0]).toContain("soma graph link 100 --parent 1");
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("filing");
   expect(r.discord.edits).toHaveLength(0);

   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "100", added: false }]);
   expect(r.issues()).toHaveLength(1);
   expect(r.issues()[0]!.parent).toBe("1");
   expect(r.links()).toEqual([{ node: "100", parent: "1" }]);
   expect(r.journal.getIntakeDraft(MESSAGE)).toMatchObject({ status: "filed", filedNode: "100" });
  } finally { r.close(); }
 });

 test("a marker on an issue the machine account did not write blocks no add and names no node", async () => {
  const r = await rig();
  try {
   r.patchState((s) => {
    s.issues = { "77": { number: 77, parent: "1", title: "x", autonomy: "propose", checkpoint: "x", labels: [PRINCIPAL_INTAKE_LABEL], body: `planted\n\n${intakeMarker(MESSAGE)}`, machineAccount: false } };
   });
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "100", added: true }]);
   expect(r.issues()).toHaveLength(2);
   expect(r.discord.edits.at(-1)!.content.split("\n")[0]).toBe("✅ filed as #100 · The minimap flickers when the window resizes");
  } finally { r.close(); }
 });

 test("the gate lists the labelled issues once per thread per tick, not once per draft", async () => {
  const r = await rig();
  try {
   const second = "1002";
   r.discord.say(THREAD, msg(second, PRINCIPAL, `<@${FAKE_BOT_ID}> The fog of war resets on load`));
   expect((await r.tick()).threads[0]!.drafted).toEqual([second]);
   r.discord.react(r.card(), "👍", PRINCIPAL);
   r.discord.react(r.journal.getIntakeDraft(second)!.cardMessageId, "👍", PRINCIPAL);
   // Both adds land, then both card edits fail: both rows are left `filing`.
   r.discord.failEdits(403);
   const crashed = await r.tick();
   expect(gateOf(crashed).errors).toHaveLength(2);
   expect(r.issues()).toHaveLength(2);

   r.discord.failEdits(200);
   const before = r.lookups();
   const result = await r.tick();
   expect(gateOf(result).filed.map((f) => f.added)).toEqual([false, false]);
   expect(r.lookups() - before).toBe(1);
   expect(r.issues()).toHaveLength(2);
  } finally { r.close(); }
 });

 test("a draft whose journaled parent or autonomy changed files nothing; one drafted outside propose-minimum is refused", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const db = new Database(join(r.dir, "state.sqlite"));
   db.run("UPDATE intake_drafts SET parent = 7 WHERE message_id = ?", [MESSAGE]);
   expect(gateOf(await r.tick()).refused[0]!.reason).toContain("no longer hashes");

   // A spec drafted as auto, with the hash its card showed: ranger files propose-minimum only (#9).
   const row = r.journal.getIntakeDraft(MESSAGE)!;
   const map = { repo: row.repo, root: row.root };
   const auto = { title: row.title, parent: 1, checkpoint: row.checkpoint, autonomy: "auto", drafter: row.drafter, body: row.body, messageUrl: row.messageUrl };
   db.run("UPDATE intake_drafts SET parent = 1, autonomy = 'auto', spec_hash = ? WHERE message_id = ?", [intakeSpecHash(map, auto), MESSAGE]);
   db.close();
   expect(gateOf(await r.tick()).refused[0]!.reason).toContain("autonomy auto");
   expect(r.issues()).toHaveLength(0);
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("draft");
  } finally { r.close(); }
 });

 test("a failed reaction read or marker lookup files nothing that tick (failure case)", async () => {
  const r = await rig();
  try {
   r.discord.react(r.card(), "👍", PRINCIPAL);
   r.discord.failReactionReads(403);
   const unread = await r.tick();
   expect(gateOf(unread).errors[0]).toContain("HTTP 403");
   expect(r.journal.getIntakeDraft(MESSAGE)!.gateReadAt).toBeNull();
   r.discord.failReactionReads(200);

   const lookup = await r.tick({ FAKE_GH_INTAKE_FAIL: "exit" });
   expect(gateOf(lookup).errors[0]).toContain("issues labelled ranger:principal-intake");
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("draft");
   expect(r.issues()).toHaveLength(0);
   expect(r.discord.edits).toHaveLength(0);

   // Once both reads succeed, the 👍 files the node.
   expect(gateOf(await r.tick()).filed).toEqual([{ messageId: MESSAGE, node: "100", added: true }]);
  } finally { r.close(); }
 });

 test("a deleted draft card can never be 👍'd: it is discarded and nothing is filed", async () => {
  const r = await rig();
  try {
   r.discord.deleteMessage(r.card());
   const result = await r.tick();
   expect(gateOf(result)).toMatchObject({ discarded: [MESSAGE], filed: [], errors: [] });
   expect(r.journal.getIntakeDraft(MESSAGE)!.status).toBe("discarded");
   expect(r.issues()).toHaveLength(0);
  } finally { r.close(); }
 });

 test("the walk tick runs the gate, and a gate error fails `ranger walk`'s intake result", async () => {
  const r = await rig();
  try {
   cpSync(join(import.meta.dir, "fixtures", "data"), r.dir, { recursive: true });
   writeFileSync(join(r.dir, "acme__widgets-frontier.json"), JSON.stringify({ repo: "acme/widgets", root: "1", frontier: [] }));
   r.discord.react(r.card(), "👍", PRINCIPAL);
   const { config } = loadConfig(join(r.dir, "ranger.yaml"));
   const intakeClient = (map: RangerMapConfig) =>
    new EscalationDiscord("fake-bot-token", map.discord!.channelId, `http://127.0.0.1:${r.discord.port}`);
   const result = await withEnv(
    { PATH: `${fixturesBin}:${process.env.PATH ?? ""}`, FAKE_SOMA_DIR: r.dir, FAKE_SOMA_STATE: join(r.dir, "soma-state.json"), RANGER_WRITE_TEST: "ghp_write", RANGER_RO_TEST: "ghp_ro", RANGER_NO_SPAWN: "1" },
    () => walk({ config, configPath: join(r.dir, "ranger.yaml"), journal: r.journal, intakeClient }),
   );
   expect(result.intake.threads[0]!.gate!.filed).toEqual([{ messageId: MESSAGE, node: "100", added: true }]);
   expect(r.issues()).toHaveLength(1);
  } finally { r.close(); }
 });
});

describe("intake gate on a claude draft (node #252 beside node #251)", () => {
 test("the 👍 on a claude-drafted card binds to its kind and probes too, and files it", async () => {
  const answer = {
   title: "Minimap redraws on resize",
   parent: 1,
   checkpoint: "minimap-redraws-on-resize",
   kind: "task",
   autonomy: "approve",
   probes: [{ type: "git-ref-exists", ref: "main" }],
  };
  const claude: ClaudeOneShot = async () =>
   ({ code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: JSON.stringify(answer) }), stderr: "" });
  const r = await rig({ claude });
  try {
   const draft = r.journal.getIntakeDraft(MESSAGE)!;
   expect(draft).toMatchObject({ drafter: "claude", kind: "task", autonomy: "approve", probes: JSON.stringify(answer.probes) });
   expect(r.discord.posts[0]!.content).toContain("drafted by claude");
   expect(r.discord.posts[0]!.content).toContain(`spec \`${draft.specHash!.slice(0, 12)}\``);

   r.discord.react(r.card(), "👍", PRINCIPAL);
   const result = await r.tick();
   expect(gateOf(result).filed).toEqual([{ messageId: MESSAGE, node: "100", added: true }]);
   expect(r.issues()[0]).toMatchObject({ parent: "1", title: answer.title, autonomy: "approve", checkpoint: answer.checkpoint });
  } finally { r.close(); }
 });
});

describe("intake gate pieces (node #251)", () => {
 test("the spec hash covers every field the card shows", () => {
  const map = { repo: "acme/widgets", root: 1 };
  const draft = { title: "t", parent: 1, checkpoint: "c", autonomy: "propose", drafter: "deterministic", body: "b", messageUrl: "u" };
  const hash = intakeSpecHash(map, draft);
  for (const [key, value] of Object.entries({ title: "t2", parent: 2, checkpoint: "c2", autonomy: "approve", drafter: "llm", body: "b2", messageUrl: "u2" })) {
   expect(intakeSpecHash(map, { ...draft, [key]: value })).not.toBe(hash);
  }
  expect(intakeSpecHash({ ...map, root: 2 }, draft)).not.toBe(hash);
  expect(intakeSpecHash(map, { ...draft })).toBe(hash);
  // A claude draft's kind and probes are bound too (node #252); a draft with neither hashes as before.
  const claude = { ...draft, drafter: "claude", kind: "task", probes: [{ type: "git-ref-exists", ref: "main" }] };
  const claudeHash = intakeSpecHash(map, claude);
  expect(intakeSpecHash(map, { ...claude, kind: "research" })).not.toBe(claudeHash);
  expect(intakeSpecHash(map, { ...claude, probes: [] })).not.toBe(claudeHash);
  expect(intakeSpecHash(map, { ...draft, kind: undefined, probes: undefined })).toBe(hash);
 });

 test("the marker lookup names the one marked node, and refuses two", () => {
  const marked = (number: number, author = "ivy-bot") => ({ number, body: `x\n${intakeMarker("42")}`, author });
  expect(markedNode([{ number: 1, body: intakeMarker("4"), author: "ivy-bot" }, marked(9)], "42", "ivy-bot")).toBe("9");
  expect(markedNode([{ number: 1, body: "no marker", author: "ivy-bot" }], "42", "ivy-bot")).toBeNull();
  expect(() => markedNode([marked(9), marked(10)], "42", "ivy-bot")).toThrow("#9, #10");
  // The login compares case-insensitively; a trailing newline or CRLF still ends in the marker.
  expect(markedNode([{ number: 9, body: `x\r\n${intakeMarker("42")}\r\n`, author: "Ivy-Bot" }], "42", "ivy-bot")).toBe("9");
 });

 test("only the machine account's issue, ending in the marker, counts", () => {
  // Someone else's issue carrying the marker names nothing.
  expect(markedNode([{ number: 9, body: intakeMarker("42"), author: "intruder" }], "42", "ivy-bot")).toBeNull();
  // A marker quoted inside the body, not its final line, names nothing.
  expect(markedNode([{ number: 9, body: `see ${intakeMarker("42")}\nmore words`, author: "ivy-bot" }], "42", "ivy-bot")).toBeNull();
  // The principal's words quoting a marker: the filed body still ends in its own.
  const body = intakeNodeBody({ body: `quoting ${intakeMarker("41")}`, messageUrl: "u", messageId: "42" });
  expect(markedNode([{ number: 9, body, author: "ivy-bot" }], "41", "ivy-bot")).toBeNull();
  expect(markedNode([{ number: 9, body, author: "ivy-bot" }], "42", "ivy-bot")).toBe("9");
 });
});

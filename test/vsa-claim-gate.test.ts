import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { criterionCitations, iscExemption, iscLine, vsaClaimVerdict } from "../src/candidates.ts";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import { readBaseVsa } from "../src/vsa-gate.ts";
import { claimNode, walk } from "../src/walk.ts";
import type { ForgePort } from "../src/forge.ts";
import { runCmd } from "../src/exec.ts";
import { GIT_ENV, fakeDiscord, fixturesBin } from "./support.ts";

const VSA = [
 "## Checkpoints",
 "- [x] ISC-1: The gate is confirmed.",
 "- [ ] ISC-2: Ranger refuses uncited claims.",
 "- [ ] ISC-3.1: A sub-criterion.",
 "",
 "Prose that mentions ISC-7 is not a criterion.",
].join("\n");
const ADDED = new Date("2026-11-17T10:00:00Z");

function vsaClaimRefusal(...args: Parameters<typeof vsaClaimVerdict>): string | null {
 const verdict = vsaClaimVerdict(...args);
 return verdict !== null && "refused" in verdict ? verdict.refused : null;
}
const AFTER = new Date("2026-11-18T10:00:00Z");
const BEFORE = new Date("2026-11-16T10:00:00Z");

describe("vsaClaimRefusal", () => {
 test("a repo without VSA.md allows every claim", () => {
  expect(vsaClaimRefusal("no citation", "task", AFTER, null, null)).toBeNull();
 });
 test("a non-implement kind is exempt", () => {
  for (const kind of ["research", "decision", "propose", "approve"]) {
   expect(vsaClaimRefusal("no citation", kind, AFTER, VSA, ADDED)).toBeNull();
  }
 });
 test("an implement node created before VSA.md was added is exempt", () => {
  expect(vsaClaimRefusal("no citation", "build", BEFORE, VSA, ADDED)).toBeNull();
 });
 test("an implement node created at the instant VSA.md was added needs a citation", () => {
  expect(vsaClaimRefusal("no citation", "task", ADDED, VSA, ADDED)).toContain("cites no ISC");
 });
 test("an implement node created after VSA.md was added needs a citation", () => {
  expect(vsaClaimRefusal("no citation", "task", AFTER, VSA, ADDED)).toContain("cites no ISC");
  expect(vsaClaimRefusal(undefined, "build", AFTER, VSA, ADDED)).toContain("cites no ISC");
 });
 test("a cited criterion from VSA.md allows the claim", () => {
  expect(vsaClaimRefusal("Serves: ISC-2.", "task", AFTER, VSA, ADDED)).toBeNull();
  expect(vsaClaimRefusal("Serves: ISC-3.1 and ISC-99.", "build", AFTER, VSA, ADDED)).toBeNull();
 });
 test("only unknown ISC IDs refuse and name them", () => {
  const refusal = vsaClaimRefusal("Serves: ISC-9 and ISC-7.", "task", AFTER, VSA, ADDED);
  expect(refusal).toContain("ISC-9");
  expect(refusal).toContain("ISC-7");
  expect(refusal).toContain("not a criterion");
 });
 test("ISC-10 does not match a VSA that only has ISC-1", () => {
  const refusal = vsaClaimRefusal("Serves: ISC-10.", "task", AFTER, "- [ ] ISC-1: One.", ADDED);
  expect(refusal).toContain("ISC-10");
  expect(vsaClaimRefusal("Serves: XISC-1 and ISC-1x.", "task", AFTER, "- [ ] ISC-1: One.", ADDED)).toContain("cites no ISC");
 });
 test("an unknown node creation date refuses an implement node in a VSA repo", () => {
  expect(vsaClaimRefusal("no citation", "task", null, VSA, ADDED)).toContain("creation date");
 });
});

describe("the ISC exemption line", () => {
 test("a new uncited implement node with ISC: none (reason) is waived with that reason", () => {
  expect(vsaClaimVerdict("Body.\n\nISC: none (fix-base: main is broken)", "task", AFTER, VSA, ADDED)).toEqual({ waived: "fix-base: main is broken" });
 });
 test("an empty or blank reason does not count and the node is refused", () => {
  expect(vsaClaimRefusal("ISC: none ()", "task", AFTER, VSA, ADDED)).toContain("cites no ISC");
  expect(vsaClaimRefusal("ISC: none (   )", "build", AFTER, VSA, ADDED)).toContain("cites no ISC");
 });
 test("the line counts only at line start and case-sensitively", () => {
  expect(vsaClaimRefusal("See ISC: none (quoted)", "task", AFTER, VSA, ADDED)).toContain("cites no ISC");
  expect(vsaClaimRefusal("isc: none (lower case)", "task", AFTER, VSA, ADDED)).toContain("cites no ISC");
 });
 test("a known citation allows without a waiver, and an older node needs neither", () => {
  expect(vsaClaimVerdict("Serves: ISC-2.\nISC: none (stale)", "task", AFTER, VSA, ADDED)).toBeNull();
  expect(vsaClaimVerdict("ISC: none (old)", "task", BEFORE, VSA, ADDED)).toBeNull();
 });
 test("iscExemption reads the reason; iscLine writes both formats; criterionCitations keeps only VSA criteria", () => {
  expect(iscExemption("x\nISC: none (follows #12, which cites no ISC)\n")).toBe("follows #12, which cites no ISC");
  expect(iscLine(["ISC-7", "ISC-9"])).toBe("Serves: ISC-7, ISC-9.");
  expect(iscLine([], "fix-base: main is broken")).toBe("ISC: none (fix-base: main is broken)");
  expect(iscLine([])).toBeNull();
  expect(criterionCitations("ISC-3.1, ISC-7, ISC-2 and ISC-3.1 again", VSA)).toEqual(["ISC-3.1", "ISC-2"]);
 });
});

describe("only the Serves: line cites", () => {
 const VSA_WITH_ISC_9 = `${VSA}\n- [ ] ISC-9: The claim gate refuses uncited nodes.`;
 test("threva #197 names ISC-9 in its prose and has no Serves: line, so it is refused", () => {
  const body = readFileSync(join(import.meta.dir, "fixtures/threva-197-body.md"), "utf8");
  expect(vsaClaimRefusal(body, "build", AFTER, VSA_WITH_ISC_9, ADDED)).toContain("cites no ISC");
 });
 test("an ISC named in prose beside a Serves: line does not count", () => {
  expect(vsaClaimRefusal("Builds on ISC-2.\n\nServes: ISC-42.", "task", AFTER, VSA, ADDED)).toContain("ISC-42, not a criterion");
 });
 test("the Serves: line counts anywhere in the body, with or without a gloss", () => {
  expect(vsaClaimRefusal("## Deliverable\n\nText.\n\nServes: ISC-2.", "task", AFTER, VSA, ADDED)).toBeNull();
  expect(vsaClaimRefusal("Serves: ISC-2 (VSA.md: ranger refuses uncited claims).", "task", AFTER, VSA, ADDED)).toBeNull();
 });
 test("a Serves: that does not start its line does not count", () => {
  expect(vsaClaimRefusal("This node Serves: ISC-2.", "task", AFTER, VSA, ADDED)).toContain("cites no ISC");
 });
});

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
 const result = await runCmd("git", args, { cwd, env: { ...process.env, ...GIT_ENV, ...env } });
 if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

async function seedCanonicalAddingVsaAtAddedThenEditing(dir: string, vsa: boolean): Promise<string> {
 const seed = join(dir, "seed");
 mkdirSync(seed, { recursive: true });
 writeFileSync(join(seed, "README.md"), "# widgets\n");
 await git(seed, ["init", "-q", "-b", "main"]);
 await git(seed, ["add", "-A"]);
 await git(seed, ["commit", "-q", "-m", "initial"], { GIT_COMMITTER_DATE: "2026-11-01T10:00:00Z" });
 if (vsa) {
  writeFileSync(join(seed, "VSA.md"), "- [ ] ISC-2: draft\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-q", "-m", "add vsa"], { GIT_COMMITTER_DATE: ADDED.toISOString() });
  writeFileSync(join(seed, "VSA.md"), VSA);
  await git(seed, ["commit", "-q", "-am", "edit vsa"], { GIT_COMMITTER_DATE: AFTER.toISOString() });
 }
 const origin = join(dir, "origin.git");
 await git(dir, ["clone", "-q", "--bare", seed, origin]);
 const canonical = join(dir, "canonical");
 await git(dir, ["clone", "-q", origin, canonical]);
 return canonical;
}

describe("readBaseVsa", () => {
 let dir: string;
 beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ranger-vsa-")); });
 afterEach(() => rmSync(dir, { recursive: true, force: true }));

 test("reads the base's VSA.md and dates it by the commit that added it", async () => {
  const canonical = await seedCanonicalAddingVsaAtAddedThenEditing(dir, true);
  const read = await readBaseVsa(canonical, "main");
  expect(read?.text).toBe(VSA);
  expect(read?.createdAt.toISOString()).toBe(ADDED.toISOString());
 });
 test("a base without VSA.md reads as none", async () => {
  expect(await readBaseVsa(await seedCanonicalAddingVsaAtAddedThenEditing(dir, false), "main")).toBeNull();
 });
 test("a missing checkout reads as none", async () => {
  expect(await readBaseVsa(join(dir, "absent"), "main")).toBeNull();
 });
 test("the add date is read once per base commit: a cached date for the same SHA is used, a new SHA re-reads it", async () => {
  const canonical = await seedCanonicalAddingVsaAtAddedThenEditing(dir, true);
  const health = new Map<string, string>();
  const cache = { getHealth: (k: string) => health.get(k) ?? null, setHealth: (k: string, v: string) => { health.set(k, v); } };
  expect((await readBaseVsa(canonical, "main", cache))?.createdAt.toISOString()).toBe(ADDED.toISOString());
  expect(health.size).toBe(1);
  const [key, value] = [...health][0];
  const planted = new Date("2026-01-01T00:00:00Z");
  health.set(key, `${value.split(" ")[0]} ${planted.toISOString()}`);
  expect((await readBaseVsa(canonical, "main", cache))?.createdAt.toISOString()).toBe(planted.toISOString());
  writeFileSync(join(canonical, "other.md"), "x\n");
  await git(canonical, ["add", "-A"]);
  await git(canonical, ["commit", "-q", "-m", "other"]);
  await git(canonical, ["push", "-q", "origin", "HEAD:main"]);
  await git(canonical, ["fetch", "-q", "origin"]);
  expect((await readBaseVsa(canonical, "main", cache))?.createdAt.toISOString()).toBe(ADDED.toISOString());
 });
 test("an unreadable base ref throws", async () => {
  await expect(readBaseVsa(await seedCanonicalAddingVsaAtAddedThenEditing(dir, true), "no-such-branch")).rejects.toThrow();
 });
});

describe("claimNode VSA gate", () => {
 const repo = "acme/widgets";
 let dir: string;
 let config: RangerConfig;
 let journal: Journal;
 beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-vsa-claim-"));
  const canonical = await seedCanonicalAddingVsaAtAddedThenEditing(dir, true);
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, stringify({ maps: [{ repo, root: 1, walk: "full", canonical, commands: { test: "true" } }],
   state: { journalPath: join(dir, "journal.sqlite") } }));
  config = loadConfig(configPath).config;
  journal = new Journal(config.state.journalPath);
 });
 afterEach(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });

 const claim = (body: string, createdAt: Date, announced: string[], announceFails = false) => claimNode({
  config, journal, map: config.maps[0], node: { id: "30", title: "Feature", kind: "task", body }, lane: "implement",
  botIdentity: "ivy-bot", token: "unused", cliEntry: "/tmp/ranger/cli.ts", configPath: join(dir, "ranger.yaml"),
  forge: { issueCreatedAt: async () => createdAt.toISOString() },
  announce: async (_map, ctx) => {
   if (announceFails) throw new Error("discord down");
   announced.push(ctx.nodeId);
   return { messageId: "message" };
  },
  claim: async () => ({ repo, node: "30", held: true, assignees: ["ivy-bot"] }),
  spawnRunNode: async () => 123,
 });

 test("a new uncited implement node is refused before announce and journaled as refused", async () => {
  const announced: string[] = [];
  const outcome = await claim("Build the thing.", AFTER, announced);
  expect(outcome).toMatchObject({ claimed: false, error: expect.stringContaining("cites no ISC") });
  expect(announced).toEqual([]);
  expect(journal.getWorker("30", repo)).toBeNull();
  const refused = journal.listEvents(repo, 50, "30").filter(e => e.kind === "refused");
  expect(refused).toHaveLength(1);
  expect(refused[0].detail).toContain("#30");
  expect(refused[0].detail).toContain("cites no ISC");
 });

 test("a new node citing a known ISC is claimed", async () => {
  const announced: string[] = [];
  expect(await claim("Serves: ISC-2.", AFTER, announced)).toMatchObject({ claimed: true });
  expect(announced).toEqual(["30"]);
 });

 test("a new node with ISC: none (reason) is claimed and journals the waiver once, with the reason", async () => {
  const announced: string[] = [];
  const body = "Build the thing.\n\nISC: none (fix-base: main is broken)";
  expect(await claim(body, AFTER, announced, true)).toMatchObject({ claimed: false, error: expect.stringContaining("announce failed") });
  expect(await claim(body, AFTER, announced)).toMatchObject({ claimed: true });
  expect(announced).toEqual(["30"]);
  const events = journal.listEvents(repo, 50, "30");
  expect(events.filter(e => e.kind === "refused")).toHaveLength(0);
  const waived = events.filter(e => e.kind === "vsa-waived");
  expect(waived).toHaveLength(1);
  expect(waived[0].detail).toContain("fix-base: main is broken");
 });

 test("a new node whose ISC: none line has an empty reason is refused", async () => {
  const announced: string[] = [];
  expect(await claim("Build.\n\nISC: none ()", AFTER, announced)).toMatchObject({ claimed: false, error: expect.stringContaining("cites no ISC") });
  expect(announced).toEqual([]);
  expect(journal.listEvents(repo, 50, "30").filter(e => e.kind === "vsa-waived")).toHaveLength(0);
 });

 test("an older uncited node is claimed", async () => {
  const announced: string[] = [];
  expect(await claim("Build the thing.", BEFORE, announced)).toMatchObject({ claimed: true });
 });

 async function pushVsaFromElsewhere(text: string): Promise<void> {
  const other = join(dir, "other");
  await git(dir, ["clone", "-q", join(dir, "origin.git"), other]);
  writeFileSync(join(other, "VSA.md"), text);
  await git(other, ["commit", "-q", "-am", "add ISC-20"]);
  await git(other, ["push", "-q", "origin", "HEAD:main"]);
 }
 const VSA_WITH_ISC_20 = `${VSA}\n- [ ] ISC-20: Added after the canonical clone last fetched.\n`;

 test("a node citing a criterion only on the remote's VSA.md is claimed after the gate fetches the base", async () => {
  await pushVsaFromElsewhere(VSA_WITH_ISC_20);
  const announced: string[] = [];
  expect(await claim("Serves: ISC-20.", AFTER, announced)).toMatchObject({ claimed: true });
  expect(announced).toEqual(["30"]);
  expect(journal.listEvents(repo, 50, "30").filter(e => e.kind === "refused")).toHaveLength(0);
 });

 test("a node citing a criterion absent on the remote too is still refused and journaled after the fetch", async () => {
  await pushVsaFromElsewhere(VSA_WITH_ISC_20);
  const announced: string[] = [];
  const outcome = await claim("Serves: ISC-21.", AFTER, announced);
  expect(outcome).toMatchObject({ claimed: false, error: expect.stringContaining("ISC-21, not a criterion") });
  expect(announced).toEqual([]);
  const refused = journal.listEvents(repo, 50, "30").filter(e => e.kind === "refused");
  expect(refused).toHaveLength(1);
  expect(refused[0].detail).toContain("ISC-21");
 });

 test("a failed fetch keeps the refusal and names the fetch error", async () => {
  rmSync(join(dir, "origin.git"), { recursive: true, force: true });
  const announced: string[] = [];
  const outcome = await claim("Serves: ISC-20.", AFTER, announced);
  if (outcome.claimed) throw new Error("claimed despite a failed fetch");
  expect(outcome.error).toContain("ISC-20, not a criterion");
  expect(outcome.error).toContain("fetch of origin/main failed");
  expect(announced).toEqual([]);
  expect(journal.listEvents(repo, 50, "30").find(e => e.kind === "refused")?.detail).toContain("fetch of origin/main failed");
 });

 test("a failed node-date read refuses the claim with the error", async () => {
  const announced: string[] = [];
  const outcome = await claimNode({
   config, journal, map: config.maps[0], node: { id: "30", title: "Feature", kind: "build", body: "x" }, lane: "implement",
   botIdentity: "ivy-bot", token: "unused", cliEntry: "/tmp/ranger/cli.ts", configPath: join(dir, "ranger.yaml"),
   forge: { issueCreatedAt: async () => { throw new Error("forge down"); } },
   announce: async (_map, ctx) => { announced.push(ctx.nodeId); return { messageId: "message" }; },
   claim: async () => ({ repo, node: "30", held: true, assignees: ["ivy-bot"] }),
   spawnRunNode: async () => 123,
  });
  expect(outcome).toMatchObject({ claimed: false, error: expect.stringContaining("forge down") });
  expect(announced).toEqual([]);
 });
});

describe("walk VSA gate", () => {
 const repo = "acme/widgets";
 let dir: string;
 let config: RangerConfig;
 let configPath: string;
 let journal: Journal;
 let discord: ReturnType<typeof fakeDiscord>;
 let env: Record<string, string>;
 beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-vsa-walk-"));
  const canonical = await seedCanonicalAddingVsaAtAddedThenEditing(dir, true);
  discord = fakeDiscord();
  configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, stringify({
   version: 1,
   maps: [{ repo, root: 1, walk: "full", canonical, commands: { test: "true" },
    discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" } }],
   bot: { identity: "ivy-bot" },
   auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
   state: { journalPath: join(dir, "journal.sqlite") },
  }));
  config = loadConfig(configPath).config;
  journal = new Journal(config.state.journalPath);
  const data = join(dir, "data");
  mkdirSync(data);
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
  env = {
   PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
   FAKE_SOMA_DIR: data, FAKE_SOMA_STATE: state,
   RANGER_WRITE_TEST: "ghp_write", RANGER_NO_SPAWN: "1",
   RANGER_DISCORD_TOKEN: "fake-bot-token",
   RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
   RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5",
  };
 });
 afterEach(() => { journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true }); });

 const frontier = (nodes: { id: string; body: string; kind?: string }[]) => writeFileSync(
  join(env.FAKE_SOMA_DIR, `${repo.replace("/", "__")}-frontier.json`),
  JSON.stringify({ repo, root: "1", frontier: nodes.map(({ id, body, kind }) => ({
   ref: { id }, node: { id, title: `Build ${id}`, kind: kind ?? "task", autonomy: "auto", probes: [] }, body,
   status: "open", assignees: [], blockedBy: [], author: "alice", typed: true,
   url: `https://github.com/${repo}/issues/${id}`,
  })) }));

 async function tick(createdAt: Record<string, Date>, reads: string[]) {
  const saved = { ...process.env };
  const github = {
   issueCreatedAt: async (_repo: string, issue: number) => { reads.push(String(issue)); return createdAt[String(issue)].toISOString(); },
   issueLabels: async () => [],
  } as unknown as ForgePort;
  try {
   Object.assign(process.env, env);
   return await walk({ config, configPath, journal, github, spawnRunNode: async () => process.pid,
    claim: async (_repo, node) => ({ repo, node, held: true, assignees: ["ivy-bot"] }),
    hostLoad: () => ({ load: 0, cores: 8 }) });
  } finally {
   for (const key of Object.keys(process.env)) if (!(key in saved)) Reflect.deleteProperty(process.env, key);
   Object.assign(process.env, saved);
  }
 }

 test("a refused head does not block the implement lane: the next implement candidate is claimed in the same tick", async () => {
  frontier([{ id: "30", body: "Build the thing." }, { id: "31", body: "Serves: ISC-2." }, { id: "32", body: "Serves: ISC-2." }]);
  const reads: string[] = [];
  const result = await tick({ 30: AFTER, 31: AFTER, 32: AFTER }, reads);
  expect(result.maps[0].claimed).toEqual(["31"]);
  expect(journal.getWorker("30", repo)).toBeNull();
  expect(reads).toEqual(["30", "31"]);
  expect(journal.listEvents(repo, 50, "30").filter(e => e.kind === "refused")).toHaveLength(1);
 });

 test("the replanned head is held like the first plan's: with briefs unverified, a build node behind a refused head is not claimed", async () => {
  frontier([
   { id: "30", body: "Build the thing." },
   { id: "31", body: "Serves: ISC-2.", kind: "build" },
   { id: "32", body: "Serves: ISC-2." },
  ]);
  env.FAKE_SOMA_AUDIT_FAIL = "1";
  const reads: string[] = [];
  const result = await tick({ 30: AFTER, 31: AFTER, 32: AFTER }, reads);
  expect(result.maps[0].errors).toContainEqual(expect.stringContaining("build briefs unverified"));
  expect(result.maps[0].claimed).toEqual(["32"]);
  expect(journal.getWorker("31", repo)).toBeNull();
  expect(reads).toEqual(["30", "32"]);
 });

 test("a vetoed node replanned behind a refused head is reported and not claimed", async () => {
  frontier([{ id: "30", body: "Build the thing." }, { id: "31", body: "Serves: ISC-2." }, { id: "32", body: "Serves: ISC-2." }]);
  journal.recordVeto({ repo, nodeId: "31", root: 1, commentId: "c-31" });
  const reads: string[] = [];
  const result = await tick({ 30: AFTER, 31: AFTER, 32: AFTER }, reads);
  expect(result.maps[0].claimed).toEqual([]);
  expect(result.maps[0].errors).toContain("#31 vetoed — not claimed");
  expect(journal.getWorker("31", repo)).toBeNull();
  expect(reads).toEqual(["30"]);
 });

 test("a refused head with an older node behind it lets the older node through", async () => {
  frontier([{ id: "30", body: "Build the thing." }, { id: "31", body: "Build the other thing." }]);
  const result = await tick({ 30: AFTER, 31: BEFORE }, []);
  expect(result.maps[0].claimed).toEqual(["31"]);
 });

 test("a refused head over two ticks reads its issue creation date from the forge once", async () => {
  frontier([{ id: "30", body: "Build the thing." }]);
  const reads: string[] = [];
  for (let i = 0; i < 2; i++) expect((await tick({ 30: AFTER }, reads)).maps[0].claimed).toEqual([]);
  expect(reads).toEqual(["30"]);
 });

 test("the same refused head over two ticks journals one refused event", async () => {
  frontier([{ id: "30", body: "Build the thing." }]);
  for (let i = 0; i < 2; i++) expect((await tick({ 30: AFTER }, [])).maps[0].claimed).toEqual([]);
  expect(journal.listEvents(repo, 50, "30").filter(e => e.kind === "refused")).toHaveLength(1);
 });
});

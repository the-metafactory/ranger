import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { vsaClaimRefusal } from "../src/candidates.ts";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import { readBaseVsa } from "../src/vsa-gate.ts";
import { claimNode } from "../src/walk.ts";
import { runCmd } from "../src/exec.ts";
import { GIT_ENV } from "./support.ts";

const VSA = [
 "## Checkpoints",
 "- [x] ISC-1: The gate is confirmed.",
 "- [ ] ISC-2: Ranger refuses uncited claims.",
 "- [ ] ISC-3.1: A sub-criterion.",
 "",
 "Prose that mentions ISC-7 is not a criterion.",
].join("\n");
const ADDED = new Date("2026-11-17T10:00:00Z");
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
  expect(vsaClaimRefusal("Serves ISC-2.", "task", AFTER, VSA, ADDED)).toBeNull();
  expect(vsaClaimRefusal("Serves ISC-3.1 and ISC-99.", "build", AFTER, VSA, ADDED)).toBeNull();
 });
 test("only unknown ISC IDs refuse and name them", () => {
  const refusal = vsaClaimRefusal("Serves ISC-9 and ISC-7.", "task", AFTER, VSA, ADDED);
  expect(refusal).toContain("ISC-9");
  expect(refusal).toContain("ISC-7");
  expect(refusal).toContain("not a criterion");
 });
 test("ISC-10 does not match a VSA that only has ISC-1", () => {
  const refusal = vsaClaimRefusal("Serves ISC-10.", "task", AFTER, "- [ ] ISC-1: One.", ADDED);
  expect(refusal).toContain("ISC-10");
  expect(vsaClaimRefusal("Serves XISC-1 and ISC-1x.", "task", AFTER, "- [ ] ISC-1: One.", ADDED)).toContain("cites no ISC");
 });
 test("an unknown node creation date refuses an implement node in a VSA repo", () => {
  expect(vsaClaimRefusal("no citation", "task", null, VSA, ADDED)).toContain("creation date");
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

 const claim = (body: string, createdAt: Date, announced: string[]) => claimNode({
  config, journal, map: config.maps[0], node: { id: "30", title: "Feature", kind: "task", body }, lane: "implement",
  botIdentity: "ivy-bot", token: "unused", cliEntry: "/tmp/ranger/cli.ts", configPath: join(dir, "ranger.yaml"),
  forge: { issueCreatedAt: async () => createdAt.toISOString() },
  announce: async (_map, ctx) => { announced.push(ctx.nodeId); return { messageId: "message" }; },
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
  expect(await claim("Serves ISC-2.", AFTER, announced)).toMatchObject({ claimed: true });
  expect(announced).toEqual(["30"]);
 });

 test("an older uncited node is claimed", async () => {
  const announced: string[] = [];
  expect(await claim("Build the thing.", BEFORE, announced)).toMatchObject({ claimed: true });
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

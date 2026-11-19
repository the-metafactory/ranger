import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlockedReport } from "../src/blocked-report.ts";
import { loadConfig, type RangerConfig } from "../src/config.ts";
import type { RunOptions, RunResult } from "../src/exec.ts";
import { Journal } from "../src/journal.ts";
import { parkForRelease, releaseWatchKey, watchReleases, type ReleasePark, type ReleaseReads } from "../src/release.ts";

const dirs: string[] = [];
const journals: Journal[] = [];
afterEach(() => {
 for (const j of journals.splice(0)) j.close();
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);

function setup(release?: string): { config: RangerConfig; journal: Journal } {
 const dir = mkdtempSync(join(tmpdir(), "ranger-release-test-"));
 dirs.push(dir);
 const upstream = [
  "  - repo: acme/sdk",
  "    root: 1",
  "    walk: research-only",
  ...(release === undefined ? [] : ["    commands:", `      release: ${release}`]),
  "    discord:",
  "      tokenEnv: RANGER_DISCORD_TOKEN",
  '      channelId: "1234567891"',
 ];
 const yaml = [
  "version: 1",
  "maps:",
  "  - repo: acme/widgets",
  "    root: 1",
  "    walk: full",
  "    discord:",
  "      tokenEnv: RANGER_DISCORD_TOKEN",
  '      channelId: "1234567890"',
  ...upstream,
  "auth:",
  "  readOnlyTokens:",
  '    "acme/*": RANGER_RO_TEST',
  "bot:",
  "  identity: ivy-bot",
  "state:",
  `  journalPath: ${join(dir, "state.sqlite")}`,
 ].join("\n");
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, yaml);
 const config = loadConfig(path, {}, () => {}).config;
 const journal = new Journal(join(dir, "state.sqlite"));
 journals.push(journal);
 return { config, journal };
}

function reads(tags: (string | null)[], ahead = 3): ReleaseReads & { tagReads: number } {
 const fake = {
  tagReads: 0,
  latestTag: async () => {
   const tag = tags[Math.min(fake.tagReads, tags.length - 1)];
   fake.tagReads += 1;
   return tag;
  },
  sinceTag: async () => ({ head: HEAD, ahead }),
 };
 return fake;
}

function park(config: RangerConfig, journal: Journal, extra: Partial<ReleasePark> & { announced: string[]; runs: string[] }, nodeId = "20"): ReleasePark {
 const map = config.maps.find((m) => m.repo === "acme/widgets");
 if (map === undefined) throw new Error("no widgets map");
 return {
  config, journal, map, node: { id: nodeId, title: "Use the SDK export" }, generation: 1, upstream: "acme/sdk",
  reads: reads(["v1.0.0"]), fence: () => {},
  announce: async (text) => { extra.announced.push(text); },
  run: async (command: string, opts: RunOptions): Promise<RunResult> => {
   extra.runs.push(`${command} @ ${opts.env?.RANGER_RELEASE_HEAD ?? "?"}`);
   return { code: 0, stdout: "building\nv1.1.0\n", stderr: "" };
  },
  ...extra,
 };
}

const events = (journal: Journal, kind: string) => journal.listEvents("acme/widgets", 200).filter((e) => e.kind === kind).map((e) => e.detail ?? "");

test("a blocked report's Needs-release line names the upstream repo and stays out of the reason and the condition", () => {
 const report = parseBlockedReport("# Blocked\n\nThe SDK export is merged but unreleased.\n\n**Needs-release:** `the-metafactory/cortex`\n\nResume condition: a Cortex release carries the export.\n");
 expect(report).toEqual({
  reason: "Blocked The SDK export is merged but unreleased.",
  resume: "a Cortex release carries the export.",
  needsRelease: "the-metafactory/cortex",
 });
 expect(parseBlockedReport("Blocked.\nneeds release: acme/sdk\n").needsRelease).toBe("acme/sdk");
 expect(parseBlockedReport("Blocked.\nNeeds-release: the next Cortex release\nResume condition: a release.\n").needsRelease).toBeUndefined();
 expect(parseBlockedReport("Blocked.\nResume condition: a release of acme/sdk.\n").needsRelease).toBeUndefined();
});

test("with no release command the park asks the principal once and records the tag to watch", async () => {
 const { config, journal } = setup();
 const seen = { announced: [] as string[], runs: [] as string[] };
 await parkForRelease(park(config, journal, seen));
 await parkForRelease(park(config, journal, seen));
 expect(seen.runs).toEqual([]);
 expect(seen.announced).toHaveLength(1);
 expect(seen.announced[0]).toContain("acme/sdk has no release command in ranger's config");
 expect(events(journal, "release-escalated")).toHaveLength(1);
 expect(JSON.parse(journal.getHealth(releaseWatchKey("acme/widgets", "20")) ?? "null")).toEqual({ upstream: "acme/sdk", tag: "v1.0.0", generation: 1 });
});

test("a configured release command runs once per upstream head, however many parks wait for it", async () => {
 const { config, journal } = setup("cut-release");
 const seen = { announced: [] as string[], runs: [] as string[] };
 await parkForRelease(park(config, journal, seen, "20"));
 await parkForRelease(park(config, journal, seen, "21"));
 expect(seen.runs).toEqual([`cut-release @ ${HEAD}`]);
 expect(events(journal, "release-cut")).toEqual(["cut acme/sdk v1.1.0 at aaaaaaaa for #20"]);
 expect(events(journal, "release-requested")).toContain("a release of acme/sdk at aaaaaaaa was already requested; #21 waits for its tag");
 expect(events(journal, "release-escalated")).toEqual([]);
 expect(seen.announced).toEqual(["🏷️ Ranger cut acme/sdk v1.1.0 at `aaaaaaaa`: node #20 resumes once the release watch sees the tag."]);
});

test("no release is cut when the upstream base has no commits since its newest tag", async () => {
 const { config, journal } = setup("cut-release");
 const seen = { announced: [] as string[], runs: [] as string[] };
 await parkForRelease(park(config, journal, { ...seen, reads: reads(["v1.0.0"], 0) }));
 expect(seen.runs).toEqual([]);
 expect(events(journal, "release-escalated")[0]).toContain("has no commits since v1.0.0");
});

test("a failed release command is journaled and announced", async () => {
 const { config, journal } = setup("cut-release");
 const seen = { announced: [] as string[], runs: [] as string[] };
 await parkForRelease(park(config, journal, { ...seen, run: async () => ({ code: 2, stdout: "", stderr: "gh: not logged in" }) }));
 expect(events(journal, "release-failed")).toEqual(["release of acme/sdk at aaaaaaaa FAILED: exited 2: gh: not logged in"]);
 expect(seen.announced[0]).toContain("failed: exited 2: gh: not logged in");
});

test("the release watch queues the parked node's resume once a new tag appears, and not on the same tag", async () => {
 const { config, journal } = setup();
 journal.insertWorker({ nodeId: "20", repo: "acme/widgets", root: 1, status: "parked" });
 const generation = journal.getWorker("20", "acme/widgets")?.generation ?? 0;
 const seen = { announced: [] as string[], runs: [] as string[] };
 await parkForRelease({ ...park(config, journal, seen), generation });
 const watched = reads(["v1.0.0", "v1.1.0"]);
 await watchReleases({ journal, maps: config.maps, reads: watched });
 expect(journal.getResume("acme/widgets", "20")).toBeNull();
 expect(events(journal, "release-seen")).toEqual([]);
 await watchReleases({ journal, maps: config.maps, reads: watched });
 expect(journal.getResume("acme/widgets", "20")).toMatchObject({ nodeId: "20", root: 1 });
 expect(events(journal, "release-seen")).toEqual(["acme/sdk released v1.1.0 (parked at v1.0.0): #20 queued to resume"]);
 await watchReleases({ journal, maps: config.maps, reads: watched });
 expect(events(journal, "release-seen")).toHaveLength(1);
});

test("the release watch ignores a watch an older park of the node recorded", async () => {
 const { config, journal } = setup();
 journal.insertWorker({ nodeId: "20", repo: "acme/widgets", root: 1, status: "parked" });
 const generation = journal.getWorker("20", "acme/widgets")?.generation ?? 0;
 const seen = { announced: [] as string[], runs: [] as string[] };
 await parkForRelease({ ...park(config, journal, seen), generation: generation - 1 });
 await watchReleases({ journal, maps: config.maps, reads: reads(["v2.0.0"]) });
 expect(journal.getResume("acme/widgets", "20")).toBeNull();
});

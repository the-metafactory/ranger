import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { parseForgeRef, encodeForgeRef, decodeForgeKey, normalizeNodeId } from "../src/forge-ref.ts";
import { graphFrontier, graphNode, graphAudit, somaRepo, type FrontierEntry } from "../src/graph.ts";
import { graphClaim, graphRelease } from "../src/graph-write.ts";
import { mapKey } from "../src/maps.ts";
import { workerLogFile } from "../src/worker-log.ts";
import { buildNowArgv, launchPlan } from "../src/serve.ts";
import { resumeArgv, mergeArgv } from "../src/serve-parked.ts";
import { frontierCacheKey, cachedFrontier } from "../src/frontier-cache.ts";
import { Journal } from "../src/journal.ts";

const gitlab = "gitlab:gitlab.software.geant.org/claw/crisis-simulator";

function configWith(repo: string, section: "maps" | "serve" | "legacy" = "maps") {
 const dir = mkdtempSync(join(tmpdir(), "ranger-forge-ref-"));
 const path = join(dir, "ranger.yaml");
 const map = `  - repo: ${JSON.stringify(repo)}\n    root: 12\n`;
 const yaml = section === "maps" ? `maps:\n${map}` : `maps:\n  - repo: acme/widgets\n    root: 1\n` +
  (section === "serve" ? `serve:\n  extraMaps:\n${map.split("\n").map(l => l ? "  " + l : l).join("\n")}` :
   `state:\n  legacyMapRoots:\n    ${JSON.stringify(repo)}: 12\n`);
 writeFileSync(path, yaml);
 try { return loadConfig(path).config; }
 finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("ForgeRef config and identity seam", () => {
 test("today's registry retains explicit GitHub argument, journal, cache and file values", () => {
  const config = loadConfig(join(import.meta.dir, "../ranger.yaml"), {}).config;
  const expected = [
   ["the-metafactory/ranger", 1, "the-metafactory__ranger"],
   ["jcfischer/seekolous", 26, "jcfischer__seekolous"],
   ["jcfischer/seelite", 1, "jcfischer__seelite"],
   ["jcfischer/seelite", 460, "jcfischer__seelite"],
   ["the-metafactory/soma", 604, "the-metafactory__soma"],
   ["the-metafactory/soma", 645, "the-metafactory__soma"],
   ["the-metafactory/soma", 565, "the-metafactory__soma"],
   ["the-metafactory/soma", 706, "the-metafactory__soma"],
   ["the-metafactory/soma", 533, "the-metafactory__soma"],
  ] as const;
  expect(config.maps.map(m => [m.repo, m.root])).toEqual(expected.map(([repo, root]) => [repo, root]));
  for (const [index, [repo, root, fileRepo]] of expected.entries()) {
   const map = config.maps[index];
   expect(map.forgeRef).toEqual({ forge: "github", host: "github.com", path: repo });
   expect(somaRepo(repo)).toBe(`github:github.com/${repo}`);
   expect(mapKey(map)).toBe(`${repo}#${root}`);
   expect(frontierCacheKey(repo, root)).toBe(`frontier:${repo}#${root}`);
   expect(encodeForgeRef(map.forgeRef, root)).toEqual({
    key: `${repo}#${root}`, journalKey: `${repo}:${root}`,
    cacheKey: `frontier:${repo}#${root}`, fileStem: `${fileRepo}-${root}`,
   });
   expect(basename(workerLogFile("/tmp/state.sqlite", repo, String(root), 2))).toBe(`${fileRepo}-${root}-g2.log`);
  }
 });

 test("qualified GitLab maps, serve maps and legacy roots load", () => {
  const map = configWith(gitlab).maps[0];
  expect(map.forgeRef).toEqual({ forge: "gitlab", host: "gitlab.software.geant.org", path: "claw/crisis-simulator" });
  expect(map.repo).toBe(gitlab);
  expect(map.root).toBe(12);
  expect(somaRepo(map.forgeRef)).toBe(gitlab);
  expect(somaRepo(map.repo)).toBe(gitlab);
  expect(configWith(gitlab, "serve").serve?.extraMaps[0].forgeRef).toEqual(map.forgeRef);
  expect(configWith(gitlab, "legacy").state.legacyMapRoots[gitlab]).toBe(12);
  expect(configWith("gitlab:host/a/b/c").maps[0].forgeRef.path).toBe("a/b/c");
 });

 test("invalid refs fail config with map identity and section", () => {
  for (const repo of ["gitlab:host", "gitlab:host/../x", "gitlab:host/a/..", "gitlab:host/a/b$c",
   "gitlab:host/a//b", "gitlab:host/a/b/", "gitlab:host/a/b%2Fc", "gitlab:host/a/b#12",
   "unknown:host/a/b", "github:other.host/a/b", "a/..", "../b", "gitlab:host/a/b\n", "a/b\n"]) {
   for (const section of ["maps", "serve", "legacy"] as const) {
    expect(() => configWith(repo, section)).toThrow(repo);
   }
  }
 });

 test("bare and qualified GitHub share typed identity and today's encodings", () => {
  expect(parseForgeRef("acme/widgets")).toEqual(parseForgeRef("github:github.com/acme/widgets"));
  expect(parseForgeRef("acme/widgets")).toBe(parseForgeRef("github:github.com/acme/widgets"));
  expect(configWith("github:github.com/acme/widgets").maps[0].repo).toBe("acme/widgets");
  expect(encodeForgeRef(parseForgeRef("acme/widgets"), "<@123>").journalKey).toBe("acme/widgets:<@123>");
  expect(() => decodeForgeKey("acme/widgets#<@123>")).toThrow();
  expect(encodeForgeRef(parseForgeRef("github:github.com/acme/widgets"), 12)).toEqual({
   key: "acme/widgets#12", journalKey: "acme/widgets:12", cacheKey: "frontier:acme/widgets#12", fileStem: "acme__widgets-12",
  });
 });

 test("GitLab encodings distinguish host and project, round-trip keys and make safe filenames", () => {
  const refs = [gitlab, "gitlab:other.host/claw/crisis-simulator", "gitlab:host/a/b/c", "gitlab:host/a__b/c"];
  const stems = refs.map(repo => {
   const ref = parseForgeRef(repo);
   const encoded = encodeForgeRef(ref, 12);
   expect(encoded.key).toBe(`${repo}#12`);
   expect(encoded.journalKey).toBe(`${repo}:12`);
   expect(decodeForgeKey(encoded.key)).toEqual({ repo, forgeRef: ref, iid: "12" });
   expect(encoded.fileStem).not.toMatch(/[/:#]/);
   expect(basename(workerLogFile("/tmp/state.sqlite", repo, "12", 2))).toBe(`${encoded.fileStem}-g2.log`);
   return encoded.fileStem;
  });
  expect(new Set(stems).size).toBe(refs.length);
  for (const key of [`${gitlab}#12#13`, `${gitlab}#oops`, "gitlab:host#12"]) expect(() => decodeForgeKey(key)).toThrow();
 });

 test("located node ids must match the complete project", () => {
  const ref = parseForgeRef(gitlab);
  expect(normalizeNodeId(ref, "claw/crisis-simulator#12")).toBe("12");
  expect(normalizeNodeId(ref, "12")).toBe("12");
  expect(normalizeNodeId(parseForgeRef("gitlab:host/a/b/c"), "a/b/c#12")).toBe("12");
  for (const id of ["other/crisis-simulator#12", "crisis-simulator#12", "claw/crisis-simulator#12#13", "abc", "12junk", "12\n"])
   expect(() => normalizeNodeId(ref, id)).toThrow();
 });

 test("serve action argv guards accept qualified refs and refuse malformed map keys", () => {
  const key = `${gitlab}#12`;
  expect(buildNowArgv({ bin: "ranger", key, nodeId: "13", configPath: "/tmp/ranger.yaml" })).toEqual([
   "ranger", "build-now", "13", "--map", key, "--force", "--config", "/tmp/ranger.yaml",
  ]);
  expect(resumeArgv({ rangerBin: "ranger", repo: gitlab, root: 12, nodeId: "13", configPath: "/tmp/ranger.yaml", force: false })).toContain(key);
  expect(launchPlan({ repo: gitlab, root: 12, nodeId: "13", cwd: "/tmp" }).prompt).toContain(gitlab);
  expect(() => buildNowArgv({ bin: "ranger", key: `${key}#14`, nodeId: "13", configPath: "/tmp/ranger.yaml" })).toThrow();
  expect(() => mergeArgv({ repo: gitlab, pr: 12, sha: "a".repeat(40) })).toThrow("GitLab merge is not implemented");
 });

 test("journal and cache builders read existing GitHub keys and isolate qualified hosts", () => {
  const journal = new Journal(":memory:");
  try {
   for (const repo of ["acme/widgets", gitlab, "gitlab:other.host/claw/crisis-simulator"]) {
    const ref = parseForgeRef(repo);
    // These rows use literal pre-existing keys, independent of the encoder.
    journal.upsertEscalation({ key: `${repo}:12`, repo, root: 1, nodeId: "12", messageId: repo, createdAt: "2026-10-07" });
    journal.upsertWorker({ repo, root: 1, nodeId: "12", status: "claimed" });
    const frontier = { repo, root: "1", frontier: [] };
    journal.setHealth(`frontier:${repo}#1`, JSON.stringify({ sentinel: "old", fetchedAt: repo, frontier }));
    expect(journal.getEscalation(repo, "12")?.key).toBe(encodeForgeRef(ref, 12).journalKey);
    expect(journal.getEscalation(repo, "12")?.messageId).toBe(repo);
    expect(journal.getWorker("12", repo)?.repo).toBe(repo);
    expect(cachedFrontier(journal, repo, 1)).toEqual({ fetchedAt: repo, frontier });
   }
  } finally { journal.close(); }
 });

 test("soma boundary sends qualified repo unchanged and normalizes every returned located id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-forge-graph-"));
  const fixture = join(dir, "responses.json");
  const calls = join(dir, "calls.jsonl");
  const locate = (id: string) => `claw/crisis-simulator#${id}`;
  const node: FrontierEntry = {
   ref: { id: locate("12") }, node: { id: locate("12"), title: "Build", kind: "task", autonomy: "auto" },
   status: "open", assignees: [], blockedBy: [{ id: locate("11"), status: "closed" }],
   author: "bot", url: "https://example.test", typed: true, parent: { id: locate("1") },
  };
  const responses = {
   frontier: { repo: gitlab, root: locate("1"), frontier: [node] },
   node: { repo: gitlab, ...node },
   audit: { repo: gitlab, root: locate("1"), nodes: 4, closedWithoutReceipt: [locate("9")], openWithoutCheckpoint: [locate("10")], openClaimed: [{ id: locate("12"), assignees: ["bot"] }] },
   claim: { repo: gitlab, node: locate("12"), held: true, assignees: ["bot"] },
   release: { repo: gitlab, node: locate("12"), released: true, assignees: [] },
  };
  writeFileSync(fixture, JSON.stringify(responses));
  // A local executable fixture only: no forge network or credentials.
  writeFileSync(join(dir, "soma"), `#!${process.execPath}\n` +
   `import { appendFileSync, readFileSync } from "node:fs";\n` +
   `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
   `console.log(JSON.stringify(JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf8"))[process.argv[3]]));\n`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
   const token = { token: "fixture-read-only", source: "fixture" };
   const frontier = await graphFrontier(gitlab, 1, token);
   expect(frontier.root).toBe("1");
   expect(frontier.frontier[0].ref.id).toBe("12");
   expect(frontier.frontier[0].node.id).toBe("12");
   expect(frontier.frontier[0].blockedBy[0].id).toBe("11");
   expect(frontier.frontier[0].parent?.id).toBe("1");
   expect((await graphNode(gitlab, locate("12"), token)).node.id).toBe("12");
   expect(await graphAudit(gitlab, 1, token)).toEqual({ ...responses.audit, root: "1", closedWithoutReceipt: ["9"], openWithoutCheckpoint: ["10"], openClaimed: [{ id: "12", assignees: ["bot"] }] });
   expect((await graphClaim(gitlab, "12", "bot", "fixture-write")).node).toBe("12");
   expect((await graphRelease(gitlab, "12", "bot", "fixture-write")).node).toBe("12");
   const argv = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
   expect(argv).toHaveLength(5);
   for (const args of argv) expect(args[args.indexOf("--repo") + 1]).toBe(gitlab);
   expect(argv[1][2]).toBe("12");
   responses.node.node.id = "other/project#12";
   writeFileSync(fixture, JSON.stringify(responses));
   await expect(graphNode(gitlab, "12", token)).rejects.toThrow("different project");
   responses.node.node.id = locate("12");
   responses.frontier.frontier[0].parent = { id: "other/project#1" };
   writeFileSync(fixture, JSON.stringify(responses));
   await expect(graphFrontier(gitlab, 1, token)).rejects.toThrow("different project");
   responses.claim.node = "other/project#12";
   writeFileSync(fixture, JSON.stringify(responses));
   await expect(graphClaim(gitlab, "12", "bot", "fixture-write")).rejects.toThrow("different project");
  } finally {
   if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

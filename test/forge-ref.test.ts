import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { parseForgeRef, encodeForgeRef, decodeForgeKey, normalizeNodeId, executionRefusal } from "../src/forge-ref.ts";
import { graphFrontier, graphNode, graphAudit, somaRepo, normalizeGraphNode, type FrontierEntry } from "../src/graph.ts";
import { graphClaim, graphRelease, GraphWriteError } from "../src/graph-write.ts";
import { walk, claimNode } from "../src/walk.ts";
import { runNode } from "../src/worker.ts";
import { runImplement, type ImplementContext } from "../src/implement.ts";
import { buildNow } from "../src/build-now.ts";
import { sweepMap } from "../src/sweep.ts";
import { mapKey } from "../src/maps.ts";
import { workerLogFile } from "../src/worker-log.ts";
import { buildNowArgv, launchPlan, ServeReader, servedMaps, readPrLive, assertReadOnlyTokens } from "../src/serve.ts";
import { resumeArgv, mergeArgv } from "../src/serve-parked.ts";
import { frontierCacheKey, cachedFrontier, readRepoSentinel } from "../src/frontier-cache.ts";
import { Journal } from "../src/journal.ts";
import { runCli } from "./support.ts";
import { assertReadOnlyToken } from "../src/token-gate.ts";

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
   ["the-metafactory/ranger", 91, "the-metafactory__ranger"],
   ["the-metafactory/ranger", 133, "the-metafactory__ranger"],
   ["jcfischer/seekolous", 26, "jcfischer__seekolous"],
   ["jcfischer/seelite", 1, "jcfischer__seelite"],
   ["jcfischer/seelite", 460, "jcfischer__seelite"],
   ["the-metafactory/soma", 604, "the-metafactory__soma"],
   ["the-metafactory/soma", 645, "the-metafactory__soma"],
   ["the-metafactory/soma", 565, "the-metafactory__soma"],
   ["the-metafactory/soma", 706, "the-metafactory__soma"],
   ["the-metafactory/soma", 533, "the-metafactory__soma"],
   ["the-metafactory/soma", 751, "the-metafactory__soma"],
   ["the-metafactory/soma", 766, "the-metafactory__soma"],
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
  expect(configWith("github:github.com/acme/widgets", "legacy").state.legacyMapRoots).toEqual({ "acme/widgets": 12 });
  expect(encodeForgeRef(parseForgeRef("acme/widgets"), "<@123>").journalKey).toBe("acme/widgets:<@123>");
  expect(() => decodeForgeKey("acme/widgets#<@123>")).toThrow();
  expect(encodeForgeRef(parseForgeRef("github:github.com/acme/widgets"), 12)).toEqual({
   key: "acme/widgets#12", journalKey: "acme/widgets:12", cacheKey: "frontier:acme/widgets#12", fileStem: "acme__widgets-12",
  });
 });

 test("GitHub graph ids retain every byte in arguments, graph results and persisted encodings", () => {
  const ref = parseForgeRef("acme/widgets");
  for (const id of ["12", "acme/widgets#12", "other/project#12", "<@123>", "display#text"]) {
   expect(normalizeNodeId(ref, id)).toBe(id);
   const encoded = encodeForgeRef(ref, id);
   expect(encoded).toEqual({ key: `acme/widgets#${id}`, journalKey: `acme/widgets:${id}`,
    cacheKey: `frontier:acme/widgets#${id}`, fileStem: `acme__widgets-${id}` });
   const node = { ref: { id }, node: { id, title: "Build", kind: "task", autonomy: "auto" },
    status: "open", assignees: [], blockedBy: [{ id, status: "open" }], parent: { id },
    author: "bot", url: "https://example.test", typed: true };
   expect(normalizeGraphNode("acme/widgets", node)).toEqual(node);
  }
 });

 test("parse memo evicts old strings without changing identities or encodings", () => {
  const old = parseForgeRef("memo/project");
  for (let i = 0; i < 300; i++) parseForgeRef(`memo/project-${i}`);
  const fresh = parseForgeRef("memo/project");
  expect(fresh).not.toBe(old);
  expect(fresh).toEqual(old);
  expect(encodeForgeRef(fresh, 12)).toEqual(encodeForgeRef(old, 12));
 });

 test("GitLab encodings distinguish host and project, round-trip keys and make safe filenames", () => {
  const refs = [gitlab, "gitlab:other.host/claw/crisis-simulator", "gitlab:host/a/b/c", "gitlab:host/a__b/c"];
  const stems = refs.map(repo => {
   const ref = parseForgeRef(repo);
   const encoded = encodeForgeRef(ref, 12);
   expect(encoded.key).toBe(`${repo}#12`);
   expect(encoded.journalKey).toBe(`${repo}#12`);
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
  // Node #132: the principal's tap merge on GitLab is glab's merge endpoint, squashed and pinned.
  expect(mergeArgv({ repo: gitlab, pr: 12, sha: "a".repeat(40) })).toEqual([
   "glab", "api", "--hostname", "gitlab.software.geant.org", "-X", "PUT",
   "projects/claw%2Fcrisis-simulator/merge_requests/12/merge", "-f", "squash=true", "-f", `sha=${"a".repeat(40)}`,
  ]);
 });

 test("registered GitLab maps refuse all execution entry points before calls or journal writes", async () => {
  const config = configWith(gitlab);
  const map = config.maps[0];
  map.walk = "full";
  map.commands.test = "bun test";
  const journal = new Journal(":memory:");
  let calls = 0;
  const forbidden = async (): Promise<never> => { calls++; throw new Error("unexpected side effect"); };
  const node = { repo: gitlab, ref: { id: "12" }, node: { id: "12", title: "Build", kind: "task", autonomy: "auto" },
   status: "open", assignees: [], blockedBy: [], author: "bot", url: "https://example.test", typed: true };
  const base = { config, journal, map, token: "fixture", botIdentity: "bot" };
  try {
   expect(executionRefusal("acme/widgets")).toBeNull();
   const result = await walk({ config, journal, configPath: "/unused", spawnRunNode: forbidden });
   expect(result.maps[0]).toMatchObject({ gated: true, claimed: [], announced: [] });
   expect(result.maps[0].gateReason).toContain("GitLab execution is not implemented");
   expect(await claimNode({ ...base, node: node.node, lane: "implement", cliEntry: "/unused", configPath: "/unused",
    announce: forbidden, claim: forbidden, spawnRunNode: forbidden })).toMatchObject({ claimed: false });
   await expect(buildNow("12", { ...base, configPath: "/unused", readFrontier: forbidden, announce: forbidden, claim: forbidden,
    spawnRunNode: forbidden })).rejects.toThrow("GitLab execution is not implemented");
   expect(await runNode("12", { ...base })).toMatchObject({ status: "refused" });
   const github = new Proxy({}, { get: () => forbidden }) as ImplementContext["github"];
   expect(await runImplement({ ...base, node, rootNode: node, github, readOnlyToken: "fixture", canonical: "/unused",
    worktree: "/unused", branch: "node/12-test", generation: 1, ratify: "auto", sessionJournal: "/unused",
    workerRun: forbidden, shellRun: forbidden })).toMatchObject({ status: "refused" });
   await expect(sweepMap({ ...base, respawn: forbidden })).rejects.toThrow("GitLab execution is not implemented");
   expect(await readRepoSentinel(gitlab, "fixture")).toBeNull();
   expect(calls).toBe(0);
   expect(journal.listWorkers()).toEqual([]);
   expect(journal.listEvents()).toEqual([]);
  } finally { journal.close(); }
 });

 test("CLI refuses GitLab reads without a mapped credential and keeps execution gated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-forge-gates-"));
  const path = join(dir, "ranger.yaml");
  const calls = join(dir, "calls");
  writeFileSync(path, `maps:\n  - repo: ${gitlab}\n    root: 12\n    walk: full\nstate:\n  journalPath: ${join(dir, "state.sqlite")}\n`);
  for (const bin of ["gh", "glab", "soma", "git"]) writeFileSync(join(dir, bin), `#!/bin/sh\nprintf unexpected >> "${calls}"\nexit 90\n`, { mode: 0o700 });
  try {
   for (const args of [["scout", "--json"], ["walk"], ["build-now", "13", "--map", `${gitlab}#12`],
    ["run-node", "13", "--map", `${gitlab}#12`], ["sweep"], ["escalate", "--json"], ["escalate", "--digest", "--json"]]) {
    const result = await runCli([...args, "--config", path], { ...process.env, PATH: `${dir}:${process.env.PATH}` });
    expect(result.stdout + result.stderr).toContain(["scout", "escalate"].includes(args[0]) ? "no read-only token mapping" : "not implemented");
   }
   expect(() => readFileSync(calls)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
 });

 test("serve-only GitLab graph reads require credentials; MR reads ask the read gate first", async () => {
  const config = configWith(gitlab, "serve");
  const maps = servedMaps(config).filter(map => map.repo === gitlab);
  expect(maps).toHaveLength(1);
  expect(() => assertReadOnlyTokens(config, maps, {})).toThrow("no read-only token mapping");
  let calls = 0;
  const tokens = async (): Promise<never> => { calls++; throw new Error("unexpected credentials"); };
  // Node #132: an MR read goes through the read gate, which refuses here before any read.
  await expect(readPrLive(config, gitlab, 12, tokens)).rejects.toThrow("unexpected credentials");
  expect(calls).toBe(1);
  calls = 0;
  const reader = new ServeReader(config, maps, "/unused");
  reader.refresh();
  // Await this refresh before the headless test returns.
  while (reader.refreshing) await Bun.sleep(1);
  expect(reader.extra.get(maps[0].key)?.error).toContain("no read-only token mapping");
  expect(calls).toBe(0);
 });

 test("journal and cache builders read existing GitHub keys and isolate qualified hosts", () => {
  const journal = new Journal(":memory:");
  try {
   for (const repo of ["acme/widgets", gitlab, "gitlab:other.host/claw/crisis-simulator"]) {
    const ref = parseForgeRef(repo);
    // GitHub's key is literal pre-existing data, independent of the encoder.
    const key = repo === "acme/widgets" ? "acme/widgets:12" : `${repo}#12`;
    journal.upsertEscalation({ key, repo, root: 1, nodeId: "12", messageId: repo, createdAt: "2026-10-07" });
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
   const { token } = await assertReadOnlyToken({ auth: { readOnlyTokens: { "gitlab:gitlab.software.geant.org/claw/": "fixture" } } } as unknown as import("../src/config.ts").RangerConfig,
    gitlab, { fixture: "fixture-read-only" }, async () => ({ code: 0, stdout: 'HTTP/2.0 200 OK\n\n{"scopes":["read_api"]}', stderr: "" }));
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
   const githubId = "acme/widgets#12";
   responses.node.node.id = githubId;
   responses.claim.node = githubId;
   writeFileSync(fixture, JSON.stringify(responses));
   expect((await graphNode("acme/widgets", githubId, token)).node.id).toBe(githubId);
   expect((await graphClaim("acme/widgets", githubId, "bot", "fixture-write")).node).toBe(githubId);
   const githubCalls = readFileSync(calls, "utf8").trim().split("\n").slice(-2).map(line => JSON.parse(line) as string[]);
   for (const args of githubCalls) {
    expect(args[2]).toBe(githubId);
    expect(args[args.indexOf("--repo") + 1]).toBe("github:github.com/acme/widgets");
   }
   responses.node.node.id = "other/project#12";
   writeFileSync(fixture, JSON.stringify(responses));
   await expect(graphNode(gitlab, "12", token)).rejects.toThrow("different project");
   responses.node.node.id = locate("12");
   responses.frontier.frontier[0].parent = { id: "other/project#1" };
   writeFileSync(fixture, JSON.stringify(responses));
   responses.frontier.frontier[0].blockedBy = [{ id: "other/project#11", status: "open" }];
   writeFileSync(fixture, JSON.stringify(responses));
   const foreign = (await graphFrontier(gitlab, 1, token)).frontier[0];
   expect(foreign.parent?.id).toBe("other/project#1");
   expect(foreign.blockedBy[0]).toEqual({ id: "other/project#11", status: "open" });
   responses.claim.node = "other/project#12";
   writeFileSync(fixture, JSON.stringify(responses));
   await expect(graphClaim(gitlab, "12", "bot", "fixture-write")).rejects.toThrow("different project");
   await expect(graphClaim(gitlab, "12", "bot", "fixture-write")).rejects.toBeInstanceOf(GraphWriteError);
   responses.release.node = "other/project#12";
   writeFileSync(fixture, JSON.stringify(responses));
   await expect(graphRelease(gitlab, "12", "bot", "fixture-write")).rejects.toBeInstanceOf(GraphWriteError);
   await expect(graphClaim(gitlab, "other/project#12", "bot", "fixture-write")).rejects.toBeInstanceOf(GraphWriteError);
   // Exercise the exit-1 race path with missing/non-string nodes too.
   writeFileSync(join(dir, "soma"), `#!${process.execPath}\n` +
    `import { readFileSync } from "node:fs";\n` +
    `console.error(readFileSync(${JSON.stringify(fixture)}, "utf8")); process.exit(1);\n`, { mode: 0o700 });
   for (const node of [undefined, null, 12, "other/project#12", "claw/crisis-simulator#oops"]) {
    writeFileSync(fixture, JSON.stringify({ repo: gitlab, held: false, node, assignees: [] }));
    await expect(graphClaim(gitlab, "12", "bot", "fixture-write")).rejects.toBeInstanceOf(GraphWriteError);
   }
   writeFileSync(fixture, JSON.stringify({ repo: gitlab, held: false, node: locate("12"), assignees: [] }));
   expect((await graphClaim(gitlab, "12", "bot", "fixture-write"))).toMatchObject({ held: false, node: "12" });
  } finally {
   if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
   rmSync(dir, { recursive: true, force: true });
  }
 }, 30_000);
});

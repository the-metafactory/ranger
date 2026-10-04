import { describe, expect, test } from "bun:test";
import { readFileSync as read, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { implementLane, workerLane } from "../src/lanes.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { openJournal } from "../src/journal.ts";
import { runMergeDesk } from "../src/merge-desk.ts";
import { realGitHub, type GitHubPort } from "../src/implement.ts";
import type { PullRequest } from "../src/github.ts";
import { servedMaps, ServeReader, stateFromJournal } from "../src/serve.ts";
import { fakeDiscord, fixturesBin, runCli } from "./support.ts";

const GAME = "acme/seelite";
const TOOL = "acme/ranger";
const SECOND_GAME = "acme/other-game";

function rig(cap = 10) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-lanes-"));
 const discord = fakeDiscord();
 const configPath = join(dir, "ranger.yaml");
 const raw = {
  version: 1,
  maps: [GAME, TOOL, SECOND_GAME].map((repo) => ({
   repo, root: 1, walk: "full",
   commands: { test: "bun test", ...(repo === TOOL ? {} : { probe: "npm run probe:gpu" }) },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  })),
  bot: { identity: "ivy-bot" },
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
  state: { journalPath: join(dir, "state.sqlite") },
  workers: { spawnCapPerDay: cap },
 };
 writeFileSync(configPath, stringify(raw));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 const data = join(dir, "data");
 mkdirSync(data);
 for (const [i, repo] of [GAME, TOOL, SECOND_GAME].entries()) {
  writeFileSync(join(data, repo.replace("/", "__") + "-frontier.json"), JSON.stringify({
   repo, root: "1", frontier: [0, 1].map((offset) => {
    const id = String((i + 1) * 10 + offset);
    return {
     ref: { id }, node: { id, title: `Build ${id}`, kind: "task", autonomy: "auto", probes: [] },
     status: "open", assignees: [], blockedBy: [], author: "alice", typed: true,
     url: `https://github.com/${repo}/issues/${id}`,
    };
   }),
  }));
 }
 const state = join(dir, "state.json");
 writeFileSync(state, JSON.stringify({ nodes: {}, decisions: [] }));
 const env = {
  ...process.env,
  PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
  FAKE_SOMA_DIR: data, FAKE_SOMA_STATE: state,
  RANGER_WRITE_TEST: "ghp_write", RANGER_NO_SPAWN: "1",
  RANGER_DISCORD_TOKEN: "fake-bot-token",
  RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`,
  RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1", RANGER_DISCORD_MIN_INTERVAL_MS: "5",
 };
 return { config, configPath, journal, env, raw, data, close() {
  journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true });
 } };
}

describe("node #57/#47 — root-aware resource lanes", () => {
 test("probe defaults, explicit overrides and schema validation", () => {
  const r = rig();
  try {
   const [game, tool] = r.config.maps;
   expect(implementLane(game)).toBe("visual");
   expect(implementLane(tool)).toBe("headless");
   expect(implementLane({ ...tool, lane: "visual" })).toBe("visual");
   expect(implementLane({ ...game, lane: "headless" })).toBe("headless");
   for (const lane of ["visual", "headless", "invalid"] as const) {
    writeFileSync(r.configPath, stringify({ ...r.raw, maps: [{ ...r.raw.maps[0], lane }] }));
    if (lane === "invalid") expect(() => loadConfig(r.configPath)).toThrow(ConfigError);
    else expect(loadConfig(r.configPath).config.maps[0].lane).toBe(lane);
   }
  } finally { r.close(); }
 });

 test("same-repo roots resolve distinct resource overrides and holders", () => {
  const r = rig();
  try {
   const game = r.config.maps[0];
   const sibling = { ...game, root: 460, lane: "headless" as const };
   r.config.maps.push(sibling);
   const journal = openJournal(r.config);
   try {
    expect(workerLane({ repo: GAME, root: 1 }, r.config.maps)).toBe("visual");
    expect(workerLane({ repo: GAME, root: 460 }, r.config.maps)).toBe("headless");
    journal.upsertWorker({ nodeId: "90", repo: GAME, root: 1, lane: "implement", status: "running" });
    journal.upsertWorker({ nodeId: "91", repo: GAME, root: 460, lane: "implement", status: "running" });
    expect(journal.laneHolder("visual")?.root).toBe(1);
    expect(journal.laneHolder("headless")?.root).toBe(460);
   } finally { journal.close(); }
  } finally { r.close(); }
 });

 test("independent holders; exclusion uses repo and id", () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ root: 1, nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   r.journal.upsertWorker({ root: 1, nodeId: "90", repo: TOOL, status: "claimed", lane: "implement" });
   expect(r.journal.laneHolder("visual")?.repo).toBe(GAME);
   expect(r.journal.laneHolder("headless", { nodeId: "90", repo: GAME })?.repo).toBe(TOOL);
   r.journal.updateWorker("90", GAME, { status: "awaiting-merge" });
   expect(r.journal.laneHolder("visual")).toBeNull();
   expect(r.journal.laneHolder("headless")?.repo).toBe(TOOL);
   r.journal.updateWorker("90", TOOL, { lane: "research" });
   expect(r.journal.laneHolder("headless")).toBeNull();
  } finally { r.close(); }
 });

 for (const occupied of [false, true]) {
  test(`walk claims one per resource lane (visual occupied=${occupied})`, async () => {
   const r = rig();
   try {
    if (occupied) r.journal.upsertWorker({ root: 1, nodeId: "90", repo: GAME, status: "running", lane: "implement" });
    const out = await runCli(["walk", "-c", r.configPath], r.env);
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result.maps.map((m: { claimed: string[] }) => m.claimed)).toEqual(occupied ? [[], ["20"], []] : [["10"], ["20"], []]);
    expect(r.journal.spawnsToday()).toBe(occupied ? 1 : 2);
   } finally { r.close(); }
  });
 }

 test("the daily spawn cap bounds visual and headless implement claims together", async () => {
  const r = rig(1);
  try {
   const out = await runCli(["walk", "-c", r.configPath], r.env);
   expect(out.code).toBe(0);
   const result = JSON.parse(out.stdout);
   expect(result.maps.map((m: { claimed: string[] }) => m.claimed)).toEqual([["10"], [], []]);
   expect(result.maps[1].spawnCapExhausted).toBe(true);
   expect(r.journal.spawnsToday()).toBe(1);
   expect(r.journal.getWorker("20", TOOL)).toBeNull();
  } finally { r.close(); }
 });

 test("the daily spawn cap blocks research independently of implement capacity", async () => {
  const r = rig(1);
  try {
   const path = join(r.data, TOOL.replace("/", "__") + "-frontier.json");
   const fixture = JSON.parse(read(path, "utf8"));
   fixture.frontier[0].node.kind = "research";
   writeFileSync(path, JSON.stringify(fixture));
   const out = await runCli(["walk", "-c", r.configPath], r.env);
   expect(out.code).toBe(0);
   const result = JSON.parse(out.stdout);
   expect(result.maps.map((m: { claimed: string[] }) => m.claimed)).toEqual([["10"], [], []]);
   expect(result.maps[1].spawnCapExhausted).toBe(true);
   expect(r.journal.spawnsToday()).toBe(1);
  } finally { r.close(); }
 });

 test("pause prevents claims on every map", async () => {
  const r = rig();
  try {
   r.journal.setPaused(true);
   const out = await runCli(["walk", "-c", r.configPath], r.env);
   expect(out.code).toBe(0);
   expect(JSON.parse(out.stdout).maps.every((m: { claimed: string[]; gated: boolean }) => m.gated && m.claimed.length === 0)).toBe(true);
   expect(r.journal.spawnsToday()).toBe(0);
  } finally { r.close(); }
 });

 test("resume enforces resource capacity; explicit force and research behavior remain", async () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ root: 1, nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   for (const [id, repo, lane] of [["20", TOOL, "implement"], ["30", SECOND_GAME, "implement"], ["31", SECOND_GAME, "research"]]) {
    r.journal.upsertWorker({ root: 1, nodeId: id, repo, status: "parked", lane });
    const out = await runCli(["resume-node", id, "--map", repo, "-c", r.configPath], r.env);
    if (id === "30") {
     expect(out.code).toBe(1);
     expect(out.stderr).toMatch(/implement lane.*#90/);
     expect(r.journal.getWorker(id, repo)?.status).toBe("parked");
     expect((await runCli(["resume-node", id, "--map", repo, "--force", "-c", r.configPath], r.env)).code).toBe(0);
    } else {
     expect(out.code).toBe(0);
    }
    expect(r.journal.getWorker(id, repo)?.status).toBe("claimed");
   }
   r.journal.upsertWorker({ root: 1, nodeId: "21", repo: TOOL, status: "parked", lane: "implement" });
   const blocked = await runCli(["resume-node", "21", "--map", TOOL, "-c", r.configPath], r.env);
   expect(blocked.code).toBe(1);
   expect(blocked.stderr).toMatch(/headless implement lane.*#20.*acme\/ranger#1/);
   expect(r.journal.getWorker("21", TOOL)?.status).toBe("parked");
   expect((await runCli(["resume-node", "20", "--map", TOOL, "-c", r.configPath], r.env)).code).toBe(0);
  } finally { r.close(); }
 });

 test("node #58: build-now claims one node through the CLI; a held lane needs --force", async () => {
  const r = rig();
  try {
   const first = await runCli(["build-now", "20", "--map", `${TOOL}#1`, "-c", r.configPath], r.env);
   expect(first.code).toBe(0);
   expect(JSON.parse(first.stdout)).toMatchObject({ nodeId: "20", lane: "implement", beside: null });
   expect(r.journal.getWorker("20", TOOL)).toMatchObject({ status: "claimed", lane: "implement" });
   expect(r.journal.spawnsToday()).toBe(1);
   const held = await runCli(["build-now", "21", "--map", TOOL, "-c", r.configPath], r.env);
   expect(held.code).toBe(1);
   expect(held.stderr).toMatch(/headless implement lane is held by #20.*--force/);
   expect(r.journal.getWorker("21", TOOL)).toBeNull();
   const beside = await runCli(["build-now", "21", "--map", TOOL, "--force", "-c", r.configPath], r.env);
   expect(beside.code).toBe(0);
   expect(JSON.parse(beside.stdout).beside).toMatchObject({ nodeId: "20" });
   const off = await runCli(["build-now", "99", "--map", TOOL, "-c", r.configPath], r.env);
   expect(off.code).toBe(1);
   expect(off.stderr).toMatch(/not on the map's frontier/);
  } finally { r.close(); }
 });

 test("merge desk waits only for the map's resource capacity", async () => {
  const r = rig();
  try {
   const head = "a".repeat(40);
   const github: GitHubPort = {
    ...realGitHub,
    getPr: async (_repo, number) => ({ number, state: "open", merged: false, headSha: head, url: "" } as PullRequest),
    listComments: async () => [{ id: 1, author: "ivy-bot", body: `<!-- ranger:review round=1 sha=${head} blockers=1 majors=0 nits=0 -->` }],
   };
   r.journal.upsertWorker({ root: 1, nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   const spawned: string[] = [];
   const posts: string[] = [];
   const desk = (index: number) => runMergeDesk({
    config: r.config, map: r.config.maps[index], journal: r.journal,
    token: "unused", botIdentity: "ivy-bot", github,
    post: async (content) => { posts.push(content); return "new-card"; },
    spawn: async (id) => { spawned.push(id); return 123; },
   });
   for (const [id, repo] of [["20", TOOL], ["21", TOOL], ["30", SECOND_GAME]]) {
    r.journal.upsertWorker({ root: 1, nodeId: id, repo, status: "awaiting-merge", lane: "implement", prNumber: Number(id), mergeMessageId: "old-card" });
   }
   expect(await desk(1)).toMatchObject({ resumed: ["20"], pending: ["21"], errors: [] });
   expect(await desk(2)).toMatchObject({ resumed: [], pending: ["30"], errors: [] });
   expect(spawned).toEqual(["20"]);
   expect(posts).toHaveLength(3);
   r.journal.updateWorker("90", GAME, { status: "success" });
   expect(await desk(2)).toMatchObject({ resumed: ["30"], pending: [], errors: [] });
   expect(spawned).toEqual(["20", "30"]);
   expect(posts).toHaveLength(3);
  } finally { r.close(); }
 });

 test("read-only dashboard reads both resource holders", () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ root: 1, nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   r.journal.upsertWorker({ root: 1, nodeId: "91", repo: TOOL, status: "claimed", lane: "implement" });
   const reader = new ServeReader(r.config, servedMaps(r.config), r.config.state.journalPath);
   const state = stateFromJournal(r.config, servedMaps(r.config), reader);
   expect(state.gates.laneHolders.visual).toMatchObject({ nodeId: "90", repo: GAME });
   expect(state.gates.laneHolders.headless).toMatchObject({ nodeId: "91", repo: TOOL });
   expect(state.current.map((j) => j.resourceLane)).toEqual(["visual", "headless"]);
  } finally { r.close(); }
 });
});

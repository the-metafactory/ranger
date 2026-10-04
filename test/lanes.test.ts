import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { ConfigError, loadConfig } from "../src/config.ts";
import { openJournal } from "../src/journal.ts";
import { implementLane, workerLane } from "../src/lanes.ts";
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
 return { config, configPath, journal, env, raw, close() {
  journal.close(); discord.stop(); rmSync(dir, { recursive: true, force: true });
 } };
}

describe("node #57 — resource lanes", () => {
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

 test("legacy rows resolve at read time; only claimed/running implement workers hold lanes", () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   r.journal.upsertWorker({ nodeId: "91", repo: TOOL, status: "claimed", lane: "implement" });
   expect(r.journal.laneHolder("visual")?.nodeId).toBe("90");
   expect(r.journal.laneHolder("headless")?.nodeId).toBe("91");
   expect(r.journal.laneHolder("visual", "90")).toBeNull();
   r.config.maps[0].lane = "headless";
   expect(r.journal.laneHolder("visual")).toBeNull();
   expect(r.journal.laneHolder("headless")?.nodeId).toBe("90");
   for (const status of ["awaiting-merge", "parked", "success", "failed", "released"] as const) {
    r.journal.updateWorker("90", { status });
    expect(r.journal.laneHolder("headless")?.nodeId).toBe("91");
   }
   r.journal.updateWorker("91", { lane: "research" });
   expect(r.journal.laneHolder("headless")).toBeNull();
   r.journal.upsertWorker({ nodeId: "92", repo: "removed/map", status: "running", lane: "implement" });
   expect(r.journal.laneHolder("visual")?.nodeId).toBe("92");
   expect(r.journal.laneHolder("headless")?.nodeId).toBe("92");
  } finally { r.close(); }
 });

 test("same-repo maps share a lane; roots distinguish explicit overrides when available", () => {
  const r = rig();
  try {
   const game = r.config.maps[0];
   const sibling = { ...game, root: 2 };
   expect(workerLane({ repo: GAME }, [game, sibling])).toBe("visual");
   sibling.lane = "headless";
   expect(workerLane({ repo: GAME }, [game, sibling])).toBeNull();
   expect(workerLane({ repo: GAME, root: 2 }, [game, sibling])).toBe("headless");
  } finally { r.close(); }
 });

 for (const occupied of [false, true]) {
  test(`walk claims at most one per free lane in a tick (visual occupied=${occupied})`, async () => {
   const r = rig();
   try {
    if (occupied) r.journal.upsertWorker({ nodeId: "90", repo: GAME, status: "running", lane: "implement" });
    const out = await runCli(["walk", "-c", r.configPath], r.env);
    expect(out.code).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result.maps.map((m: { claimed: string[] }) => m.claimed)).toEqual(occupied ? [[], ["20"], []] : [["10"], ["20"], []]);
    expect(r.journal.spawnsToday()).toBe(occupied ? 1 : 2);
   } finally { r.close(); }
  });
 }

 test("the daily spawn cap bounds both lanes together", async () => {
  const r = rig(1);
  try {
   const out = await runCli(["walk", "-c", r.configPath], r.env);
   expect(out.code).toBe(0);
   const result = JSON.parse(out.stdout);
   expect(result.maps.map((m: { claimed: string[] }) => m.claimed)).toEqual([["10"], [], []]);
   expect(result.maps[1].spawnCapExhausted).toBe(true);
   expect(r.journal.spawnsToday()).toBe(1);
  } finally { r.close(); }
 });

 test("pause prevents claims in both lanes", async () => {
  const r = rig();
  try {
   r.journal.setPaused(true);
   const out = await runCli(["walk", "-c", r.configPath], r.env);
   expect(out.code).toBe(0);
   expect(JSON.parse(out.stdout).maps.every((m: { claimed: string[]; gated: boolean }) => m.gated && m.claimed.length === 0)).toBe(true);
   expect(r.journal.spawnsToday()).toBe(0);
  } finally { r.close(); }
 });

 test("resume refuses only the asking node's lane; force and research behavior remain", async () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   for (const [id, repo, lane] of [["20", TOOL, "implement"], ["30", SECOND_GAME, "implement"], ["31", SECOND_GAME, "research"]]) {
    r.journal.upsertWorker({ nodeId: id, repo, status: "parked", lane });
    const out = await runCli(["resume-node", id, "--map", repo, "-c", r.configPath], r.env);
    if (id === "30") {
     expect(out.code).toBe(1);
     expect(out.stderr).toMatch(/visual implement lane.*#90/);
     expect(r.journal.getWorker(id)?.status).toBe("parked");
     expect((await runCli(["resume-node", id, "--map", repo, "--force", "-c", r.configPath], r.env)).code).toBe(0);
    } else {
     expect(out.code).toBe(0);
    }
    expect(r.journal.getWorker(id)?.status).toBe("claimed");
   }
   r.journal.upsertWorker({ nodeId: "21", repo: TOOL, status: "parked", lane: "implement" });
   const blocked = await runCli(["resume-node", "21", "--map", TOOL, "-c", r.configPath], r.env);
   expect(blocked.code).toBe(1);
   expect(blocked.stderr).toMatch(/headless implement lane.*#20/);
   expect(r.journal.getWorker("21")?.status).toBe("parked");
   expect((await runCli(["resume-node", "20", "--map", TOOL, "-c", r.configPath], r.env)).code).toBe(0);
  } finally { r.close(); }
 });

 test("merge desk resumes rework beside another lane, then waits on its own lane", async () => {
  const r = rig();
  try {
   const head = "a".repeat(40);
   const github: GitHubPort = {
    ...realGitHub,
    getPr: async (_repo, number) => ({ number, state: "open", merged: false, headSha: head, url: "" } as PullRequest),
    listComments: async () => [{ id: 1, author: "ivy-bot", body: `<!-- ranger:review round=1 sha=${head} blockers=1 majors=0 nits=0 -->` }],
   };
   r.journal.upsertWorker({ nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   const spawned: string[] = [];
   const posts: string[] = [];
   const desk = (index: number) => runMergeDesk({
    config: r.config, map: r.config.maps[index], journal: r.journal,
    token: "unused", botIdentity: "ivy-bot", github,
    post: async (content) => { posts.push(content); return "new-card"; },
    spawn: async (id) => { spawned.push(id); return 123; },
   });
   for (const [id, repo] of [["20", TOOL], ["21", TOOL], ["30", SECOND_GAME]]) {
    r.journal.upsertWorker({ nodeId: id, repo, status: "awaiting-merge", lane: "implement", prNumber: Number(id), mergeMessageId: "old-card" });
   }
   expect(await desk(1)).toMatchObject({ resumed: ["20"], pending: ["21"], errors: [] });
   expect(await desk(2)).toMatchObject({ resumed: [], pending: ["30"], errors: [] });
   expect(spawned).toEqual(["20"]);
   expect(posts).toHaveLength(3);
   r.journal.updateWorker("90", { status: "success" });
   expect(await desk(2)).toMatchObject({ resumed: ["30"], pending: [], errors: [] });
   expect(spawned).toEqual(["20", "30"]);
   expect(posts).toHaveLength(3);
  } finally { r.close(); }
 });

 test("read-only dashboard reads both holders from current config", () => {
  const r = rig();
  try {
   r.journal.upsertWorker({ nodeId: "90", repo: GAME, status: "running", lane: "implement" });
   r.journal.upsertWorker({ nodeId: "91", repo: TOOL, status: "claimed", lane: "implement" });
   const reader = new ServeReader(r.config, servedMaps(r.config), r.config.state.journalPath);
   const state = stateFromJournal(r.config, servedMaps(r.config), reader);
   expect(state.gates.laneHolders.visual?.nodeId).toBe("90");
   expect(state.gates.laneHolders.headless?.nodeId).toBe("91");
   expect(state.current.map((j) => j.resourceLane)).toEqual(["visual", "headless"]);
  } finally { r.close(); }
 });
});

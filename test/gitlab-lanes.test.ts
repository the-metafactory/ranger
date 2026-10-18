import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type RangerConfig, type RangerMapConfig } from "../src/config.ts";
import { runCmd, type RunResult } from "../src/exec.ts";
import type { ChangeRequest, CiPurpose, CiVerdict, ForgePort, IssueComment } from "../src/forge.ts";
import { graphReadToken, laneCredentialRefusal, lanePort } from "../src/forge-lanes.ts";
import * as github from "../src/github.ts";
import { openJournal, type Journal } from "../src/journal.ts";
import { implementLane } from "../src/lanes.ts";
import { runMergeDesk } from "../src/merge-desk.ts";
import { GITLAB_REVIEW_GATE_NODE } from "../src/outcomes.ts";
import type { ReviewVerdict } from "../src/review.ts";
import { assertReadOnlyToken } from "../src/token-gate.ts";
import { claimNode, walk } from "../src/walk.ts";
import { runNode, type RunNodeContext } from "../src/worker.ts";
import { createCanonicalRepo, fakeDiscord, GIT_ENV } from "./support.ts";
import { eligibleCodexReading } from "./fixtures/substrate-readings.ts";

/**
 * Node #131: the walk, implement and research lanes run a `gitlab:` map
 * against the GitLab port and gates, selected from the map's ForgeRef.forge.
 * The seam: the lane entry points with a fake GitLab port, a fake read gate
 * (the real gate over a fake glab), the fake soma and real git.
 */

const HOST = "gitlab.example.test";
const REPO = `gitlab:${HOST}/claw/sim`;
const KEY = `${HOST}__claw__sim`;
const BOT = "project_7_bot_c0ffee";
const PIPELINE = 731;
const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const savedEnv = { ...process.env };

/** The fake GitLab: MRs over the real bare origin, a pipeline per head, notes, labels and the squash merge. */
class FakeGitLab implements ForgePort {
 mrs = new Map<number, { head: string; base: string; title: string; body: string; state: "open" | "closed" | "merged"; mergedSha: string | null; mergedBy: string | null }>();
 notes = new Map<number, IssueComment[]>();
 merges: { n: number; sha: string; title: string }[] = [];
 ciPurposes: CiPurpose[] = [];
 private next = 1;

 constructor(private readonly origin: string) {}

 private async sha(branch: string): Promise<string> {
  const r = await runCmd("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.origin });
  return r.code === 0 ? r.stdout.trim() : "";
 }

 private async view(n: number): Promise<ChangeRequest> {
  const mr = this.mrs.get(n);
  if (mr === undefined) throw new Error(`no MR !${n}`);
  return {
   iid: n, state: mr.state, draft: mr.title.startsWith("Draft: "), title: mr.title, body: mr.body,
   headRef: mr.head, headSha: mr.mergedSha ?? await this.sha(mr.head), baseRef: mr.base,
   mergeState: "mergeable", mergeDetail: "mergeable", webUrl: `https://${HOST}/claw/sim/-/merge_requests/${n}`,
   author: BOT, mergeCommitSha: mr.mergedSha, mergedBy: mr.mergedBy,
  };
 }

 async findPrByHead(_repo: string, branch: string) {
  for (const [n, mr] of this.mrs) if (mr.head === branch) return this.view(n);
  return null;
 }
 async getPr(_repo: string, n: number) { return this.view(n); }
 async createDraftPr(_repo: string, pr: { head: string; base: string; title: string; body: string }) {
  const n = this.next++;
  this.mrs.set(n, { ...pr, title: `Draft: ${pr.title}`, state: "open", mergedSha: null, mergedBy: null });
  return this.view(n);
 }
 async updatePrBody(_repo: string, n: number, body: string) { this.mrs.get(n)!.body = body; }
 async markReady(_repo: string, pr: ChangeRequest) {
  const mr = this.mrs.get(pr.iid)!;
  mr.title = mr.title.replace(/^Draft: /, "");
 }
 /** GitLab's verdict: the latest push pipeline on the head, cited `<pipelineId>@<sha>`. */
 async ciVerdictFor(_repo: string, sha: string, _token: string, purpose?: CiPurpose): Promise<CiVerdict> {
  this.ciPurposes.push(purpose ?? "merge");
  return {
   state: "green", runId: PIPELINE, runUrl: `https://${HOST}/claw/sim/-/pipelines/${PIPELINE}`,
   runName: `pipeline ${PIPELINE}`, snapshot: `${PIPELINE}@${sha}`,
  };
 }
 async issueLabels() { return []; }
 async listComments(_repo: string, n: number) { return this.notes.get(n) ?? []; }
 async postComment(_repo: string, n: number, body: string) {
  const list = this.notes.get(n) ?? [];
  list.push({ id: list.length + 1, author: BOT, body });
  this.notes.set(n, list);
  return list.length;
 }
 async squashRefusal() { return null; }
 /** The squash merge at the gated head: origin's base moves to the head, as a fast-forward stands in for it. */
 async mergePr(_repo: string, n: number, sha: string, title: string) {
  const mr = this.mrs.get(n)!;
  if (await this.sha(mr.head) !== sha) return { status: "head-moved" as const, reason: "409" };
  this.merges.push({ n, sha, title });
  await runCmd("git", ["update-ref", `refs/heads/${mr.base}`, sha], { cwd: this.origin });
  mr.state = "merged";
  mr.mergedSha = sha;
  mr.mergedBy = BOT;
  return { status: "merged" as const, squashSha: sha };
 }
}

/** The real read gate, over a glab that grants a read_api PAT on the map's project. */
async function fakeReadGate(config: RangerConfig, repo: string) {
 const ok = (body: unknown): RunResult => ({ code: 0, stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
 return assertReadOnlyToken(config, repo, process.env, async (_cmd, args) =>
  ok(String(args[1]).includes("personal_access_tokens") ? { scopes: ["read_api"] } : { id: 7 }));
}

/** A scripted review standing in for the GitLab review gate ranger#96 will build: clean at the live head. */
function cleanReview(forge: FakeGitLab) {
 return async (_repo: string, n: number): Promise<ReviewVerdict> => ({
  verdict: "approved", summary: "clean", commitId: (await forge.getPr(REPO, n)).headSha,
  blockers: 0, majors: 0, nits: 0, body: "## Review\n\nClean.",
 });
}

interface Rig {
 dir: string;
 origin: string;
 config: RangerConfig;
 map: RangerMapConfig;
 journal: Journal;
 statePath: string;
 forge: FakeGitLab;
 ctx: RunNodeContext;
}

function nodeJson(id: string, node: Record<string, unknown>, extra: Record<string, unknown> = {}) {
 return JSON.stringify({
  repo: REPO, ref: { id }, node: { id, ...node }, status: "open", assignees: [], blockedBy: [], author: "alice",
  url: `https://${HOST}/claw/sim/-/issues/${id}`, typed: true, ...extra,
 });
}

async function rig(opts: { autonomy?: "auto" | "propose"; research?: boolean } = {}): Promise<Rig> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-gitlab-lanes-"));
 const { origin, canonical } = await createCanonicalRepo(dir);
 const data = join(dir, "data");
 mkdirSync(data);
 writeFileSync(join(data, `${KEY}-node-1.json`), nodeJson("1", { title: "Sim map", kind: "map", checkpointId: "", autonomy: "approve" },
  { body: "## Destination\n\nThe simulator walks.\n\n## Constraints\n\n- TypeScript / Bun only." }));
 const probes = opts.research
  ? [{ type: "git-ref-exists", ref: "research/api-survey" }]
  : [{ type: "artifact-exists", path: "src/feature.ts", atRef: "main" }];
 const autonomy = opts.autonomy ?? "auto";
 writeFileSync(join(data, `${KEY}-node-20.json`), nodeJson("20", opts.research
  ? { title: "Survey third-party API", kind: "research", checkpointId: "api-surveyed", autonomy, probes }
  : { title: "Add the feature module", kind: "task", checkpointId: "feature-shipped", autonomy, probes },
 { parent: { id: "1" }, body: "## Task\n\nAdd src/feature.ts and its test." }));
 const statePath = join(dir, "state.json");
 writeFileSync(join(data, `${KEY}-frontier.json`), JSON.stringify({ repo: REPO, root: "1", frontier: [JSON.parse(readFileSync(join(data, `${KEY}-node-20.json`), "utf8"))] }));
 writeFileSync(statePath, JSON.stringify({ nodes: { "20": { assignees: [], status: "open", autonomy, probes } }, decisions: [] }));

 // A GitLab graph call runs in glab's isolated env (PATH and HOME only), so
 // the fake soma's own settings ride on a wrapper first on PATH.
 const bin = join(dir, "bin");
 mkdirSync(bin);
 writeFileSync(join(bin, "soma"), [
  "#!/usr/bin/env bash",
  `export FAKE_SOMA_DIR='${data}' FAKE_SOMA_STATE='${statePath}' FAKE_SOMA_REPO_DIR='${origin}'`,
  `exec '${join(fixturesBin, "soma")}' "$@"`,
 ].join("\n"), { mode: 0o755 });
 // The write gate's GET /user and project reads: GitLab's project bot for this project.
 writeFileSync(join(bin, "glab"), [
  "#!/usr/bin/env bash",
  "case \"$*\" in",
  `  "api /user "*) echo '{"username":"${BOT}","bot":true,"id":77}' ;;`,
  `  "api /projects/claw%2Fsim "*) echo '{"id":7}' ;;`,
  "  *) echo \"fake glab: unexpected $*\" >&2; exit 9 ;;",
  "esac",
 ].join("\n"), { mode: 0o755 });

 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [{
   repo: REPO, root: 1, walk: "full", autoMerge: true, canonical,
   commands: { test: "test -f src/feature.ts" },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  }],
  auth: {
   readOnlyTokens: { [`gitlab:${HOST}/claw/`]: "RANGER_RO_GITLAB" },
   writeTokens: { [`gitlab:${HOST}/claw/`]: "RANGER_WRITE_GITLAB" },
  },
  bot: { identity: BOT },
  principal: { login: { [`gitlab:${HOST}`]: "jens-christian.fischer" } },
  state: { journalPath: join(dir, "state.sqlite"), canonicalRoot: dir },
  workers: { spawnCapPerDay: 10, niceness: 0, wallClockMin: 1, reviewRounds: 2 },
 }));
 const config = loadConfig(configPath).config;
 const map = config.maps[0]!;
 Object.assign(process.env, GIT_ENV, {
  PATH: `${bin}:${fixturesBin}:${savedEnv.PATH ?? ""}`,
  RANGER_RO_GITLAB: "glpat-read", RANGER_WRITE_GITLAB: "glpat-write",
 });
 delete process.env.RANGER_DISCORD_TOKEN; // park cards are best-effort
 const journal = openJournal(config);
 const forge = new FakeGitLab(origin);
 const ctx: RunNodeContext = {
  config, map, journal, token: "glpat-write", botIdentity: BOT,
  commitAuthor: { name: BOT, email: `${BOT}@noreply.${HOST}` },
  workerCommand: opts.research ? [join(fixturesBin, "worker")] : [join(fixturesBin, "implement-worker"), "build"],
  github: forge, readGate: fakeReadGate, readOnlyToken: "glpat-read",
  researchCiTiming: { settleMs: 0, pollMs: 1 },
  hostLoad: () => ({ load: 0, cores: 1 }),
  announce: async () => undefined,
  substrateReaders: {
   claude: () => Promise.reject(new Error("probe down")),
   codex: eligibleCodexReading,
  },
 };
 return { dir, origin, config, map, journal, statePath, forge, ctx };
}

const soma = (r: Rig) => JSON.parse(readFileSync(r.statePath, "utf8"));

/** Claim node 20 the way the walk does: announce, `soma graph claim` under the bot, a claimed row. */
async function claim(r: Rig, lane: "implement" | "research") {
 return claimNode({
  journal: r.journal, map: r.map, node: { id: "20", title: "Node 20" }, lane, botIdentity: BOT, token: r.ctx.token,
  cliEntry: "/unused", configPath: "/unused",
  announce: async () => ({ messageId: "discord-1" }) as never,
  spawnRunNode: async () => 4242,
 });
}

describe("node #131 — the lanes route a gitlab: map to the GitLab port and gates", () => {
 const dirs: string[] = [];
 afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
 });

 test("each lane takes its port, read gate and credential check from ForgeRef.forge, never the repo name", async () => {
  const r = await rig();
  dirs.push(r.dir);
  // GitHub keeps today's path: the github.ts module, graph reads under the write token.
  expect(lanePort(r.config, "acme/widgets")).toBe(github);
  expect(await graphReadToken(r.config, "acme/widgets", "ghp_write", async () => { throw new Error("no gate on GitHub"); }))
   .toEqual({ token: "ghp_write", source: "write-token" });
  expect(laneCredentialRefusal(r.config, "acme/widgets", {})).toBeNull();
  // Any GitLab project gets the GitLab adapter, the read gate's checked token, and the credential check.
  const other = `gitlab:${HOST}/claw/other`;
  for (const repo of [REPO, other]) {
   expect(lanePort(r.config, repo)).not.toBe(github);
   expect(typeof lanePort(r.config, repo).rebasePr).toBe("function");
   expect(laneCredentialRefusal(r.config, repo)).toBeNull();
   expect(laneCredentialRefusal(r.config, repo, { RANGER_WRITE_GITLAB: "w" })).toContain("RANGER_RO_GITLAB");
   expect(laneCredentialRefusal(r.config, repo, { RANGER_RO_GITLAB: "r" })).toContain("RANGER_WRITE_GITLAB");
  }
  const gated = await graphReadToken(r.config, REPO, "glpat-write", fakeReadGate);
  expect(gated.source).toBe("RANGER_RO_GITLAB");
 });

 for (const autonomy of ["auto", "propose"] as const) {
  test(`implement (${autonomy}): claim → draft MR → ready → CI green → merge desk → close citing the pipeline`, async () => {
   const r = await rig({ autonomy });
   dirs.push(r.dir);
   r.ctx.reviewer = cleanReview(r.forge);

   expect(await claim(r, "implement")).toMatchObject({ claimed: true });
   expect(soma(r).nodes["20"].assignees).toEqual([BOT]);

   // Draft MR, the review round, ready: the run hands off to the merge desk.
   const built = await runNode("20", r.ctx);
   expect(built).toMatchObject({ status: "awaiting-merge", prNumber: 1 });
   const mr = await r.forge.getPr(REPO, 1);
   expect(mr).toMatchObject({ state: "open", draft: false, title: "Add the feature module (node #20)" });
   expect(r.journal.getWorker("20", REPO)).toMatchObject({ status: "awaiting-merge", phase: "awaiting-merge", prNumber: 1 });
   expect(r.journal.listNodeEvents(REPO, "20").find((e) => e.kind === "pr-opened")?.detail)
    .toBe(`MR !1 (draft) https://${HOST}/claw/sim/-/merge_requests/1`);

   // The merge desk: CI green on the head, ranger squash-merges (autoMerge) and resumes the close.
   const spawned: string[] = [];
   const desk = await runMergeDesk({
    config: r.config, journal: r.journal, map: r.map, token: r.ctx.token, botIdentity: BOT, github: r.forge,
    post: async () => "discord-2", spawn: async (id) => { spawned.push(id); return 4243; },
   });
   expect(desk).toMatchObject({ merged: ["20"], parked: [], errors: [] });
   expect(r.forge.merges).toEqual([{ n: 1, sha: mr.headSha, title: expect.stringContaining("Add the feature module") }]);
   expect(spawned).toEqual(["20"]);

   // The close: the pipeline cited `<pipelineId>@<sha>`, its evidence pointer at /-/pipelines/<id>.
   const closed = await runNode("20", r.ctx);
   expect(closed).toMatchObject({ status: "success" });
   const state = soma(r);
   expect(state.nodes["20"].status).toBe("closed");
   const pipelineUrl = `https://${HOST}/claw/sim/-/pipelines/${PIPELINE}`;
   if (autonomy === "auto") {
    expect(state.lastClose.ci).toBe(`${PIPELINE}@${mr.headSha}`);
   } else {
    expect(state.lastClose.ci).toBe("");
    expect(state.lastClose.evidence).toContainEqual(expect.objectContaining({ kind: "tested", pointer: pipelineUrl }));
   }
   expect(r.forge.ciPurposes).toContain("close");
  }, 60_000);
 }

 test("the review step holds a GitLab MR at awaiting-review, escalating ranger#96, and never merges it", async () => {
  const r = await rig();
  dirs.push(r.dir);
  expect(await claim(r, "implement")).toMatchObject({ claimed: true });

  const held = await runNode("20", r.ctx);
  expect(held.status).toBe("parked");
  expect(held.detail).toContain("awaiting review: MR !1");
  expect(held.detail).toContain(GITLAB_REVIEW_GATE_NODE);
  expect(GITLAB_REVIEW_GATE_NODE).toBe("Settle the review gate a ranger-built GitLab MR must pass before ranger merges it (ranger#96)");
  expect(r.journal.getWorker("20", REPO)).toMatchObject({ status: "parked", phase: "awaiting-review", prNumber: 1 });
  expect(r.journal.listNodeEvents(REPO, "20").some((e) => e.kind === "parked" && e.detail?.includes("ranger#96"))).toBe(true);
  // Still a draft: no review was posted, and nothing readied it.
  expect(await r.forge.getPr(REPO, 1)).toMatchObject({ state: "open", draft: true });
  expect(r.forge.notes.get(1) ?? []).toEqual([]);

  // The merge desk leaves it alone: it is not awaiting a merge.
  const desk = await runMergeDesk({
   config: r.config, journal: r.journal, map: r.map, token: r.ctx.token, botIdentity: BOT, github: r.forge,
   post: async () => "discord-2", spawn: async () => { throw new Error("no resume expected"); },
  });
  expect(desk).toMatchObject({ merged: [], resumed: [], cards: [] });
  expect(r.forge.merges).toEqual([]);

  // A resume holds it again, still unmerged.
  r.journal.updateWorker("20", REPO, { status: "claimed" });
  expect(await runNode("20", r.ctx)).toMatchObject({ status: "parked" });
  expect(r.forge.mrs.size).toBe(1);
  expect(r.forge.merges).toEqual([]);
 }, 60_000);

 test("research: the draft MR's pipeline is cited the same way", async () => {
  const r = await rig({ research: true });
  dirs.push(r.dir);
  expect(await claim(r, "research")).toMatchObject({ claimed: true });

  const outcome = await runNode("20", r.ctx);
  expect(outcome).toMatchObject({ status: "success" });
  const mr = await r.forge.getPr(REPO, 1);
  expect(mr).toMatchObject({ state: "open", draft: true, headRef: "research/api-survey" });
  expect(r.forge.ciPurposes).toEqual(["research"]);
  expect(r.forge.merges).toEqual([]);
  const state = soma(r);
  expect(state.lastClose.ci).toBe(`${PIPELINE}@${mr.headSha}`);
  expect(state.nodes["20"].status).toBe("closed");
  expect(r.journal.listNodeEvents(REPO, "20").find((e) => e.kind === "pr-opened")?.detail)
   .toBe(`research draft MR !1 https://${HOST}/claw/sim/-/merge_requests/1`);
 }, 60_000);

 test("the walk tick gates a GitLab map by its bot, reads its frontier under the read gate and claims", async () => {
  const r = await rig({ research: true });
  dirs.push(r.dir);
  const discord = fakeDiscord();
  try {
   Object.assign(process.env, {
    RANGER_DISCORD_API_BASE: `http://127.0.0.1:${discord.port}`, RANGER_DISCORD_ALLOW_TEST_OVERRIDE: "1",
    RANGER_DISCORD_MIN_INTERVAL_MS: "5", RANGER_DISCORD_TOKEN: "fake-bot-token",
   });
   const gated: string[] = [];
   const spawned: { nodeId: string; repo: string }[] = [];
   const result = await walk({
    config: r.config, configPath: "/unused", journal: r.journal, github: r.forge,
    readGate: async (config, repo) => { gated.push(repo); return fakeReadGate(config, repo); },
    spawnRunNode: async ({ nodeId, repo }) => { spawned.push({ nodeId, repo }); return 4242; },
   });
   expect(result.maps[0]).toMatchObject({ gated: false, claimed: ["20"], announced: ["20"], errors: [] });
   expect(gated).toEqual([REPO]); // once per map per tick
   expect(spawned).toEqual([{ nodeId: "20", repo: REPO }]);
   expect(soma(r).nodes["20"].assignees).toEqual([BOT]);
   expect(r.journal.getWorker("20", REPO)).toMatchObject({ status: "claimed", lane: "research" });
  } finally { discord.stop(); }
 }, 30_000);

 test("a read gate the forge cannot answer keeps a queued resume; a refusal counts a failed start", async () => {
  const r = await rig();
  dirs.push(r.dir);
  r.journal.upsertWorker({ nodeId: "20", repo: REPO, root: 1, status: "parked", lane: "implement", phase: "review",
   finishedAt: "2026-10-06T00:00:00Z", workerPgid: 1234 });
  const entry = r.journal.enqueueResume({ nodeId: "20", repo: REPO, root: 1, lane: implementLane(r.map) });
  const forbidden = async (): Promise<never> => { throw new Error("unexpected spawn"); };
  // The real read gate over a glab whose introspection answers with `status`.
  const gateAnswering = (status: number) => (config: RangerConfig, repo: string) =>
   assertReadOnlyToken(config, repo, process.env, async (): Promise<RunResult> =>
    ({ code: 1, stdout: `HTTP/2.0 ${status} Response\r\nContent-Type: application/json\r\n\r\n{}`, stderr: "" }));
  for (let tick = 0; tick < 4; tick++) {
   const result = await walk({ config: r.config, configPath: "/unused", journal: r.journal, github: r.forge,
    readGate: gateAnswering(503), spawnRunNode: forbidden });
   expect(result.maps[0]).toMatchObject({ gated: true, claimed: [] });
   expect(result.maps[0]!.gateReason).toContain("HTTP 503");
  }
  expect(r.journal.listResumeQueue()).toEqual([entry]);

  await walk({ config: r.config, configPath: "/unused", journal: r.journal, github: r.forge,
   readGate: gateAnswering(403), spawnRunNode: forbidden });
  expect(r.journal.getResume(REPO, "20")?.failedStarts).toBe(1);
 });

 test("with no GitLab credentials the tick refuses the map at start and claims nothing", async () => {
  const r = await rig();
  dirs.push(r.dir);
  delete process.env.RANGER_RO_GITLAB;
  delete process.env.RANGER_WRITE_GITLAB;
  const forbidden = async (): Promise<never> => { throw new Error("unexpected call"); };
  const result = await walk({
   config: r.config, configPath: "/unused", journal: r.journal, spawnRunNode: forbidden, readGate: forbidden,
   github: new Proxy({}, { get: () => forbidden }) as ForgePort,
  });
  expect(result.maps[0]).toMatchObject({ gated: true, claimed: [], announced: [] });
  expect(result.maps[0]!.gateReason).toContain(`no GitLab credentials for ${REPO}`);
  expect(soma(r).nodes["20"].assignees).toEqual([]);
  expect(r.journal.listWorkers()).toEqual([]);
 });
});

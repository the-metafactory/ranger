import { describe, expect, test } from "bun:test";
import type { RangerConfig } from "../src/config.ts";
import type { runCmd, RunResult } from "../src/exec.ts";
import type { ChangeRequest, CiVerdict, ForgeReadPort, MergeState } from "../src/forge.ts";
import type { WorkerRow } from "../src/journal.ts";
import { assembleState, createHandler, readIssue, readMrLive, readPrLive, renderPage, verifyChecksAs, type StateInputs } from "../src/serve.ts";
import {
 type ActionRunner,
 awaitingMergeEntries,
 MACHINE_FORGE_KEYS,
 mergeArgv,
 needsYouEntries,
 type NeedsYouInputs,
 type PrView,
} from "../src/serve-parked.ts";
import { assertReadOnlyToken, type ResolvedToken, type TokenBatch } from "../src/token-gate.ts";

/**
 * Node #132 — `ranger serve` on a GitLab map: MRs, merge state and the
 * pipeline verdict read through the GitLab port under the read gate, and the
 * principal's tap merge as `glab api` under their own login. Nothing here
 * runs glab or gh: the port, the runner and the pipeline re-read are fakes.
 */

const HOST = "gitlab.example.test";
const REPO = `gitlab:${HOST}/claw/crisis-simulator`;
const PROJECT = "projects/claw%2Fcrisis-simulator";
const KEY = `${REPO}#1`;
const SHA = "c0ffee12".padEnd(40, "0");
const MR_URL = `https://${HOST}/claw/crisis-simulator/-/merge_requests/5`;

const row = (over: Partial<WorkerRow> = {}): WorkerRow => ({
 nodeId: "42",
 root: 1,
 repo: REPO,
 pid: null,
 status: "parked",
 attempts: 0,
 worktree: "/srv/ranger-repos/claw/crisis-simulator/.worktrees/node-42",
 startedAt: "2026-10-09T08:00:00Z",
 finishedAt: "2026-10-09T09:00:00Z",
 outcome: "worker exited 1",
 messageId: null,
 lane: "implement",
 generation: 1,
 workerPgid: null,
 phase: "review",
 prNumber: 5,
 researchBaseSha: null,
 reviewRound: 1,
 verdictSha: null,
 verdictBlockers: 0,
 mergeMessageId: null,
 substrate: "claude",
 ...over,
});

const mrView = (over: Partial<PrView> = {}): PrView => ({
 number: 5,
 url: MR_URL,
 state: "open",
 merged: false,
 draft: false,
 headSha: SHA,
 mergeable: true,
 mergeState: "mergeable",
 mergeDetail: "mergeable",
 ci: "green",
 readAt: "2026-10-09T09:05:00Z",
 ...over,
});

const MAP = { key: KEY, repo: REPO, root: 1, localCheckout: "/Users/someone/crisis-simulator" };

const inputs = (over: Partial<NeedsYouInputs> = {}): NeedsYouInputs => ({
 maps: [MAP],
 workers: [row()],
 events: () => [],
 labels: () => [],
 prs: () => mrView(),
 titleOf: () => "Score the inject",
 reviewRounds: 5,
 exists: () => true,
 ...over,
});

const mr = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
 iid: 5,
 state: "open",
 draft: false,
 headRef: "node/42-score",
 headSha: SHA,
 baseRef: "main",
 mergeState: "mergeable",
 mergeDetail: "mergeable",
 webUrl: MR_URL,
 author: "project_7_bot",
 title: "Score the inject",
 mergeCommitSha: null,
 mergedBy: null,
 ...over,
});

const GRANTED: ResolvedToken = { token: "read-secret", source: "READ_GL" };

/** A fake GitLab read port: one MR, one verdict, the token each read was handed. */
function fakePort(change: ChangeRequest, verdict: CiVerdict | Error) {
 const seen: { call: string; token: ResolvedToken }[] = [];
 const port: ForgeReadPort<ResolvedToken> = {
  findPrByHead: async () => null,
  getPr: async (_repo, _n, token) => (seen.push({ call: "getPr", token }), change),
  ciVerdictFor: async (_repo, sha, token) => {
   seen.push({ call: `ciVerdictFor ${sha}`, token });
   if (verdict instanceof Error) throw verdict;
   return verdict;
  },
  issueLabels: async () => [],
  listComments: async () => [],
 };
 return { port, seen };
}

const GREEN: CiVerdict = { state: "green", runId: 30, runUrl: `https://${HOST}/claw/crisis-simulator/-/pipelines/30`, runName: "pipeline 30", snapshot: `30@${SHA}` };
const tokens: TokenBatch = async () => GRANTED;

describe("node #132 — the dashboard reads a GitLab MR through the port and the read gate", () => {
 test("an open MR: its merge state, the pipeline verdict at its head, GitLab's URL, under the gated token", async () => {
  const { port, seen } = fakePort(mr(), GREEN);
  const view = await readMrLive(REPO, 5, tokens, port);
  expect(view).toMatchObject({ number: 5, url: MR_URL, state: "open", merged: false, headSha: SHA, mergeable: true, mergeState: "mergeable", ci: "green" });
  expect(seen).toEqual([{ call: "getPr", token: GRANTED }, { call: `ciVerdictFor ${SHA}`, token: GRANTED }]);
  // readPrLive sends a GitLab repo to the same reader, never to gh.
  expect(await readPrLive({} as RangerConfig, REPO, 5, tokens, port)).toMatchObject({ mergeState: "mergeable", ci: "green" });
 });

 test("the port's verdict words become the card's: red is failed, pending is pending, a failed read is unreadable", async () => {
  const ci = async (verdict: CiVerdict | Error) => (await readMrLive(REPO, 5, tokens, fakePort(mr(), verdict).port)).ci;
  expect(await ci({ state: "red", reason: "pipeline 30 is failed" })).toBe("failed");
  expect(await ci({ state: "pending", reason: "no pipeline" })).toBe("pending");
  expect(await ci(new Error("HTTP 502"))).toBe("unreadable");
 });

 test("mergeable is read off the merge state: pending is unknown yet, the rest are no", async () => {
  const states: [MergeState, boolean | null][] = [["mergeable", true], ["pending", null], ["needs-rebase", false], ["conflict", false], ["blocked", false], ["unknown", false]];
  for (const [mergeState, mergeable] of states) {
   const view = await readMrLive(REPO, 5, tokens, fakePort(mr({ mergeState, mergeDetail: "x" }), GREEN).port);
   expect(view.mergeable).toBe(mergeable);
   expect(view.mergeState).toBe(mergeState);
  }
 });

 test("a merged, closed or merging MR reads no pipeline", async () => {
  const merged = fakePort(mr({ state: "merged" }), GREEN);
  expect(await readMrLive(REPO, 5, tokens, merged.port)).toMatchObject({ merged: true, state: "closed", ci: "not-read" });
  expect(merged.seen.map((s) => s.call)).toEqual(["getPr"]);
  const locked = await readMrLive(REPO, 5, tokens, fakePort(mr({ state: "closed", mergeInProgress: true }), GREEN).port);
  expect(locked).toMatchObject({ state: "closed", merging: true, ci: "not-read" });
 });

 test("a failed MR read throws with the port's reason, so the card shows it", async () => {
  const port: ForgeReadPort<ResolvedToken> = { ...fakePort(mr(), GREEN).port, getPr: async () => { throw new Error("projects/x/merge_requests/5: read failed (exit 1)"); } };
  await expect(readMrLive(REPO, 5, tokens, port)).rejects.toThrow(/read failed/);
 });

 test("the issue reader reads a GitLab node over glab under the read gate, not gh", async () => {
  const config = { auth: { readOnlyTokens: { [`gitlab:${HOST}/`]: "READ_GL" }, defaultTokenEnv: undefined } } as unknown as RangerConfig;
  const response = (body: unknown, status = 200): RunResult => ({
   code: status === 200 ? 0 : 1,
   stderr: "",
   stdout: `HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
  });
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const runner: typeof runCmd = async (bin, args, opts) => {
   calls.push({ bin, args, env: opts?.env });
   if (args[1] === "/personal_access_tokens/self") return response({ scopes: ["read_api"] });
   if (args[1] === `/${PROJECT}`) return response({ id: 7 });
   expect(args[1]).toBe(`${PROJECT}/issues/42`);
   return response({
    iid: 42,
    title: "Score the inject",
    state: "opened",
    labels: ["ranger:needs-eye"],
    assignees: [{ username: "project_7_bot" }],
    description: 'Body\n<!-- soma:work-graph-node {"kind":"grilling","autonomy":"propose"} -->',
   });
  };
  const batch: TokenBatch = async (repo) => (await assertReadOnlyToken(config, repo, { READ_GL: "read-secret" }, runner)).token;
  const issue = await readIssue(config, REPO, "42", batch, runner);
  expect(issue).toEqual({
   title: "Score the inject",
   state: "open",
   assignees: ["project_7_bot"],
   labels: ["ranger:needs-eye"],
   kind: "grilling",
   autonomy: "propose",
  });
  expect(calls.every((c) => c.bin === "glab")).toBe(true);
  const read = calls.at(-1)!;
  expect(read.args).toEqual(["api", `${PROJECT}/issues/42`, "--hostname", HOST, "--method", "GET", "--include"]);
  expect(read.env?.GLAB_CONFIG_DIR).toMatch(/ranger-glab-/);
  expect(read.env?.GITLAB_TOKEN).toBeUndefined();

  // A body for another issue is no read at all.
  const wrong: typeof runCmd = async (bin, args, opts) =>
   args[1] === `${PROJECT}/issues/42` ? response({ iid: 43, title: "t", state: "opened", labels: [], assignees: [] }) : runner(bin, args, opts);
  await expect(readIssue(config, REPO, "42", batch, wrong)).rejects.toThrow(/iid differs/);
 });
});

describe("node #132 — the GitLab card", () => {
 test("names its MR the GitLab way and offers the tap only when mergeable with the pipeline green", () => {
  const [e] = needsYouEntries(inputs());
  expect(e.forge).toBe("gitlab");
  expect(e.url).toBe(`https://${HOST}/claw/crisis-simulator/-/issues/42`);
  expect(e.pr).toMatchObject({ number: 5, label: "MR !5", noun: "MR", url: MR_URL });
  expect(e.actions.merge).toEqual({ offered: true, headSha: SHA });
 });

 for (const [mergeState, detail, says] of [
  ["needs-rebase", "need_rebase", /needs the MR rebased onto its target \(need_rebase\): the merge desk rebases it/],
  ["conflict", "conflict", /conflicts with its target \(conflict\)/],
  ["blocked", "not_approved", /GitLab blocks the merge \(not_approved\)/],
  ["unknown", "something_new", /merge status is unknown \(something_new\)/],
  ["pending", "checking", /still checking whether the MR can merge/],
 ] as const) {
  test(`merge state ${mergeState}: the card says so and offers no tap`, () => {
   const view = mrView({ mergeState, mergeDetail: detail, mergeable: mergeState === "pending" ? null : false });
   const [e] = needsYouEntries(inputs({ prs: () => view }));
   expect(e.pr?.view?.mergeState).toBe(mergeState);
   expect(e.actions.merge.offered).toBe(false);
   expect(e.actions.merge.offered ? "" : e.actions.merge.why).toMatch(says);
  });
 }

 test("the pipeline, a draft, an unread MR: refused in MR words", () => {
  const why = (view: PrView | null) => {
   const m = needsYouEntries(inputs({ prs: () => view }))[0].actions.merge;
   return m.offered ? null : m.why;
  };
  expect(why(mrView({ ci: "failed" }))).toBe("the pipeline is failed");
  expect(why(mrView({ ci: "unreadable" }))).toBe("the pipeline could not be read");
  expect(why(mrView({ draft: true }))).toMatch(/the MR is a draft/);
  expect(why(mrView({ state: "closed", merging: true }))).toBe("GitLab is merging the MR now");
  expect(why(null)).toBe("the MR has not been read yet");
  expect(needsYouEntries(inputs({ workers: [row({ prNumber: null })] }))[0].actions.merge).toEqual({ offered: false, why: "no MR" });
 });

 test("a GitHub card keeps PR #N and the GitHub forge", () => {
  const gh = "jcfischer/seelite";
  const [e] = needsYouEntries(inputs({
   maps: [{ ...MAP, key: `${gh}#1`, repo: gh }],
   workers: [row({ repo: gh })],
   prs: () => mrView({ mergeState: undefined, mergeDetail: undefined, url: "https://github.com/jcfischer/seelite/pull/5" }),
  }));
  expect(e.forge).toBe("github");
  expect(e.pr).toMatchObject({ label: "PR #5", noun: "PR" });
  expect(e.actions.merge.offered).toBe(true);
 });

 test("the page's GitLab button reads Merge MR !N and its link Open MR !N; GitHub's text is unchanged", () => {
  const page = renderPage("tok");
  expect(page).toContain('actionButton("Merge " + n.pr.label');
  expect(page).toContain('n.forge === "gitlab" ? "Open " + n.pr.label : "Open PR"');
  expect(page).toContain('mergeButton(n, "Merge")');
  expect(page).toContain('mergeButton(waiting, "Merge now")');
  expect(page).toContain('"merge state " + v.mergeState');
  const body = page.slice(page.indexOf("<script>") + "<script>".length, page.indexOf("</script>"));
  expect(() => new Function(body)).not.toThrow();
 });

 test("the current job names a GitLab MR as MR !N", () => {
  const state = assembleState({
   ...baseInputs(),
   workers: [row({ status: "running", pid: 4242 })],
  });
  expect(state.current[0]).toMatchObject({ prNumber: 5, prLabel: "MR !5" });
 });
});

const PORT = 7312;
const TOKEN = "t".repeat(48);
const MACHINE_ENV = {
 PATH: "/usr/bin",
 HOME: "/Users/someone",
 GH_TOKEN: "ghp_machine",
 GITLAB_TOKEN: "glpat-machine",
 GLAB_TOKEN: "glpat-machine",
 GLAB_CONFIG_DIR: "/Users/someone/.config/ranger/glab-config",
 GITLAB_HOST: HOST,
 RANGER_WRITE_GL_TOKEN: "glpat-bot",
};

function baseInputs(): StateInputs {
 return {
  maps: [{ ...MAP, walk: "full", lane: "headless", servedOnly: false }],
  reports: new Map(),
  titles: new Map(),
  workers: [],
  laneHolders: { visual: null, headless: null },
  paused: false,
  spawnsToday: 0,
  spawnCap: 10,
  vetoed: () => false,
  pidAlive: () => true,
  refreshing: false,
  refreshError: null,
  now: new Date("2026-10-09T09:10:00Z"),
 };
}

const post = (path: string, body: unknown) =>
 new Request(`http://127.0.0.1:${PORT}${path}`, {
  method: "POST",
  headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "x-ranger-token": TOKEN, "content-type": "application/json" },
  body: JSON.stringify(body),
 });

function setup(opts: {
 status?: WorkerRow["status"];
 live?: PrView | null;
 verify?: ((repo: string, sha: string, env: Record<string, string>) => Promise<PrView["ci"] | null>) | null;
 gateCode?: number;
} = {}) {
 const runs: { argv: string[]; env: Record<string, string> }[] = [];
 const verified: { repo: string; sha: string; env: Record<string, string>; runsBefore: number }[] = [];
 const run: ActionRunner = async (argv, env) => {
  runs.push({ argv, env });
  return argv[1] === "merge-gate" && (opts.gateCode ?? 0) !== 0 ? { code: opts.gateCode!, stderr: "merge gate fail (pipeline)" } : { code: 0, stderr: "" };
 };
 const verify = opts.verify;
 const status = opts.status ?? "parked";
 const entryInputs = inputs({ workers: [row({ status })] });
 const handler = createHandler({
  port: PORT,
  token: TOKEN,
  getState: () => assembleState({
   ...baseInputs(),
   needsYou: needsYouEntries(entryInputs),
   awaitingMerge: awaitingMergeEntries(entryInputs),
  }),
  refresh: () => {},
  launch: () => { throw new Error("no launch"); },
  verifyGrilling: async () => null,
  actions: {
   run,
   env: MACHINE_ENV,
   rangerBin: "/r",
   configPath: "/c",
   readPr: async () => (opts.live === undefined ? mrView() : opts.live),
   ...(verify === null
    ? {}
    : {
       verifyChecks: async (repo: string, sha: string, env: Record<string, string>) => {
        verified.push({ repo, sha, env, runsBefore: runs.filter((r) => r.argv[0] === "glab").length });
        return verify === undefined ? "green" : verify(repo, sha, env);
       },
      }),
   exists: () => true,
  },
 });
 return { handler, runs, verified };
}

const GLAB_MERGE = ["glab", "api", "--hostname", HOST, "-X", "PUT", `${PROJECT}/merge_requests/5/merge`, "-f", "squash=true", "-f", `sha=${SHA}`];

describe("node #132 — the principal's tap merge on a GitLab MR", () => {
 test("mergeArgv: glab api PUT on the MR's merge, squashed, pinned to the gated head", () => {
  expect(mergeArgv({ repo: REPO, pr: 5, sha: SHA })).toEqual(GLAB_MERGE);
  expect(mergeArgv({ repo: "jcfischer/seelite", pr: 5, sha: SHA })[0]).toBe("gh");
  expect(() => mergeArgv({ repo: REPO, pr: 5, sha: "HEAD" })).toThrow(/bad head SHA/);
 });

 test("runs glab under the principal's login: machine keys and GLAB_CONFIG_DIR stripped, the pipeline re-read under that env first", async () => {
  const { handler, runs, verified } = setup();
  const res = await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
  expect(res.status).toBe(200);
  const merge = runs.find((r) => r.argv[0] === "glab")!;
  expect(merge.argv).toEqual(GLAB_MERGE);
  for (const key of MACHINE_FORGE_KEYS) expect(merge.env[key]).toBeUndefined();
  expect(merge.env.GLAB_CONFIG_DIR).toBeUndefined();
  expect(Object.keys(merge.env).some((k) => /TOKEN|GITLAB|GLAB/.test(k))).toBe(false);
  expect(merge.env.HOME).toBe("/Users/someone");
  expect(verified).toEqual([{ repo: REPO, sha: SHA, env: merge.env, runsBefore: 0 }]);
  // Then the map's merge desk starts the close, as on GitHub.
  expect(runs.map((r) => r.argv[1])).toEqual(["api", "merge-desk", "merge-desk"]);
  expect(runs[1].argv).toEqual(["/r", "merge-desk", "--map", KEY, "-c", "/c"]);
 });

 for (const [why, verify, says] of [
  ["a failed pipeline under the principal's login", async () => "failed" as const, "read under your glab login, is failed"],
  ["a pending pipeline", async () => "pending" as const, "read under your glab login, is pending"],
  ["a pipeline the principal's login cannot read", async () => null, "could not be read under your glab login"],
 ] as const) {
  test(`refuses on ${why}, and glab never merges`, async () => {
   const { handler, runs } = setup({ verify });
   const res = await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
   expect(res.status).toBe(409);
   expect(JSON.stringify(await res.json())).toContain(says);
   expect(runs).toHaveLength(0);
  });
 }

 test("refuses with no pipeline re-read wired: GitLab never merges on the read token's verdict alone", async () => {
  const { handler, runs } = setup({ verify: null });
  const res = await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
  expect(res.status).toBe(409);
  expect(runs).toHaveLength(0);
 });

 test("an awaiting-merge MR merges only past the merge desk's gate", async () => {
  const passed = setup({ status: "awaiting-merge" });
  expect((await passed.handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }))).status).toBe(200);
  expect(passed.runs.map((r) => (r.argv[0] === "glab" ? "glab" : r.argv[1]))).toEqual(["merge-gate", "glab", "merge-desk", "merge-desk"]);
  const held = setup({ status: "awaiting-merge", gateCode: 2 });
  const res = await held.handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
  expect(res.status).toBe(409);
  expect(held.runs.map((r) => r.argv[1])).toEqual(["merge-gate"]);
 });

 test("read live as needs-rebase or conflicted, an awaiting-merge MR goes to the merge desk; blocked does not", async () => {
  for (const mergeState of ["needs-rebase", "conflict"] as const) {
   const { handler, runs } = setup({ status: "awaiting-merge", live: mrView({ mergeState, mergeable: false }) });
   const res = await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
   expect(res.status).toBe(409);
   expect(runs.map((r) => r.argv)).toEqual([["/r", "merge-desk", "--map", KEY, "-c", "/c"]]);
  }
  const { handler, runs } = setup({ status: "awaiting-merge", live: mrView({ mergeState: "blocked", mergeDetail: "not_approved", mergeable: false }) });
  const res = await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/GitLab blocks the merge \(not_approved\)/);
  expect(runs).toHaveLength(0);
 });

 test("a head that moved, read live, refuses in MR words", async () => {
  const { handler, runs } = setup({ live: mrView({ headSha: "e".repeat(40) }) });
  const res = await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe("the MR head moved since the page read it: reload and confirm again");
  expect(runs).toHaveLength(0);
 });

 test("chained from the fake port: a mergeable MR merges with glab; a needs-rebase or blocked one offers no tap and runs nothing", async () => {
  const live = (change: ChangeRequest) => readMrLive(REPO, 5, tokens, fakePort(change, GREEN).port);
  const green = setup({ live: await live(mr()) });
  expect((await green.handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }))).status).toBe(200);
  expect(green.runs[0].argv).toEqual(GLAB_MERGE);
  for (const [mergeState, detail] of [["needs-rebase", "need_rebase"], ["blocked", "not_approved"]] as const) {
   const view = await live(mr({ mergeState, mergeDetail: detail }));
   const [card] = needsYouEntries(inputs({ prs: () => view }));
   expect(card.actions.merge.offered).toBe(false);
   expect(card.actions.merge.offered ? "" : card.actions.merge.why).toContain(`(${detail})`);
   const held = setup({ live: view });
   const res = await held.handler(post("/api/merge", { key: KEY, id: "42", sha: SHA }));
   expect(res.status).toBe(409);
   expect(((await res.json()) as { error: string }).error).toContain(`(${detail})`);
   expect(held.runs).toHaveLength(0);
  }
 });

 test("a dry run names the glab argv and the env keys it would pass", async () => {
  const { handler, runs } = setup();
  const body = (await (await handler(post("/api/merge", { key: KEY, id: "42", sha: SHA, dryRun: true }))).json()) as { argv: string[]; envKeys: string[] };
  expect(body.argv).toEqual(GLAB_MERGE);
  expect(body.envKeys).toEqual(["HOME", "PATH"]);
  expect(runs).toHaveLength(0);
 });
});

describe("node #132 — the pipeline re-read under the principal's glab login", () => {
 const pipelines = (rows: unknown[]): RunResult => ({
  code: 0,
  stderr: "",
  stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-Next-Page: \r\n\r\n${JSON.stringify(rows)}`,
 });
 const pipeline = (id: number, status: string, source = "merge_request_event", sha = SHA) =>
  ({ id, status, source, sha, web_url: `https://${HOST}/claw/crisis-simulator/-/pipelines/${id}` });
 const login = { PATH: "/usr/bin", HOME: "/Users/someone" };

 test("glab api on the head's pipelines with exactly the merge's env, by the port's verdict rules", async () => {
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const runner: typeof runCmd = async (bin, args, opts) => {
   calls.push({ bin, args, env: opts?.env });
   return pipelines([pipeline(31, "failed", "external"), pipeline(30, "success")]);
  };
  expect(await verifyChecksAs(REPO, SHA, login, runner)).toBe("green");
  expect(calls).toEqual([{
   bin: "glab",
   args: ["api", `${PROJECT}/pipelines?sha=${SHA}&order_by=id&sort=desc&per_page=100&page=1`, "--hostname", HOST, "--method", "GET", "--include"],
   env: login,
  }]);
 });

 test("failed and running pipelines are not green; an unreadable or malformed read is null", async () => {
  const verdict = (result: RunResult) => verifyChecksAs(REPO, SHA, login, async () => result);
  expect(await verdict(pipelines([pipeline(30, "failed")]))).toBe("failed");
  expect(await verdict(pipelines([pipeline(30, "running")]))).toBe("pending");
  expect(await verdict(pipelines([]))).toBe("pending");
  expect(await verdict({ code: 1, stderr: "403 Forbidden", stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{}" })).toBeNull();
  expect(await verdict(pipelines([pipeline(30, "success", "push", "f".repeat(40))]))).toBeNull();
 });
});

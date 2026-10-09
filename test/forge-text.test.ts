import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import type { ChangeRequest, CiVerdict, IssueComment } from "../src/forge.ts";
import {
 changeRequestLabel,
 changeRequestNoun,
 changeRequestRef,
 changeRequestUrl,
 ciRunNoun,
 ciRunText,
 ciRunUrl,
 forgeName,
 nodeCommentUrl,
 nodeUrl,
} from "../src/forge-text.ts";
import type { NodeResult } from "../src/graph.ts";
import {
 closeResolution,
 draftBody,
 fixNodeSpec,
 gistLine,
 type ForgePort,
 type ImplementContext,
 readyBody,
 type RecordedProbe,
 type RecordedReview,
} from "../src/implement.ts";
import { openJournal, type WorkerRow } from "../src/journal.ts";
import { runMergeDesk } from "../src/merge-desk.ts";
import {
 baseConflictOutcome,
 infrastructureProbeHead,
 probesFailedOutcome,
 REVIEW_CAP_HEAD_MOVED_OUTCOME,
 REVIEW_CAP_OUTCOME,
 reviewCapHeadMovedOutcome,
 reviewCapOutcome,
} from "../src/outcomes.ts";
import { needsYouEntries, resumeQueueViews } from "../src/serve-parked.ts";

/**
 * Node #129: ranger names a change request the way its forge does. The
 * GitHub renderings below were pinned against the code before the forge-text
 * module existed; they must stay byte-identical.
 */

const GITHUB = "acme/widgets";
const GITLAB = "gitlab:gitlab.example.org/claw/crisis-simulator";
const BOT = "ivy-bot";
const HEAD = "c".repeat(40);
const NODE = "129";
const MR = 42;

function rig(repo: string, map: { autoMerge?: boolean; probe?: boolean } = {}) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-forge-text-"));
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, stringify({
  version: 1,
  maps: [{
   repo, root: 97, walk: "full", autoMerge: map.autoMerge ?? false,
   commands: { test: "bun test", ...(map.probe === true ? { probe: "npm run probe" } : {}) },
   discord: { tokenEnv: "RANGER_DISCORD_TOKEN", channelId: "1234567890" },
  }],
  bot: { identity: BOT },
  principal: { login: { "github:github.com": "boss", "gitlab:gitlab.example.org": "boss-gl" } },
  auth: { defaultWriteTokenEnv: "RANGER_WRITE_TEST" },
  state: { journalPath: join(dir, "state.sqlite") },
 }));
 const config = loadConfig(configPath).config;
 const journal = openJournal(config);
 return { config, map: config.maps[0], journal, close() { journal.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function change(repo: string, over: Partial<ChangeRequest> = {}): ChangeRequest {
 return {
  iid: MR, state: "merged", draft: false, title: "Name MRs the way their forge does (node #129)",
  headRef: "node/129-x", headSha: HEAD, baseRef: "main", mergeState: "mergeable",
  mergeCommitSha: "d".repeat(40), mergedBy: BOT, author: BOT,
  webUrl: repo === GITHUB ? `https://github.com/${repo}/pull/${MR}` : `https://gitlab.example.org/claw/crisis-simulator/-/merge_requests/${MR}`,
  ...over,
 };
}

function implementCtx(r: ReturnType<typeof rig>, ratify: "auto" | "merge"): ImplementContext {
 const node = {
  repo: r.map.repo, ref: { id: NODE }, status: "open", assignees: [], blockedBy: [], author: "boss", typed: true,
  url: "unused", node: { title: "Name MRs and nodes the way their forge does" },
 } as unknown as NodeResult;
 return { config: r.config, map: r.map, journal: r.journal, node, rootNode: node, ratify } as unknown as ImplementContext;
}

const REVIEW: RecordedReview = { round: 2, sha: HEAD, blockers: 0, majors: 0, nits: 1, body: "" };
const PROBE: RecordedProbe = { sha: HEAD, passed: true, selected: "3", mode: "semantic" };

function greenCi(repo: string): Extract<CiVerdict, { state: "green" }> {
 return repo === GITHUB
  ? { state: "green", runId: 901, runUrl: `https://github.com/${repo}/runs/901`, runName: "build", snapshot: "" }
  : { state: "green", runId: 901, runUrl: "https://gitlab.example.org/claw/crisis-simulator/-/pipelines/901", runName: "pipeline 901", snapshot: "" };
}

/** Every implement-lane body and receipt for one forge. */
function implementTexts(repo: string): Record<string, string> {
 const out: Record<string, string> = {};
 for (const ratify of ["auto", "merge"] as const) {
  for (const autoMerge of [false, true]) {
   const r = rig(repo, { autoMerge, probe: true });
   try {
    const ctx = implementCtx(r, ratify);
    const tag = `${ratify}/${autoMerge ? "autoMerge" : "manual"}`;
    out[`draft ${tag}`] = draftBody(ctx);
    out[`ready ${tag}`] = readyBody(ctx, REVIEW, 2, PROBE);
    out[`close ${tag}`] = closeResolution(ctx, change(repo), REVIEW, 2, greenCi(repo), PROBE);
    out[`close principal ${tag}`] = closeResolution(ctx, change(repo, { mergedBy: repo === GITHUB ? "boss" : "boss-gl" }), undefined, 0, greenCi(repo));
    out[`close no url ${tag}`] = closeResolution(ctx, change(repo, { webUrl: "" }), REVIEW, 2, greenCi(repo));
   } finally { r.close(); }
  }
 }
 out.gist = gistLine(repo, "Name MRs and nodes the way their forge does", MR);
 const r = rig(repo);
 try {
  out.fixNode = fixNodeSpec(implementCtx(r, "auto"), "probe-hud.mjs", ["draws"], HEAD, { number: MR, url: change(repo).webUrl }).body ?? "";
 } finally { r.close(); }
 return out;
}

const review = (sha: string, blockers = 0, majors = 0, round = 3): IssueComment => ({
 id: 10 + round, author: BOT, body: `<!-- ranger:review round=${round} sha=${sha} blockers=${blockers} majors=${majors} nits=0 -->`,
});

function fakeForge(repo: string, over: Partial<ChangeRequest>, comments: IssueComment[]): ForgePort {
 const forbidden = (name: string) => async () => { throw new Error(`unexpected forge call: ${name}`); };
 return {
  findPrByHead: forbidden("findPrByHead"), createDraftPr: forbidden("createDraftPr"), updatePrBody: forbidden("updatePrBody"),
  markReady: forbidden("markReady"), postComment: forbidden("postComment"),
  getPr: async () => change(repo, { state: "open", mergedBy: null, mergeCommitSha: null, ...over }),
  listComments: async () => comments,
  ciVerdictFor: async () => greenCi(repo),
  issueLabels: async () => [],
  mergePr: async () => ({ status: "merged" as const }),
 };
}

/** Every merge-desk card and journal line for one forge. */
async function mergeDeskTexts(repo: string): Promise<Record<string, string[]>> {
 const out: Record<string, string[]> = {};
 const scenarios: [string, { autoMerge?: boolean }, Partial<WorkerRow>, Partial<ChangeRequest>][] = [
  ["merge needed", {}, {}, {}],
  ["merge needed, no url", {}, {}, { webUrl: "" }],
  ["merged", { autoMerge: true }, {}, {}],
  ["withdrawn", {}, { mergeMessageId: "m-1" }, { mergeState: "conflict" }],
  ["declined", {}, {}, { state: "closed" }],
  ["merged elsewhere", {}, {}, { state: "merged" }],
  ["no pr", {}, { prNumber: null }, {}],
 ];
 for (const [name, map, row, pr] of scenarios) {
  const r = rig(repo, map);
  try {
   r.journal.upsertWorker({
    root: 97, nodeId: NODE, repo: r.map.repo, lane: "implement", status: "awaiting-merge", phase: "awaiting-merge",
    prNumber: MR, verdictSha: HEAD, verdictBlockers: 0,
   });
   if (Object.keys(row).length > 0) r.journal.updateWorker(NODE, r.map.repo, row);
   const posts: string[] = [];
   await runMergeDesk({
    config: r.config, journal: r.journal, map: r.map, token: "unused", botIdentity: BOT,
    github: fakeForge(repo, pr, [review(HEAD)]),
    post: async (content) => { posts.push(content); return `msg-${posts.length}`; },
    spawn: async () => 4242,
   });
   out[name] = [...posts, ...r.journal.listNodeEvents(r.map.repo, NODE).map((e) => `${e.kind}: ${e.detail}`).reverse()];
  } finally { r.close(); }
 }
 return out;
}

function parkedTexts(repo: string): { queue: string[]; needsYou: unknown[] } {
 const queue = resumeQueueViews(
  [{ id: 1, repo, nodeId: NODE, root: 97, lane: "headless", queuedAt: "2026-10-09T10:00:00Z", failedStarts: 0 }],
  () => "t",
 ).headless.map((v) => v.url);
 const worker = {
  nodeId: NODE, root: 97, repo, pid: null, status: "parked", attempts: 0, worktree: null, startedAt: null,
  finishedAt: "2026-10-09T10:00:00Z", outcome: "x", messageId: null, lane: "implement", generation: 1, workerPgid: null,
  phase: "review", prNumber: MR, researchBaseSha: null, reviewRound: 1, verdictSha: null, verdictBlockers: 0,
  mergeMessageId: null, substrate: null,
 } as unknown as WorkerRow;
 const needsYou = needsYouEntries({
  maps: [{ key: `${repo}#97`, repo, root: 97 }], workers: [worker], events: () => [], labels: () => [],
  prs: () => null, titleOf: () => "t", reviewRounds: 3, exists: () => false,
 }).map((e) => ({ url: e.url, pr: e.pr?.url }));
 return { queue, needsYou };
}

describe("node #129 — GitHub renderings stay byte-identical", () => {
 test("implement-lane bodies and receipts", () => {
  expect(implementTexts(GITHUB)).toMatchInlineSnapshot(`
    {
      "close auto/autoMerge": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Ratification: auto node; declared probes and CI.
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close auto/manual": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Ratification: auto node; declared probes and CI.
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close merge/autoMerge": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Ratification: ivy-bot merged PR #42 under the principal's standing grant (2026-10-03: ranger merges nodes that need no visual judgment).
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close merge/manual": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Ratification: ivy-bot merged PR #42 under the principal's standing grant (2026-10-03: ranger merges nodes that need no visual judgment).
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close no url auto/autoMerge": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: not recorded at this head.
    - Ratification: auto node; declared probes and CI.
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close no url auto/manual": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: not recorded at this head.
    - Ratification: auto node; declared probes and CI.
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close no url merge/autoMerge": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: not recorded at this head.
    - Ratification: ivy-bot merged PR #42 under the principal's standing grant (2026-10-03: ranger merges nodes that need no visual judgment).
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close no url merge/manual": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by ivy-bot as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: 2 offline round(s); the last at cccccccc found 0 blockers, 0 majors, 1 nits (machine evidence).
    - Probes: not recorded at this head.
    - Ratification: ivy-bot merged PR #42 under the principal's standing grant (2026-10-03: ranger merges nodes that need no visual judgment).
    - Unfixed review findings: 0 blocker(s), 0 major(s) and 1 nit(s) from the last sage round are on the PR and not filed back yet (the Scribe, design §6, is a follow-up)."
    ,
      "close principal auto/autoMerge": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by boss as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: no recorded review round.
    - Probes: not recorded at this head.
    - Ratification: auto node; declared probes and CI.
    - Unfixed review findings: None."
    ,
      "close principal auto/manual": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by boss as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: no recorded review round.
    - Probes: not recorded at this head.
    - Ratification: auto node; declared probes and CI.
    - Unfixed review findings: None."
    ,
      "close principal merge/autoMerge": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by boss as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: no recorded review round.
    - Probes: not recorded at this head.
    - Ratification: the principal merged PR #42 (merge = ratification, #23 ruling).
    - Unfixed review findings: None."
    ,
      "close principal merge/manual": 
    "Implemented by ranger's implement lane in PR #42 (https://github.com/acme/widgets/pull/42), merged by boss as dddddddd.

    - Tests: \`bun test\` passed in the supervisor before every push. CI check run "build" (901) succeeded on the PR head cccccccc.
    - Sage: no recorded review round.
    - Probes: not recorded at this head.
    - Ratification: the principal merged PR #42 (merge = ratification, #23 ruling).
    - Unfixed review findings: None."
    ,
      "draft auto/autoMerge": 
    "Draft by ranger's implement lane for orienteer node acme/widgets #129.

    Ranger reviews this draft with sage (offline) before marking it ready. The real
    description replaces this text then."
    ,
      "draft auto/manual": 
    "Draft by ranger's implement lane for orienteer node acme/widgets #129.

    Ranger reviews this draft with sage (offline) before marking it ready. The real
    description replaces this text then."
    ,
      "draft merge/autoMerge": 
    "Draft by ranger's implement lane for orienteer node acme/widgets #129.

    Ranger reviews this draft with sage (offline) before marking it ready. The real
    description replaces this text then."
    ,
      "draft merge/manual": 
    "Draft by ranger's implement lane for orienteer node acme/widgets #129.

    Ranger reviews this draft with sage (offline) before marking it ready. The real
    description replaces this text then."
    ,
      "fixNode": 
    "## Deliverable

    \`probe-hud.mjs\` passes on \`main\` again.

    ## Found by probe

    Node #129 failed \`probe-hud.mjs\` at its head, and two runs at its merge base \`cccccccc\` failed the same checks: the failure was the base's, not the branch's. Later PRs off that merge base inherit these checks from ranger's cache instead of gating on them. The runs were at the merge base, not at \`main\`'s tip, which may have moved since. Ranger filed this node.

    - Probe: \`probe-hud.mjs\`
    - Merge base: \`cccccccccccccccccccccccccccccccccccccccc\`
    - Detected by: node #129, PR #42 (https://github.com/acme/widgets/pull/42)
    - Failing checks at the merge base:

    \`\`\`
    draws
    \`\`\`

    ## Acceptance criteria

    - Given \`main\` with the fix, when \`probe-hud.mjs\` runs, then every check above passes.

    ## Out of scope

    - Ranger does not close this node when the probe goes green."
    ,
      "gist": "Name MRs and nodes the way their forge does — PR #42",
      "ready auto/autoMerge": 
    "Implements orienteer node acme/widgets #129: Name MRs and nodes the way their forge does

    - Tests: \`bun test\` passed in the supervisor before every push.
    - Sage: 2 offline round(s); the last, at \`cccccccc\`, found 0 blockers, 0 majors, 1 nits. Machine review evidence, not a human sign-off.
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Merge: ranger never merges. Ranger squash-merges this itself once the gate passes, unless the node is labelled \`ranger:needs-eye\`; then the principal merges by hand. Ranger closes the node after the merge.

    Squash-merge keeps one commit per node. The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate."
    ,
      "ready auto/manual": 
    "Implements orienteer node acme/widgets #129: Name MRs and nodes the way their forge does

    - Tests: \`bun test\` passed in the supervisor before every push.
    - Sage: 2 offline round(s); the last, at \`cccccccc\`, found 0 blockers, 0 majors, 1 nits. Machine review evidence, not a human sign-off.
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Merge: ranger never merges. Ranger closes the node after the merge, through its declared probes and this PR's CI run.

    Squash-merge keeps one commit per node. The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate."
    ,
      "ready merge/autoMerge": 
    "Implements orienteer node acme/widgets #129: Name MRs and nodes the way their forge does

    - Tests: \`bun test\` passed in the supervisor before every push.
    - Sage: 2 offline round(s); the last, at \`cccccccc\`, found 0 blockers, 0 majors, 1 nits. Machine review evidence, not a human sign-off.
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Merge: ranger never merges. Ranger squash-merges this itself once the gate passes, unless the node is labelled \`ranger:needs-eye\`; then the principal merges by hand. For this \`propose\` node the merge is the ratification. Ranger closes the node after the merge.

    Squash-merge keeps one commit per node. The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate."
    ,
      "ready merge/manual": 
    "Implements orienteer node acme/widgets #129: Name MRs and nodes the way their forge does

    - Tests: \`bun test\` passed in the supervisor before every push.
    - Sage: 2 offline round(s); the last, at \`cccccccc\`, found 0 blockers, 0 majors, 1 nits. Machine review evidence, not a human sign-off.
    - Probes: passed at \`cccccccc\` (selection semantic, 3 probe(s)). Only the selected probes ran, not the full suite.
    - Merge: ranger never merges. This node is \`propose\`: **merging this PR is the ratification**. Ranger closes the node after the merge.

    Squash-merge keeps one commit per node. The node is not referenced with a closing keyword on purpose: the close goes through the graph's gate."
    ,
    }
  `);
 });

 test("merge-desk cards and journal lines", async () => {
  expect(await mergeDeskTexts(GITHUB)).toMatchInlineSnapshot(`
    {
      "declined": [
        
    ":ranger: **parked** #129 — PR #42 https://github.com/acme/widgets/pull/42
    map: acme/widgets#97 · PR #42
    PR #42 was closed without merging — declined; ranger will not reopen or re-propose it"
    ,
        "parked: PR #42 was closed without merging — declined; ranger will not reopen or re-propose it",
      ],
      "merge needed": [
        
    ":ranger: **merge needed** #129 — PR #42 https://github.com/acme/widgets/pull/42
    map: acme/widgets#97
    Gate passed at \`cccccccc\`: CI green, mergeable, base \`main\`, sage 3 round(s), the last with 0 blockers and 0 majors (machine evidence, not a sign-off).
    No probe tier on this map: CI and the tests are the only automated checks.
    Merge it by hand (squash). For a \`propose\` node your merge is the ratification. Ranger closes the node after the merge; it never merges itself."
    ,
        "merge-card: PR #42, message msg-1",
      ],
      "merge needed, no url": [
        
    ":ranger: **merge needed** #129 — PR #42
    map: acme/widgets#97
    Gate passed at \`cccccccc\`: CI green, mergeable, base \`main\`, sage 3 round(s), the last with 0 blockers and 0 majors (machine evidence, not a sign-off).
    No probe tier on this map: CI and the tests are the only automated checks.
    Merge it by hand (squash). For a \`propose\` node your merge is the ratification. Ranger closes the node after the merge; it never merges itself."
    ,
        "merge-card: PR #42, message msg-1",
      ],
      "merged": [
        
    ":ranger: **merged** #129 — PR #42 https://github.com/acme/widgets/pull/42
    Gate passed at \`cccccccc\` (CI, mergeable, sage 0 blockers / 0 majors); squash-merged by ranger. The node closes through the gate next."
    ,
        "merged: PR #42 squash-merged by ranger at cccccccc (no ranger:needs-eye label; standing grant 2026-10-03)",
      ],
      "merged elsewhere": [
        "sweep: PR #42 merged — resuming at the close phase (pid 4242)",
      ],
      "no pr": [
        
    ":ranger: **parked** #129 — node 129
    map: acme/widgets#97
    awaiting merge with no PR recorded — journal and GitHub disagree"
    ,
        "parked: awaiting merge with no PR recorded — journal and GitHub disagree",
      ],
      "withdrawn": [
        
    ":ranger: **merge card withdrawn** #129 — PR #42 https://github.com/acme/widgets/pull/42
    Do not merge yet: PR #42 conflicts with main at cccccccc. Ranger reworks it; a new merge card follows when the PR is clean."
    ,
        "sweep: PR #42: PR #42 conflicts with main at cccccccc — run-node resumes (pid 4242)",
      ],
    }
  `);
 });

 test("serve-parked links", () => {
  expect(parkedTexts(GITHUB)).toMatchInlineSnapshot(`
    {
      "needsYou": [
        {
          "pr": "https://github.com/acme/widgets/pull/42",
          "url": "https://github.com/acme/widgets/issues/129",
        },
      ],
      "queue": [
        "https://github.com/acme/widgets/issues/129",
      ],
    }
  `);
 });
});

/** Every string a GitLab render produced, flattened. */
function strings(value: unknown): string[] {
 if (typeof value === "string") return [value];
 if (Array.isArray(value)) return value.flatMap(strings);
 if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
 return [];
}

/** The MR is !42 and the node #129: a `#42` anywhere would name issue 42 on GitLab. */
function expectGitLabNaming(texts: string[]): void {
 expect(texts.length).toBeGreaterThan(0);
 for (const text of texts) {
  expect(text).not.toContain(`#${MR}`);
  expect(text).not.toMatch(/\bPRs?\b/);
  expect(text).not.toContain("github.com");
  expect(text).not.toContain("GitHub");
  expect(text).not.toContain("check run");
 }
}

describe("node #129 — GitLab renderings name an MR !N with GitLab URLs", () => {
 test("implement-lane bodies and receipts", () => {
  const texts = implementTexts(GITLAB);
  expectGitLabNaming(strings(texts));
  expect(texts["close merge/manual"]).toContain(
   "Implemented by ranger's implement lane in MR !42 (https://gitlab.example.org/claw/crisis-simulator/-/merge_requests/42), merged by ivy-bot",
  );
  expect(texts["close merge/manual"]).toContain("CI pipeline 901 succeeded on the MR head cccccccc.");
  expect(texts["close merge/manual"]).toContain("ivy-bot merged MR !42 under the principal's standing grant");
  expect(texts["close principal merge/manual"]).toContain("the principal merged MR !42 (merge = ratification");
  expect(texts["close no url auto/manual"]).toContain("(https://gitlab.example.org/claw/crisis-simulator/-/merge_requests/42)");
  expect(texts["ready merge/manual"]).toContain("**merging this MR is the ratification**");
  expect(texts["ready auto/manual"]).toContain("this MR's CI run");
  expect(texts.gist).toBe("Name MRs and nodes the way their forge does — MR !42");
  expect(texts.fixNode).toContain("- Detected by: node #129, MR !42 (https://gitlab.example.org/claw/crisis-simulator/-/merge_requests/42)");
  expect(texts.fixNode).toContain("Later MRs off that merge base");
  // Nodes are issues on GitLab too: `#N` stays.
  expect(texts["draft auto/manual"]).toContain(`orienteer node ${GITLAB} #129`);
 });

 test("merge-desk cards and journal lines", async () => {
  const texts = await mergeDeskTexts(GITLAB);
  expectGitLabNaming(strings(texts));
  expect(texts["merge needed"]![0]).toStartWith(
   ":ranger: **merge needed** #129 — MR !42 https://gitlab.example.org/claw/crisis-simulator/-/merge_requests/42\n",
  );
  expect(texts["merge needed, no url"]![0]).toStartWith(":ranger: **merge needed** #129 — MR !42\n");
  expect(texts.merged).toContain("merged: MR !42 squash-merged by ranger at cccccccc (no ranger:needs-eye label; standing grant 2026-10-03)");
  expect(texts.withdrawn![0]).toContain("Do not merge yet: MR !42 conflicts with main at cccccccc. Ranger reworks it; a new merge card follows when the MR is clean.");
  expect(texts.declined![0]).toContain(`map: ${GITLAB}#97 · MR !42\nMR !42 was closed without merging`);
  expect(texts["merged elsewhere"]).toEqual(["sweep: MR !42 merged — resuming at the close phase (pid 4242)"]);
  expect(texts["no pr"]).toContain("parked: awaiting merge with no MR recorded — journal and GitLab disagree");
 });

 test("serve-parked links", () => {
  expect(parkedTexts(GITLAB)).toEqual({
   queue: ["https://gitlab.example.org/claw/crisis-simulator/-/issues/129"],
   needsYou: [{
    url: "https://gitlab.example.org/claw/crisis-simulator/-/issues/129",
    pr: "https://gitlab.example.org/claw/crisis-simulator/-/merge_requests/42",
   }],
  });
 });
});

describe("node #129 — the forge-text module", () => {
 const GL = "https://gitlab.example.org/claw/crisis-simulator";
 test("GitHub: PR #N, github.com URLs, check runs", () => {
  expect([forgeName(GITHUB), changeRequestNoun(GITHUB), changeRequestRef(GITHUB, 7), changeRequestLabel(GITHUB, 7)])
   .toEqual(["GitHub", "PR", "#7", "PR #7"]);
  expect(changeRequestUrl(GITHUB, 7)).toBe("https://github.com/acme/widgets/pull/7");
  expect(nodeUrl(GITHUB, "129")).toBe("https://github.com/acme/widgets/issues/129");
  expect(ciRunUrl(GITHUB, 901)).toBe("https://github.com/acme/widgets/runs/901");
  expect(nodeCommentUrl(GITHUB, "https://github.com/acme/widgets/issues/129", 5)).toBe("https://github.com/acme/widgets/issues/129#issuecomment-5");
  expect(ciRunNoun(GITHUB)).toBe("check run");
  expect(ciRunText(GITHUB, { runId: 901, runName: "build" }, "receipt")).toBe(`check run "build" (901)`);
  expect(ciRunText(GITHUB, { runId: 901, runName: "build" }, "summary")).toBe("check run build");
  // A qualified GitHub ref names the same repository the same way.
  expect(changeRequestUrl("github:github.com/acme/widgets", 7)).toBe("https://github.com/acme/widgets/pull/7");
 });

 test("GitLab: MR !N, /-/ URLs on the map's host, pipelines", () => {
  expect([forgeName(GITLAB), changeRequestNoun(GITLAB), changeRequestRef(GITLAB, 7), changeRequestLabel(GITLAB, 7)])
   .toEqual(["GitLab", "MR", "!7", "MR !7"]);
  expect(changeRequestUrl(GITLAB, 7)).toBe(`${GL}/-/merge_requests/7`);
  expect(nodeUrl(GITLAB, "129")).toBe(`${GL}/-/issues/129`);
  expect(ciRunUrl(GITLAB, 901)).toBe(`${GL}/-/pipelines/901`);
  expect(nodeCommentUrl(GITLAB, `${GL}/-/issues/129`, 5)).toBe(`${GL}/-/issues/129#note_5`);
  expect(ciRunNoun(GITLAB)).toBe("pipeline");
  expect(ciRunText(GITLAB, { runId: 901, runName: "pipeline 901" }, "receipt")).toBe("pipeline 901");
  expect(ciRunText(GITLAB, { runId: 901, runName: "pipeline 901" }, "summary")).toBe("pipeline 901");
 });

 test("an API web_url wins over the built URL; an empty one does not", () => {
  for (const repo of [GITHUB, GITLAB]) {
   expect(changeRequestUrl(repo, 7, "https://proxy.example/mr/7")).toBe("https://proxy.example/mr/7");
   expect(nodeUrl(repo, 1, "https://proxy.example/i/1")).toBe("https://proxy.example/i/1");
   expect(ciRunUrl(repo, 9, "https://proxy.example/p/9")).toBe("https://proxy.example/p/9");
   expect(changeRequestUrl(repo, 7, "")).toBe(changeRequestUrl(repo, 7));
  }
 });

 test("park outcomes name the MR !N on GitLab, and ranger's parsers still read them", () => {
  const capMoved = reviewCapHeadMovedOutcome({ repo: GITLAB, rounds: 2, pr: MR });
  expect(capMoved).toContain("on MR !42");
  expect(capMoved).toMatch(REVIEW_CAP_HEAD_MOVED_OUTCOME);
  expect(capMoved).toMatch(REVIEW_CAP_OUTCOME);
  const cap = reviewCapOutcome({ repo: GITLAB, blockers: 1, majors: 0, round: 3, pr: MR });
  expect(cap).toContain("on MR !42");
  expect(cap).toMatch(REVIEW_CAP_OUTCOME);
  expect(baseConflictOutcome({ repo: GITLAB, pr: MR, base: "main", passes: 2 })).toStartWith("MR !42 conflicts with main");
  const probes = probesFailedOutcome({ repo: GITLAB, sha: HEAD, pr: MR, exit: -1, failed: [], failureClass: "infrastructure", tail: "lock" });
  expect(probes).toStartWith("browser probes failed twice at cccccccc on MR !42 (exit -1)");
  expect(infrastructureProbeHead(probes)).toBe(HEAD);
  for (const text of [capMoved, cap, probes]) expect(text).not.toContain(`#${MR}`);
  // GitHub keeps its bytes.
  expect(reviewCapHeadMovedOutcome({ repo: GITHUB, rounds: 2, pr: MR })).toMatch(/^review cap reached: 2 sage round\(s\) on PR #42 and/);
 });

 test("no hand-built github.com URL remains outside the forge-text module", () => {
  const src = join(import.meta.dir, "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
   const path = join(dir, name);
   return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
  // A forge web URL, hand-built: GitHub's host, or a change-request, issue or CI path segment.
  const built = ["https://github.com", "github.com/${", "/pull/${", "/runs/${", "/-/merge_requests/", "/-/issues/", "/-/pipelines/"];
  const hits = files(src).flatMap((path) => {
   const text = readFileSync(path, "utf8");
   return built.filter((pattern) => text.includes(pattern)).map((pattern) => `${path.slice(src.length + 1)}: ${pattern}`);
  });
  // The module itself builds every forge path, so the scan is not vacuous.
  expect(hits).toEqual(["/pull/${", "/runs/${", "/-/merge_requests/", "/-/issues/", "/-/pipelines/"].map((pattern) => `forge-text.ts: ${pattern}`));
 });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import * as exec from "../src/exec.ts";
import { runCmd } from "../src/exec.ts";
import { GraphAddUnattached, graphAdd, graphLink, GraphWriteError, type AddSpec } from "../src/graph-write.ts";
import { closeResolution, scribeAfterMerge, type ImplementContext, type RecordedReview } from "../src/implement.ts";
import { FencedError, Journal } from "../src/journal.ts";
import {
 assertFilable,
 codeCommentSpec,
 commentSyntax,
 landminesInDiff,
 lineHasMarkerComment,
 scribeFile,
 scribeKey,
 ScribeError,
 splitOutOfReviewSpec,
 type ScribeGraph,
} from "../src/scribe.ts";
import { openDb } from "../src/store/db.ts";
import { seedLegacyRoots } from "../src/store/legacy-roots.ts";
import { baseConfigLines, createCanonicalRepo, GIT_ENV } from "./support.ts";

const MAP = { repo: "acme/widgets", root: 9 };
const SPEC: AddSpec = { title: "Do the thing", autonomy: "propose", kind: "build", labels: ["orienteer:build"], checkpoint: "thing-done" };

interface FakeNode {
 parent: string | null;
 blockedBy: string[];
 autonomy: string;
 checkpointId?: string;
}

/** A tracker the Scribe writes to; flags reproduce the documented partial-write shapes. */
function fakeGraph() {
 const nodes = new Map<string, FakeNode>();
 const calls: string[] = [];
 const state = { next: 300, unattach: false, dropEdges: false, mintCheckpoint: undefined as string | undefined, addFails: null as Error | null, linkIgnores: false };
 const graph: ScribeGraph = {
  add: async (parent, spec) => {
   calls.push(`add ${parent}`);
   if (state.addFails !== null) throw state.addFails;
   const node = String(state.next++);
   nodes.set(node, {
    parent: state.unattach ? null : parent,
    blockedBy: state.dropEdges ? [] : [...(spec.blockedBy ?? [])],
    autonomy: spec.autonomy,
    checkpointId: state.mintCheckpoint ?? spec.checkpoint,
   });
   if (state.unattach) throw new GraphAddUnattached(`created ${node} but left it unattached`, node, parent);
   return { node };
  },
  link: async (node, parent, blockedBy) => {
   calls.push(`link ${node} ${parent} [${blockedBy.join(",")}]`);
   const n = nodes.get(node)!;
   if (state.linkIgnores) return;
   n.parent = parent;
   n.blockedBy = [...new Set([...n.blockedBy, ...blockedBy])];
  },
  node: async (id) => {
   calls.push(`node ${id}`);
   const n = nodes.get(id);
   if (n === undefined) throw new Error(`no node ${id}`);
   return {
    ...(n.parent === null ? {} : { parent: { id: n.parent } }),
    blockedBy: n.blockedBy.map((b) => ({ id: b, status: "open" })),
    node: { id, title: "", kind: "build", autonomy: n.autonomy, ...(n.checkpointId === undefined ? {} : { checkpointId: n.checkpointId }) },
   };
  },
 };
 return { graph, nodes, calls, state };
}

function memoryJournal(dir: string): Journal {
 return new Journal(join(dir, "journal.sqlite"), openDb(":memory:", (db) => seedLegacyRoots(db, [], {})));
}

describe("the Scribe's rules (design §6, node #24)", () => {
 test("refuses auto, a blank checkpoint, the map root and a blocker that is the parent", () => {
  expect(() => assertFilable(MAP, "24", { ...SPEC, autonomy: "auto" })).toThrow(/propose at minimum/);
  expect(() => assertFilable(MAP, "24", { ...SPEC, checkpoint: "  " })).toThrow(/without a checkpoint/);
  expect(() => assertFilable(MAP, "9", SPEC)).toThrow(/on the map root #9/);
  expect(() => assertFilable(MAP, "24", { ...SPEC, blockedBy: ["24"] })).toThrow(/blocked by its own parent/);
  expect(() => assertFilable(MAP, "24", { ...SPEC, autonomy: "approve", blockedBy: ["12"] })).not.toThrow();
 });

 test("graphAdd passes the blocking edges, graphLink wires missing ones before the parent", async () => {
  const seen: string[][] = [];
  const spy = spyOn(exec, "runCmd").mockImplementation(async (cmd, args, opts) => {
   expect(cmd).toBe("soma");
   expect(opts?.env?.GH_TOKEN).toBe("ghp_machine");
   seen.push(args);
   return args[1] === "add"
    ? { code: 0, stdout: JSON.stringify({ repo: "acme/widgets", node: "300", parent: "24", blockedBy: ["12"] }), stderr: "" }
    : { code: 0, stdout: JSON.stringify({ node: "300", parent: "24", parentStatus: "already" }), stderr: "" };
  });
  try {
   expect(await graphAdd("acme/widgets", "24", { ...SPEC, blockedBy: ["12", "13"] }, "ghp_machine")).toEqual({ repo: "acme/widgets", node: "300", parent: "24" });
   await graphLink("acme/widgets", "300", "24", "ghp_machine", { blockedBy: ["13"] });
   expect(seen[0].join(" ")).toContain("--blocked-by 12 --blocked-by 13 --repo");
   expect(seen[1]).toEqual(["graph", "link", "300", "--blocked-by", "13", "--parent", "24", "--repo", "github:github.com/acme/widgets", "--json"]);
  } finally {
   spy.mockRestore();
  }
 });
});

describe("scribeFile: add, record, re-read, repair", () => {
 let dir: string;
 let journal: Journal;
 beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ranger-scribe-test-"));
  journal = memoryJournal(dir);
 });
 afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
 });
 const filing = (spec: AddSpec = SPEC) => ({ map: MAP, parent: "24", provenance: "split-out-of-review" as const, spec });
 const record = () => JSON.parse(journal.getHealth(scribeKey(MAP, "24", "split-out-of-review"))!);

 test("files below the spawning node, re-reads it, and files nothing the second time", async () => {
  const { graph, nodes, calls } = fakeGraph();
  expect(await scribeFile(graph, journal, filing({ ...SPEC, blockedBy: ["12"] }))).toEqual({ node: "300", added: true });
  expect(nodes.get("300")).toMatchObject({ parent: "24", blockedBy: ["12"], autonomy: "propose", checkpointId: "thing-done" });
  expect(record()).toEqual({ node: "300", parent: "24", verified: true });
  expect(calls).toEqual(["add 24", "node 300"]);
  expect(await scribeFile(graph, journal, filing())).toEqual({ node: "300", added: false });
  expect(calls).toHaveLength(2);
 });

 test("an add that leaves the node unattached is linked below its parent, not added again", async () => {
  const { graph, nodes, calls, state } = fakeGraph();
  state.unattach = true;
  expect(await scribeFile(graph, journal, filing())).toEqual({ node: "300", added: true });
  expect(nodes.get("300")?.parent).toBe("24");
  expect(calls).toEqual(["add 24", "node 300", "link 300 24 []", "node 300"]);
 });

 test("a blocking edge the re-read does not show is wired with link", async () => {
  const { graph, nodes, calls, state } = fakeGraph();
  state.dropEdges = true;
  await scribeFile(graph, journal, filing({ ...SPEC, blockedBy: ["12", "13"] }));
  expect(nodes.get("300")?.blockedBy).toEqual(["12", "13"]);
  expect(calls).toContain("link 300 24 [12,13]");
 });

 test("wiring the link cannot repair fails the filing, and the retry re-reads the recorded node", async () => {
  const { graph, calls, state } = fakeGraph();
  state.unattach = true;
  state.linkIgnores = true;
  await expect(scribeFile(graph, journal, filing())).rejects.toThrow(/re-read shows its parent is none, not #24/);
  expect(record()).toEqual({ node: "300", parent: "24" });
  state.linkIgnores = false;
  expect(await scribeFile(graph, journal, filing())).toEqual({ node: "300", added: false });
  expect(calls.filter((c) => c.startsWith("add"))).toHaveLength(1);
 });

 test("a checkpoint other than the one filed fails the filing: no verb changes it", async () => {
  const { graph, state } = fakeGraph();
  state.mintCheckpoint = "something-else";
  await expect(scribeFile(graph, journal, filing())).rejects.toThrow(ScribeError);
  await expect(scribeFile(graph, journal, filing())).rejects.toThrow(/checkpoint is something-else, not thing-done/);
 });

 test("a fence that throws stops the filing before the add", async () => {
  const { graph, calls } = fakeGraph();
  await expect(scribeFile(graph, journal, filing(), () => { throw new FencedError("superseded"); })).rejects.toThrow(FencedError);
  expect(calls).toEqual([]);
  expect(journal.getHealth(scribeKey(MAP, "24", "split-out-of-review"))).toBeNull();
 });

 test("a refused filing writes nothing", async () => {
  const { graph, calls } = fakeGraph();
  await expect(scribeFile(graph, journal, { ...filing(), parent: "9" })).rejects.toThrow(/map root/);
  expect(calls).toEqual([]);
 });
});

describe("landminesInDiff", () => {
 test("finds marker comments the diff adds, with the new file's line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-landmine-test-"));
  try {
   const git = (args: string[]) => runCmd("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV } });
   await git(["init", "-b", "main"]);
   writeFileSync(join(dir, "a.ts"), "one\ntwo\n// TODO: old one\n");
   writeFileSync(join(dir, "gone.ts"), "// FIXME: leaves with the file\n");
   await git(["add", "-A"]);
   await git(["commit", "-m", "base"]);
   writeFileSync(join(dir, "a.ts"), "one\n// FIXME: new one\ntwo\n// TODO: old one\nconst s = \"TODO not a comment\";\n");
   writeFileSync(join(dir, "b.py"), "x = 1\n# HACK until the API lands\n");
   writeFileSync(join(dir, "c.md"), "++ text\n<!-- XXX: check this -->\n# TODO\n* FIXME the list item\n");
   writeFileSync(join(dir, "d.ts"), 'const help = "Use // TODO to mark pending work";\nconst example = " // TODO: example only";\n');
   writeFileSync(join(dir, "notes.txt"), "// TODO: unknown language\n");
   rmSync(join(dir, "gone.ts"));
   await git(["add", "-A"]);
   await git(["commit", "-m", "change"]);
   const diff = await git(["diff", "--unified=0", "HEAD^1", "HEAD"]);
   expect(landminesInDiff(diff.stdout)).toEqual([
    { path: "a.ts", line: 2, text: "// FIXME: new one" },
    { path: "b.py", line: 2, text: "# HACK until the API lands" },
    { path: "c.md", line: 2, text: "<!-- XXX: check this -->" },
   ]);
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});

describe("lineHasMarkerComment: comments only, read in the file's language", () => {
 const ts = commentSyntax("src/a.ts")!;
 test.each([
  "// TODO: real",
  "/// FIXME doc comment",
  "foo(); // HACK after code",
  "foo();// XXX no space",
  "/* TODO block */",
  " * FIXME continuation of a block",
  "/* a */ x = 1; // TODO after a closed block",
  'const s = "a \\" b"; // TODO after an escaped quote',
 ])("finds %p in TypeScript", (line) => expect(lineHasMarkerComment(line, ts)).toBe(true));
 test.each([
  'const help = "Use // TODO to mark pending work";',
  'const example = " // TODO: example only";',
  "const t = `/* FIXME */`;",
  "const c = '// XXX';",
  "// see TODO later",
  "*/ TODO",
  "# TODO not a TS comment",
 ])("ignores %p in TypeScript", (line) => expect(lineHasMarkerComment(line, ts)).toBe(false));
 test("Markdown: only an HTML comment counts, never a heading or list item", () => {
  const md = commentSyntax("docs/README.md")!;
  expect(lineHasMarkerComment("<!-- TODO: fill in -->", md)).toBe(true);
  expect(lineHasMarkerComment("# TODO", md)).toBe(false);
  expect(lineHasMarkerComment("## FIXME list", md)).toBe(false);
  expect(lineHasMarkerComment("* TODO item", md)).toBe(false);
  expect(lineHasMarkerComment("Use `// TODO` to mark work", md)).toBe(false);
 });
 test("hash, dash and semicolon leaders start a comment right after code", () => {
  const py = commentSyntax("a/b.py")!;
  expect(lineHasMarkerComment("x = 1  # TODO: real", py)).toBe(true);
  expect(lineHasMarkerComment("x = 1#TODO: remove temporary default", py)).toBe(true);
  expect(lineHasMarkerComment('s = "# TODO in a string"', py)).toBe(false);
  expect(lineHasMarkerComment("x = 1#TODO", commentSyntax("a.rb")!)).toBe(true);
  expect(lineHasMarkerComment("all:#TODO", commentSyntax("Makefile")!)).toBe(true);
  expect(lineHasMarkerComment("-- HACK", commentSyntax("q.sql")!)).toBe(true);
  expect(lineHasMarkerComment("x--TODO", commentSyntax("q.sql")!)).toBe(true);
  expect(lineHasMarkerComment(";; FIXME", commentSyntax("init.el")!)).toBe(true);
  expect(lineHasMarkerComment("(f x);TODO", commentSyntax("a.clj")!)).toBe(true);
 });
 test("shell, YAML and INI leaders inside a word are text, not a comment", () => {
  const sh = commentSyntax("x.sh")!;
  expect(lineHasMarkerComment("echo a#TODO", sh)).toBe(false);
  expect(lineHasMarkerComment("echo a # TODO: real", sh)).toBe(true);
  expect(lineHasMarkerComment("# FIXME", sh)).toBe(true);
  expect(lineHasMarkerComment("url: http://x/#TODO", commentSyntax("c.yaml")!)).toBe(false);
  expect(lineHasMarkerComment("RUN make a#TODO", commentSyntax("Dockerfile")!)).toBe(false);
  expect(lineHasMarkerComment("key=a;TODO", commentSyntax("c.ini")!)).toBe(false);
  expect(lineHasMarkerComment("; TODO", commentSyntax("c.ini")!)).toBe(true);
 });
 test("Rust lifetimes do not read as an unterminated string", () => {
  expect(lineHasMarkerComment("fn f(x: &'static str) {} // TODO", commentSyntax("lib.rs")!)).toBe(true);
 });
 test("a file name maps to its syntax; an unknown language has none", () => {
  expect(commentSyntax("Makefile")).toBe(commentSyntax("x.py"));
  expect(commentSyntax("sub/Dockerfile")).toBe(commentSyntax("x.sh"));
  expect(commentSyntax("notes.txt")).toBeNull();
  expect(commentSyntax("LICENSE")).toBeNull();
  expect(commentSyntax(".bashrc")).toBeNull();
 });
});

describe("scribeAfterMerge: the Scribe's pass before the close", () => {
 let dir: string;
 let ctx: ImplementContext;
 let fake: ReturnType<typeof fakeGraph>;
 let mergeSha: string;
 const REVIEW: RecordedReview = { round: 2, sha: "c".repeat(40), blockers: 0, majors: 1, nits: 2, body: "### Major\nguard `x`" };
 const pr = () => ({ iid: 42, webUrl: "https://github.com/acme/widgets/pull/42", mergeCommitSha: mergeSha });
 const events = () => ctx.journal.listEvents(ctx.map.repo, 50).filter((e) => e.kind === "filed").map((e) => e.detail ?? "");

 beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ranger-scribe-merge-test-"));
  const { canonical } = await createCanonicalRepo(dir);
  const git = (args: string[]) => runCmd("git", args, { cwd: canonical, env: { ...process.env, ...GIT_ENV } });
  writeFileSync(join(canonical, "shim.ts"), "export const shim = 1; // TODO: drop once node #30 lands\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "squash merge"]);
  mergeSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const configPath = join(dir, "ranger.yaml");
  writeFileSync(configPath, baseConfigLines(dir).join("\n"));
  const { config } = loadConfig(configPath);
  const map = config.maps[0];
  map.root = 9;
  const node = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/data/acme__widgets-node-1.json"), "utf8"));
  fake = fakeGraph();
  ctx = {
   config, map, node, rootNode: node, canonical, worktree: canonical,
   journal: memoryJournal(dir),
   token: "ghp_machine", readOnlyToken: "ghp_principal_read", botIdentity: "ivy-agent",
   branch: "main", generation: 0, ratify: "merge", sessionJournal: join(dir, "session.sqlite"),
   workerRun: async () => ({ code: 0, stdout: "", stderr: "" }),
   scribe: fake.graph,
  };
  ctx.journal.upsertWorker({ root: map.root, nodeId: node.ref.id, repo: map.repo, status: "claimed" });
  ctx.generation = ctx.journal.beginGeneration(node.ref.id, map.repo);
 });
 afterEach(() => {
  ctx.journal.close();
  rmSync(dir, { recursive: true, force: true });
 });

 test("files the review's findings and the merge's marker comments below the node, once", async () => {
  const filings = await scribeAfterMerge(ctx, pr(), REVIEW);
  expect(filings).toEqual({ review: { node: "300" }, landmines: { node: "301", count: 1 } });
  expect(fake.nodes.get("300")).toMatchObject({ parent: "1", autonomy: "propose", checkpointId: "review-findings-1-cccccccc" });
  expect(fake.nodes.get("301")).toMatchObject({ parent: "1", autonomy: "propose", checkpointId: `landmines-1-${mergeSha.slice(0, 8)}` });
  expect(events()).toEqual(expect.arrayContaining([
   "filed the last review's findings as node #300 below #1 (split-out-of-review)",
   "filed 1 marker comment(s) as node #301 below #1 (code-comment-graduated)",
  ]));
  // A resumed close finds both filings in the journal and adds nothing.
  expect(await scribeAfterMerge(ctx, pr(), REVIEW)).toEqual(filings);
  expect(fake.calls.filter((c) => c.startsWith("add"))).toHaveLength(2);
  const receipt = closeResolution(ctx, { ...pr(), headSha: "c".repeat(40), mergedBy: "ivy-agent", state: "merged" } as never, REVIEW, 2,
   { state: "green", runId: 1, runUrl: "u", runName: "build", snapshot: "" }, undefined, filings);
  expect(receipt).toContain("split out as node #300 below this node");
  expect(receipt).toContain("Marker comments: the merge added 1, filed as node #301 below this node.");
 });

 test("a clean review and a merge with no marker comments file nothing", async () => {
  const filings = await scribeAfterMerge(ctx, { ...pr(), mergeCommitSha: null }, { ...REVIEW, majors: 0, nits: 0 });
  expect(filings).toEqual({});
  expect(fake.calls).toEqual([]);
 });

 test("a nit-only round files nothing: the nits stay on the PR, journalled and named in the receipt", async () => {
  const nitsOnly = { ...REVIEW, majors: 0, nits: 9 };
  const filings = await scribeAfterMerge(ctx, { ...pr(), mergeCommitSha: null }, nitsOnly);
  expect(filings).toEqual({});
  expect(fake.calls).toEqual([]);
  expect(events()).toEqual([
   "left the last review's 9 nit(s) on PR #42 (https://github.com/acme/widgets/pull/42), not filed (nits only)",
  ]);
  const receipt = closeResolution(ctx, { ...pr(), headSha: "c".repeat(40), mergedBy: "ivy-agent", state: "merged" } as never, nitsOnly, 2,
   { state: "green", runId: 1, runUrl: "u", runName: "build", snapshot: "" }, undefined, filings);
  expect(receipt).toContain("- Unfixed review findings: 0 blocker(s), 0 major(s) and 9 nit(s) from the last sage round stay on the PR (https://github.com/acme/widgets/pull/42); nits are not filed back.");
 });

 test("a round that left a major files it below the node", async () => {
  const filings = await scribeAfterMerge(ctx, { ...pr(), mergeCommitSha: null }, { ...REVIEW, nits: 0 });
  expect(filings).toEqual({ review: { node: "300" } });
  expect(fake.nodes.get("300")).toMatchObject({ parent: "1", autonomy: "propose" });
 });

 test("a failed add is journalled and named, and the pass goes on", async () => {
  fake.state.addFails = new GraphWriteError("soma graph add below 1 failed (exit 1): boom");
  const filings = await scribeAfterMerge(ctx, pr(), REVIEW);
  expect(filings.review).toEqual({ error: "soma graph add below 1 failed (exit 1): boom" });
  expect(filings.landmines).toMatchObject({ count: 1, error: expect.stringContaining("boom") });
  expect(events().some((d) => d.startsWith("filing the last review's findings (split-out-of-review) FAILED"))).toBe(true);
 });

 test("an unreadable merge commit is named, not filed", async () => {
  const filings = await scribeAfterMerge(ctx, { ...pr(), mergeCommitSha: "f".repeat(40) }, undefined);
  expect(filings.landmines).toMatchObject({ unread: expect.stringContaining("git diff ffffffff^1 exited") });
  expect(fake.calls).toEqual([]);
 });

 test("a superseded supervisor files nothing", async () => {
  ctx.journal.beginGeneration(ctx.node.ref.id, ctx.map.repo);
  await expect(scribeAfterMerge(ctx, pr(), REVIEW)).rejects.toThrow(FencedError);
  expect(fake.calls).toEqual([]);
 });

 test("templates name their provenance and quote untrusted text in a fence it cannot close", () => {
  const spec = splitOutOfReviewSpec("acme/widgets", { id: "1", title: "t" }, { number: 42, url: "u" }, { ...REVIEW, body: "````\n@someone fixes #3" });
  expect(spec.body).toContain("Split out of node #1 (PR #42), raised in review and deliberately not done.");
  expect(spec.body).toContain("`````\n````\n@someone fixes #3\n`````");
  const comments = codeCommentSpec("acme/widgets", { id: "1", title: "t" }, { number: 42, url: "u" }, mergeSha,
   Array.from({ length: 60 }, (_, i) => ({ path: "a.ts", line: i + 1, text: "// TODO" })));
  expect(comments.body).toContain("added 60 marker comment(s)");
  expect(comments.body).toContain("… and 10 more");
  for (const s of [spec, comments]) expect(s).toMatchObject({ autonomy: "propose", kind: "build", labels: ["orienteer:build"] });
 });
});

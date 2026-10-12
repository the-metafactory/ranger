import { changeRequestLabel, changeRequestNoun } from "./forge-text.ts";
import { normalizeNodeId, parseForgeRef } from "./forge-ref.ts";
import { GraphAddUnattached, type AddSpec } from "./graph-write.ts";
import type { NodeResult } from "./graph.ts";
import type { Journal } from "./journal.ts";
import { mapKey } from "./maps.ts";

/**
 * The Scribe (design §6): files newly discovered work back onto the graph as
 * typed nodes through `soma graph add`, each with the provenance of where it
 * was found. Three templates live here: split-out-of-review, found-by-probe
 * and code-comment-graduated. The fourth, human observation, is node #21's
 * intake flow, where the words stay the principal's.
 *
 * Every filing is `propose` at minimum (node #9 ban: ranger never mints an
 * `auto` node), carries a checkpoint minted at add time (no verb attaches one
 * later), hangs below the spawning node and never on the map root, and is
 * re-read after the write: a parent or blocking edge the re-read does not
 * show is wired with `soma graph link`, and anything the verbs cannot repair
 * fails the filing.
 */

export type Provenance = "split-out-of-review" | "found-by-probe" | "code-comment-graduated";

/** The graph port the Scribe writes and re-reads through; default is `soma graph` under the machine token. */
export interface ScribeGraph {
 /** Throws `GraphAddUnattached` when the node was created but not attached. */
 add(parent: string, spec: AddSpec): Promise<{ node: string }>;
 /** Attach `node` below `parent` and wire `blockedBy`; a parent or edge already there is skipped. */
 link(node: string, parent: string, blockedBy: string[]): Promise<void>;
 /** The node as the tracker shows it now. */
 node(id: string): Promise<Pick<NodeResult, "parent" | "blockedBy" | "node">>;
}

export class ScribeError extends Error {
 override readonly name = "ScribeError";
}

/** The journal key of one filing: one node per (map, spawning node, provenance). */
export function scribeKey(map: { repo: string; root: number }, parent: string, provenance: Provenance): string {
 return `scribe.${mapKey(map)}.${parent}.${provenance}`;
}

function sameNode(repo: string, a: string, b: string): boolean {
 try {
  const ref = parseForgeRef(repo);
  return normalizeNodeId(ref, a) === normalizeNodeId(ref, b);
 } catch {
  return a === b;
 }
}

/**
 * The rules every ranger-filed node meets before the add runs: `propose` at
 * minimum, a checkpoint, a parent that is not the map root, and no blocker
 * that is the node's own parent.
 */
export function assertFilable(map: { repo: string; root: number }, parent: string, spec: AddSpec): void {
 if (spec.autonomy === "auto") {
  throw new ScribeError(`refusing to file "${spec.title}" as auto: ranger-filed nodes are propose at minimum (node #9)`);
 }
 if (spec.checkpoint.trim().length === 0) {
  throw new ScribeError(`refusing to file "${spec.title}" without a checkpoint: no verb attaches one later`);
 }
 if (sameNode(map.repo, parent, String(map.root))) {
  throw new ScribeError(`refusing to file "${spec.title}" on the map root #${map.root}: filed work goes below the node that found it`);
 }
 for (const blocker of spec.blockedBy ?? []) {
  if (sameNode(map.repo, blocker, parent)) throw new ScribeError(`refusing to file "${spec.title}" blocked by its own parent #${parent}`);
 }
}

interface ScribeRecord {
 node: string;
 parent: string;
 /** Set once a re-read showed the parent, the edges, the autonomy and the checkpoint. */
 verified?: true;
}

function readRecord(value: string | null): ScribeRecord | null {
 if (value === null) return null;
 try {
  const record = JSON.parse(value) as Partial<ScribeRecord> | null;
  if (typeof record?.node !== "string" || record.node.length === 0 || typeof record.parent !== "string") return null;
  return { node: record.node, parent: record.parent, ...(record.verified === true ? { verified: true as const } : {}) };
 } catch {
  return null;
 }
}

export interface ScribeFiling {
 map: { repo: string; root: number };
 /** The spawning node: the filed node hangs below it. */
 parent: string;
 provenance: Provenance;
 spec: AddSpec;
}

export interface ScribeFiled {
 node: string;
 /** False when the journal already held this filing: nothing was added. */
 added: boolean;
}

/**
 * File one node, at most once per (map, spawning node, provenance). The
 * journal records the node as soon as it exists, so a re-run after a crash
 * or a failed re-read finishes wiring that node instead of adding a second.
 * `fence` runs before every write (a superseded supervisor throws there).
 *
 * The window left open: a run that dies between the add and its record
 * write leaves one untracked node, which the next run duplicates.
 */
export async function scribeFile(
 graph: ScribeGraph,
 journal: Journal,
 filing: ScribeFiling,
 fence: () => void = () => {},
): Promise<ScribeFiled> {
 const { map, parent, provenance, spec } = filing;
 assertFilable(map, parent, spec);
 const key = scribeKey(map, parent, provenance);
 let record = readRecord(journal.getHealth(key));
 if (record?.verified === true) return { node: record.node, added: false };
 const added = record === null;
 if (record === null) {
  fence();
  try {
   const created = await graph.add(parent, spec);
   record = { node: created.node, parent };
  } catch (error) {
   if (!(error instanceof GraphAddUnattached)) throw error;
   record = { node: error.node, parent };
  }
  journal.setHealth(key, JSON.stringify(record));
 }
 await verifyWiring(graph, map.repo, record, spec, fence);
 journal.setHealth(key, JSON.stringify({ ...record, verified: true }));
 return { node: record.node, added };
}

/** What the re-read is missing: the parent and the blocking edges `link` can still wire. */
function missingWiring(repo: string, read: Pick<NodeResult, "parent" | "blockedBy">, parent: string, blockedBy: string[]) {
 const attached = read.parent !== undefined && sameNode(repo, read.parent.id, parent);
 const edges = blockedBy.filter((id) => !read.blockedBy.some((b) => sameNode(repo, b.id, id)));
 return { attached, edges };
}

/**
 * Re-read the filed node (design §6: a failed edge can leave the node created
 * and reachable). A missing parent or blocking edge is wired with one `link`
 * and read again; an autonomy or checkpoint other than the one filed, which
 * no verb can change, fails the filing.
 */
async function verifyWiring(
 graph: ScribeGraph,
 repo: string,
 record: ScribeRecord,
 spec: AddSpec,
 fence: () => void,
): Promise<void> {
 const blockedBy = spec.blockedBy ?? [];
 let read = await graph.node(record.node);
 let missing = missingWiring(repo, read, record.parent, blockedBy);
 if (!missing.attached || missing.edges.length > 0) {
  fence();
  await graph.link(record.node, record.parent, missing.edges);
  read = await graph.node(record.node);
  missing = missingWiring(repo, read, record.parent, blockedBy);
 }
 const problems: string[] = [];
 if (!missing.attached) problems.push(`its parent is ${read.parent === undefined ? "none" : `#${read.parent.id}`}, not #${record.parent}`);
 if (missing.edges.length > 0) problems.push(`it is not blocked by ${missing.edges.map((id) => `#${id}`).join(", ")}`);
 if (read.node.autonomy !== spec.autonomy) problems.push(`its autonomy is ${read.node.autonomy}, not ${spec.autonomy}`);
 if (read.node.checkpointId !== spec.checkpoint) problems.push(`its checkpoint is ${read.node.checkpointId ?? "none"}, not ${spec.checkpoint}`);
 if (problems.length > 0) {
  throw new ScribeError(`filed node #${record.node} below #${record.parent}, but the re-read shows ${problems.join("; ")}`);
 }
}

// ---- templates ----

/** A fence longer than any backtick run in `text`, so quoted text cannot end it or render as markup. */
function fenced(text: string): string[] {
 const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
 const fence = "`".repeat(Math.max(3, longest + 1));
 return [fence, text, fence];
}

function clip(text: string, max: number): string {
 return text.length > max ? `${text.slice(0, max)}\n… (clipped at ${max} characters)` : text;
}

function stem(text: string): string {
 return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titled(prefix: string, title: string): string {
 const raw = `${prefix}: ${title}`;
 return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
}

/** Every template files a `propose` build node (node #9: never `auto`). */
const build = (): Pick<AddSpec, "autonomy" | "kind" | "labels"> => ({ autonomy: "propose", kind: "build", labels: ["orienteer:build"] });

export interface ChangeRequestRef {
 number: number;
 url: string;
}

export interface SpawningNode {
 id: string;
 title: string;
}

/** The longest review text a split-out node quotes; GitHub caps an issue body at 65536 characters. */
export const REVIEW_TEXT_MAX = 40_000;

/**
 * Split-out-of-review (design §6, template 1): the findings the last sage
 * round left on a merged change, filed after the merge as one node below the
 * node that merged. The review text is sage's, quoted in a fence.
 */
export function splitOutOfReviewSpec(
 repo: string,
 node: SpawningNode,
 pr: ChangeRequestRef,
 review: { round: number; sha: string; blockers: number; majors: number; nits: number; body: string },
): AddSpec {
 const label = changeRequestLabel(repo, pr.number);
 return {
  ...build(),
  title: titled(`Review findings left open by node #${node.id}`, node.title),
  checkpoint: `review-findings-${stem(node.id)}-${review.sha.slice(0, 8)}`,
  body: [
   "## Deliverable",
   "",
   `Each finding the last sage round raised on ${label} is fixed in a merged change, or declined on this node with a reason.`,
   "",
   "## Split out of review",
   "",
   `Split out of node #${node.id} (${label}), raised in review and deliberately not done. Sage round ${review.round} at \`${review.sha.slice(0, 8)}\` found ${review.blockers} blocker(s), ${review.majors} major(s) and ${review.nits} nit(s); the ${changeRequestNoun(repo)} merged with them. Ranger filed this node; the review below is sage's text, as it was posted.`,
   "",
   `- Spawning node: node #${node.id} (${node.title})`,
   `- ${label}: ${pr.url}`,
   `- Reviewed head: \`${review.sha}\``,
   "",
   ...fenced(clip(review.body.trim() || "(the review posted no text)", REVIEW_TEXT_MAX)),
   "",
   "## Acceptance criteria",
   "",
   "- Given the findings above, when this node closes, then each one is fixed in a merged change or declined in its close receipt with a reason.",
   "",
   "## Out of scope",
   "",
   `- Findings raised on other ${changeRequestNoun(repo)}s, and new work the fixes turn up (filed as their own nodes).`,
  ].join("\n"),
 };
}

/**
 * Found-by-probe (design §6, template 2): the filed node is the report, and
 * the failing checks stay failing on purpose. Node #152 files one per probe
 * confirmed red at a merge base.
 */
export function foundByProbeSpec(
 repo: string,
 base: string,
 detecting: { id: string },
 probe: string,
 checks: string[],
 sha: string,
 pr: ChangeRequestRef,
): AddSpec {
 return {
  ...build(),
  title: `Make ${probe} pass on ${base} again`,
  checkpoint: `base-green-${stem(probe.replace(/\.[^.]+$/, ""))}-${sha.slice(0, 8)}`,
  body: [
   "## Deliverable",
   "",
   `\`${probe}\` passes on \`${base}\` again.`,
   "",
   "## Found by probe",
   "",
   `Node #${detecting.id} failed \`${probe}\` at its head, and two runs at its merge base \`${sha.slice(0, 8)}\` failed the same checks: the failure was the base's, not the branch's. Later ${changeRequestNoun(repo)}s off that merge base inherit these checks from ranger's cache instead of gating on them. The runs were at the merge base, not at \`${base}\`'s tip, which may have moved since. Ranger filed this node.`,
   "",
   `- Probe: \`${probe}\``,
   `- Merge base: \`${sha}\``,
   `- Detected by: node #${detecting.id}, ${changeRequestLabel(repo, pr.number)} (${pr.url})`,
   "- Failing checks at the merge base:",
   "",
   "```",
   ...checks.map((check) => check.replaceAll("`", "'")),
   "```",
   "",
   "## Acceptance criteria",
   "",
   `- Given \`${base}\` with the fix, when \`${probe}\` runs, then every check above passes.`,
   "",
   "## Out of scope",
   "",
   "- Ranger does not close this node when the probe goes green.",
  ].join("\n"),
 };
}

/** One marker comment a merged change added. */
export interface Landmine {
 path: string;
 line: number;
 text: string;
}

/** The most landmines a code-comment node lists; the rest are counted. */
export const LANDMINES_LISTED = 50;

/**
 * Code-comment-graduated (design §6, template 3): marker comments (TODO,
 * FIXME, XXX, HACK) a merged change added become one schedulable node below
 * the node that merged them, so the work they name is not left to whoever
 * next reads the file.
 */
export function codeCommentSpec(
 repo: string,
 node: SpawningNode,
 pr: ChangeRequestRef,
 mergeSha: string,
 landmines: Landmine[],
): AddSpec {
 const label = changeRequestLabel(repo, pr.number);
 const listed = landmines.slice(0, LANDMINES_LISTED).map((l) => `${l.path}:${l.line}: ${l.text}`);
 const rest = landmines.length - listed.length;
 return {
  ...build(),
  title: titled(`Landmine comments left by node #${node.id}`, node.title),
  checkpoint: `landmines-${stem(node.id)}-${mergeSha.slice(0, 8)}`,
  body: [
   "## Deliverable",
   "",
   `Every marker comment below is resolved: the work it names is done and the comment removed, or the comment is removed as moot.`,
   "",
   "## Code comments graduated",
   "",
   `Node #${node.id}'s merged change (${label}, merge commit \`${mergeSha.slice(0, 8)}\`) added ${landmines.length} marker comment(s). A comment like these is work no session schedules; this node schedules it. Ranger filed this node; the lines below are the change's text.`,
   "",
   `- Spawning node: node #${node.id} (${node.title})`,
   `- ${label}: ${pr.url}`,
   `- Merge commit: \`${mergeSha}\``,
   "",
   ...fenced([...listed, ...(rest > 0 ? [`… and ${rest} more`] : [])].join("\n")),
   "",
   "## Acceptance criteria",
   "",
   `- Given \`${mergeSha.slice(0, 8)}\`'s marker comments above, when this node closes, then none of them is left in the code as written, each one's work done or ruled moot in the close receipt.`,
   "",
   "## Out of scope",
   "",
   "- Marker comments that were in the code before this change.",
  ].join("\n"),
 };
}

/** The marker words a comment carries. */
const MARKER = /^(TODO|FIXME|XXX|HACK)\b/;

/**
 * How one family of languages writes comments: line leaders, block openers
 * with their closers, and the quotes that open a string literal. A leader
 * inside a string is text, not a comment. `spaced` marks a language whose
 * line leader can sit inside a word (shell `a#b`, YAML `url#frag`, INI
 * `key=a;b`): there it starts a comment only at line start or after
 * whitespace. Everywhere else the leader starts one wherever it stands.
 */
export interface CommentSyntax {
 line: string[];
 block: [open: string, close: string][];
 quotes: string[];
 spaced?: boolean;
}

const C_LIKE: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'", "`"] };
const RUST: CommentSyntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"'] };
const CSS: CommentSyntax = { line: [], block: [["/*", "*/"]], quotes: ['"', "'"] };
const HASH: CommentSyntax = { line: ["#"], block: [], quotes: ['"', "'"] };
const SHELL: CommentSyntax = { ...HASH, spaced: true };
const DASH: CommentSyntax = { line: ["--"], block: [], quotes: ['"', "'"] };
const SEMI: CommentSyntax = { line: [";"], block: [], quotes: ['"'] };
const INI: CommentSyntax = { ...SEMI, spaced: true };
const MARKUP: CommentSyntax = { line: [], block: [["<!--", "-->"]], quotes: [] };
const COMPONENT: CommentSyntax = { line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]], quotes: ['"', "'", "`"] };

const SYNTAX_BY_EXT: Record<string, CommentSyntax> = {
 ...Object.fromEntries(
  ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "java", "c", "h", "cc", "cpp", "hpp", "cs", "go", "swift", "kt", "kts", "scala", "dart", "php", "glsl", "wgsl", "frag", "vert", "jsonc"].map((e) => [e, C_LIKE]),
 ),
 rs: RUST,
 ...Object.fromEntries(["css", "scss", "less"].map((e) => [e, CSS])),
 ...Object.fromEntries(["py", "rb", "toml", "pl", "r", "nix", "ex", "exs", "mk"].map((e) => [e, HASH])),
 ...Object.fromEntries(["sh", "bash", "zsh", "fish", "yaml", "yml", "conf"].map((e) => [e, SHELL])),
 ...Object.fromEntries(["sql", "lua", "hs", "elm"].map((e) => [e, DASH])),
 ...Object.fromEntries(["el", "lisp", "clj", "cljs", "scm", "asm"].map((e) => [e, SEMI])),
 ini: INI,
 ...Object.fromEntries(["md", "mdx", "html", "htm", "xml", "svg"].map((e) => [e, MARKUP])),
 ...Object.fromEntries(["vue", "svelte", "astro"].map((e) => [e, COMPONENT])),
};

const SYNTAX_BY_NAME: Record<string, CommentSyntax> = { Makefile: HASH, Dockerfile: SHELL, Containerfile: SHELL };

/** The comment syntax a path's language uses; null when ranger does not know it. */
export function commentSyntax(path: string): CommentSyntax | null {
 const name = path.slice(path.lastIndexOf("/") + 1);
 const byName = SYNTAX_BY_NAME[name];
 if (byName !== undefined) return byName;
 const dot = name.lastIndexOf(".");
 return dot > 0 ? (SYNTAX_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** Whether a line leader at `at` starts a comment: anywhere, or in a `spaced` language only at line start or after whitespace. */
function leaderStartsHere(text: string, at: number, syntax: CommentSyntax): boolean {
 return !syntax.spaced || at === 0 || /\s/.test(text[at - 1]);
}

/** Whether a comment body (the text right after its leader) opens with a marker word. */
function bodyHasMarker(body: string, leader: string): boolean {
 // Repeated leader characters (`///`, `##`, `/**`, `;;`) belong to the leader.
 const repeat = leader[leader.length - 1];
 let i = 0;
 while (i < body.length && body[i] === repeat) i += 1;
 return MARKER.test(body.slice(i).trimStart());
}

/**
 * Whether one added line carries a marker comment, read with its language's
 * comment syntax: the first leader outside a string literal starts the
 * comment, and the marker must open it. A block comment's continuation line
 * (` * TODO`) counts when the language has `/* *\/` blocks. A line inside a
 * multi-line string the diff does not show can still read as a comment.
 */
export function lineHasMarkerComment(text: string, syntax: CommentSyntax): boolean {
 if (syntax.block.some(([open]) => open === "/*") && /^\s*\*(?!\/)/.test(text)) {
  if (bodyHasMarker(text.trimStart().slice(1), "*")) return true;
 }
 let quote: string | null = null;
 let i = 0;
 while (i < text.length) {
  const ch = text[i];
  if (quote !== null) {
   if (ch === "\\") i += 2;
   else {
    if (ch === quote) quote = null;
    i += 1;
   }
   continue;
  }
  if (syntax.quotes.includes(ch)) {
   quote = ch;
   i += 1;
   continue;
  }
  const leader = syntax.line.find((l) => text.startsWith(l, i) && leaderStartsHere(text, i, syntax));
  if (leader !== undefined) return bodyHasMarker(text.slice(i + leader.length), leader);
  const block = syntax.block.find(([open]) => text.startsWith(open, i));
  if (block !== undefined) {
   const [open, close] = block;
   const bodyStart = i + open.length;
   const end = text.indexOf(close, bodyStart);
   if (bodyHasMarker(text.slice(bodyStart, end < 0 ? undefined : end), open)) return true;
   // The rest of the line is code again only after the block closes.
   if (end < 0) return false;
   i = end + close.length;
   continue;
  }
  i += 1;
 }
 return false;
}

/** The longest landmine text a node quotes. */
const LANDMINE_TEXT_MAX = 200;

/**
 * The marker comments a unified diff (`git diff --unified=0`) adds, with the
 * new file's path and line. Removed and context lines never count, and a
 * deleted file has no new path to name. A file in a language ranger has no
 * comment syntax for adds none: an unread file never schedules work.
 */
export function landminesInDiff(diff: string): Landmine[] {
 const found: Landmine[] = [];
 let path: string | null = null;
 let line = 0;
 // File headers come between `diff --git` and the first hunk; inside a hunk
 // an added line that starts with "++ " is content, not a header.
 let header = false;
 for (const raw of diff.split("\n")) {
  if (raw.startsWith("diff --git ")) {
   header = true;
   path = null;
   continue;
  }
  if (header && raw.startsWith("+++ ")) {
   const target = raw.slice(4).replace(/^"(.*)"$/, "$1");
   path = target === "/dev/null" ? null : target.replace(/^b\//, "");
   continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
  if (hunk !== null) {
   header = false;
   line = Number(hunk[1]);
   continue;
  }
  if (!header && raw.startsWith("+")) {
   const text = raw.slice(1);
   const syntax = path === null ? null : commentSyntax(path);
   if (path !== null && syntax !== null && lineHasMarkerComment(text, syntax)) {
    const trimmed = text.trim();
    found.push({ path, line, text: trimmed.length > LANDMINE_TEXT_MAX ? `${trimmed.slice(0, LANDMINE_TEXT_MAX)}…` : trimmed });
   }
   line += 1;
  }
 }
 return found;
}

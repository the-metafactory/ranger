import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCmd, type RunResult } from "./exec.ts";

export const MAX_DAY_BYTES = 16 * 1024 * 1024;
export const RETENTION_DAYS = 14;
export const DAY_MS = 86_400_000;
export const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type RefusalKind = "primary" | "secondary" | "unclassified";

export interface CallRecord {
 kind: "call";
 at: string;
 component: string;
 endpoint: string;
 source: string;
 command?: string;
 status?: number;
 resource?: string;
 limit?: number;
 remaining?: number;
 reset?: number;
 retryAfter?: number;
 refusal?: RefusalKind;
}

/** A free reading of a budget, from `/rate_limit`: it shows spend but is none. */
export interface GaugeRecord {
 kind: "gauge";
 at: string;
 component: string;
 source: string;
 command?: string;
 resource: string;
 limit?: number;
 remaining: number;
 reset?: number;
}

/** A subprocess that calls GitHub itself (soma, sage): its time, not its calls. */
export interface OpaqueRecord {
 kind: "opaque";
 at: string;
 endedAt: string;
 component: string;
 source: string;
 command?: string;
 refusal?: RefusalKind;
}

/**
 * One line of the record of ranger's GitHub use (#493): append-only JSONL day
 * files beside the journal. A line holds the calling component, the token's
 * source label and the rate-limit numbers GitHub already returned, so measuring
 * adds no API call. It never holds a token, a header block, a repo or a login.
 */
export type UsageRecord = CallRecord | GaugeRecord | OpaqueRecord;

/** Who is calling: a component name, and the token's env var name or source label. */
export interface UsageSpec {
 component: string;
 source: string;
}

export interface UsageConfig {
 directory: string;
 command: string;
 notice?: (line: string) => void;
}

interface ActiveUsage {
 directory: string;
 command: string;
 notice: (line: string) => void;
 pruned: boolean;
 noticed: boolean;
}

const stderrLine = (line: string): void => { process.stderr.write(`${line}\n`); };

let active: ActiveUsage | null = null;

/** Start recording this process's calls, or stop with null. Calls are unchanged while stopped. */
export function configureGitHubUsage(config: UsageConfig | null): void {
 active = config === null ? null : { directory: config.directory, command: config.command, notice: config.notice ?? stderrLine, pruned: false, noticed: false };
}

/** Where the record lives: a directory beside the journal. */
export function githubUsageDirectory(journalPath: string): string {
 return join(dirname(journalPath), "github-usage");
}

function pruneOldDays(directory: string, now: Date): void {
 const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
 for (const name of readdirSync(directory)) {
  const day = DAY_FILE.exec(name)?.[1];
  if (day !== undefined && day < cutoff) rmSync(join(directory, name), { force: true });
 }
}

function append(usage: ActiveUsage, record: UsageRecord): void {
 try {
  mkdirSync(usage.directory, { recursive: true });
  if (!usage.pruned) {
   usage.pruned = true;
   pruneOldDays(usage.directory, new Date(record.at));
  }
  const file = join(usage.directory, `${record.at.slice(0, 10)}.jsonl`);
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size >= MAX_DAY_BYTES) return;
  appendFileSync(file, `${JSON.stringify(record)}\n`);
 } catch (error) {
  if (usage.noticed) return;
  usage.noticed = true;
  usage.notice(`ranger: GitHub usage not recorded: ${error instanceof Error ? error.message : String(error)}`);
 }
}

const BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** Does this `gh api` request carry a body? */
export function hasRequestBody(args: string[]): boolean {
 return args.some((a) => BODY_FLAGS.has(a) || a.startsWith("--field=") || a.startsWith("--raw-field=") || a.startsWith("--input="));
}

/** The method a `gh api` request names, if it names one. */
export function explicitMethod(args: string[]): string | undefined {
 for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X" || a === "--method") return args[i + 1] ?? "";
  const inline = a.startsWith("--method=") ? a.slice(9) : a.startsWith("-X") ? a.slice(2) : "";
  if (inline.length > 0) return inline;
 }
 return undefined;
}

const NAMED_SEGMENTS = new Set([
 "actions", "check-runs", "comments", "commits", "compare", "events", "git", "graphql", "heads", "issues", "jobs", "labels",
 "logs", "merge", "pulls", "rate_limit", "reactions", "refs", "repos", "runs", "status", "update-branch", "user",
]);

function labelSegment(segment: string, previous: string | undefined): string {
 if (previous === "heads") return ":ref";
 if (/^\d+$/.test(segment)) return ":id";
 if (/^[0-9a-f]{40}$/.test(segment)) return ":sha";
 return NAMED_SEGMENTS.has(segment) ? segment : ":arg";
}

/**
 * `GET pulls/:id`, from a `gh api` argv: the request's shape without its owner,
 * repo, query or values. Only a fixed vocabulary of segments survives, so no
 * branch or repo name reaches the record.
 */
export function endpointLabel(args: string[]): string {
 const path = (args[1] ?? "").replace(/^https?:\/\/[^/]+\//, "").replace(/^\//, "").split("?")[0];
 const all = path.split("/").filter((segment) => segment.length > 0);
 const segments = all[0] === "repos" && all.length > 3 ? all.slice(3) : all;
 const shape = all[0] === "repos" && all.length <= 3
  ? "repos/:repo"
  : segments.map((segment, i) => labelSegment(segment, segments[i - 1])).join("/");
 const method = explicitMethod(args)?.toUpperCase() ?? (hasRequestBody(args) || all[0] === "graphql" ? "POST" : "GET");
 return `${method} ${shape}`;
}

interface ResponseHead {
 status: number;
 headers: Map<string, string>;
}

const HEAD_SHAPE = String.raw`HTTP\/\d(?:\.\d)? \d{3}[^\r\n]*\r?\n(?:[^\r\n:]+:[^\r\n]*\r?\n)*\r?\n`;
const LEADING_HEAD = new RegExp(`^${HEAD_SHAPE}`);
const PAGE_HEADS = new RegExp(`(?:^|(?<=[\\[,]))${HEAD_SHAPE}`, "g");

function parseHead(block: string): ResponseHead {
 const [statusLine, ...lines] = block.split(/\r?\n/);
 const headers = new Map<string, string>();
 for (const line of lines) {
  const colon = line.indexOf(":");
  if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
 }
 return { status: Number(statusLine.split(" ")[1]), headers };
}

function splitResponseHeads(stdout: string, paginated: boolean): { heads: ResponseHead[]; body: string } {
 const heads: ResponseHead[] = [];
 const body = stdout.replace(paginated ? PAGE_HEADS : LEADING_HEAD, (block) => {
  heads.push(parseHead(block));
  return "";
 });
 return { heads, body };
}

const numberHeader = (head: ResponseHead | undefined, name: string): number | undefined => {
 const raw = head?.headers.get(name);
 return raw === undefined || !/^\d+$/.test(raw) ? undefined : Number(raw);
};

/** A refusal for rate limiting, told apart so that one with budget left stays visible. */
export function classifyRefusal(evidence: { text: string; status?: number; remaining?: number; retryAfter?: number }): RefusalKind | undefined {
 const { text, status, remaining, retryAfter } = evidence;
 const limited = status === 403 || status === 429;
 if (/secondary rate limit|abuse detection/i.test(text)) return "secondary";
 if (limited && remaining === 0) return "primary";
 if (/rate limit exceeded/i.test(text)) return "primary";
 if (limited && retryAfter !== undefined) return "secondary";
 if (status === 429 || /rate.?limit/i.test(text)) return "unclassified";
 return undefined;
}

function callRecord(spec: UsageSpec, command: string, args: string[], at: string, head: ResponseHead | undefined, failureText: string): CallRecord {
 const remaining = numberHeader(head, "x-ratelimit-remaining");
 const retryAfter = numberHeader(head, "retry-after");
 const limit = numberHeader(head, "x-ratelimit-limit");
 const reset = numberHeader(head, "x-ratelimit-reset");
 const resource = head?.headers.get("x-ratelimit-resource");
 const refusal = classifyRefusal({ text: failureText, status: head?.status, remaining, retryAfter });
 return {
  kind: "call", at, component: spec.component, endpoint: endpointLabel(args), source: spec.source, command,
  ...(head === undefined ? {} : { status: head.status }),
  ...(resource === undefined ? {} : { resource }),
  ...(limit === undefined ? {} : { limit }),
  ...(remaining === undefined ? {} : { remaining }),
  ...(reset === undefined ? {} : { reset }),
  ...(retryAfter === undefined ? {} : { retryAfter }),
  ...(refusal === undefined ? {} : { refusal }),
 };
}

function recordResponses(usage: ActiveUsage, spec: UsageSpec, args: string[], result: RunResult, heads: ResponseHead[]): void {
 const at = new Date().toISOString();
 const failure = result.code === 0 ? "" : result.stderr;
 if (heads.length === 0) {
  append(usage, callRecord(spec, usage.command, args, at, undefined, failure));
  return;
 }
 heads.forEach((head, i) => {
  const refused = head.status >= 400 || i === heads.length - 1;
  append(usage, callRecord(spec, usage.command, args, at, head, refused ? failure : ""));
 });
}

/**
 * `runCmd` for one `gh api` request that records what the request cost. It adds
 * `--include` to read the rate-limit headers and strips them again, so a caller
 * and the retry logic see the stdout they had before. A caller that asked for
 * the headers itself keeps them.
 *
 * A page's head starts the output or follows the `[` or `,` that `--slurp` joins
 * pages with, and its bare newlines cannot occur inside a JSON string. A plain
 * `--paginate` gets no `--include`, since `gh` stops merging its pages under that
 * flag; it counts as one call of unknown cost.
 */
export function meteredGh(spec: UsageSpec, base: typeof runCmd = runCmd): typeof runCmd {
 return async (bin, args, opts) => {
  const usage = active;
  if (usage === null) return base(bin, args, opts);
  const paginated = args.includes("--paginate");
  if (paginated && !args.includes("--slurp")) {
   const plain = await base(bin, args, opts);
   recordResponses(usage, spec, args, plain, []);
   return plain;
  }
  const askedForHeads = args.includes("--include") || args.includes("-i");
  const result = await base(bin, askedForHeads ? args : [...args, "--include"], opts);
  const { heads, body } = splitResponseHeads(result.stdout, paginated);
  recordResponses(usage, spec, args, result, heads);
  return askedForHeads ? result : { ...result, stdout: body };
 };
}

/**
 * `runCmd` for the free `gh api rate_limit`: the headers are a reading of the
 * core budget, not a charged call. Strips them the way `meteredGh` does.
 */
export function meteredGauge(spec: UsageSpec, base: typeof runCmd = runCmd): typeof runCmd {
 return async (bin, args, opts) => {
  const usage = active;
  if (usage === null) return base(bin, args, opts);
  const result = await base(bin, [...args, "--include"], opts);
  const { heads, body } = splitResponseHeads(result.stdout, false);
  const remaining = numberHeader(heads[0], "x-ratelimit-remaining");
  if (remaining !== undefined) {
   append(usage, {
    kind: "gauge", at: new Date().toISOString(), component: spec.component, source: spec.source, command: usage.command,
    resource: heads[0].headers.get("x-ratelimit-resource") ?? "core", remaining,
    limit: numberHeader(heads[0], "x-ratelimit-limit"), reset: numberHeader(heads[0], "x-ratelimit-reset"),
   });
  }
  return { ...result, stdout: body };
 };
}

/** Record a budget reading taken from a response body. */
export function recordGauge(spec: UsageSpec, reading: { resource: string; limit: number; remaining: number; reset: number }): void {
 const usage = active;
 if (usage === null) return;
 append(usage, { kind: "gauge", at: new Date().toISOString(), component: spec.component, source: spec.source, command: usage.command, ...reading });
}

/** `runCmd` for a subprocess that calls GitHub itself: records when it ran and any refusal it reported. */
export function meteredOpaque(spec: UsageSpec, base: typeof runCmd = runCmd): typeof runCmd {
 return async (bin, args, opts) => {
  const usage = active;
  if (usage === null) return base(bin, args, opts);
  const at = new Date().toISOString();
  const result = await base(bin, args, opts);
  const refusal = result.code === 0 ? undefined : classifyRefusal({ text: result.stderr });
  append(usage, {
   kind: "opaque", at, endedAt: new Date().toISOString(), component: spec.component, source: spec.source, command: usage.command,
   ...(refusal === undefined ? {} : { refusal }),
  });
  return result;
 };
}

/**
 * `ranger serve` (#37) — a local dashboard of the walk: the job a worker is on
 * now, the next node a tick would take, every node ranger can take on its own,
 * and the open grilling nodes, each with a button that opens the principal's
 * own interactive session on it.
 *
 * **Read-only.** Frontier data is scout's (`scout.ts`: the read-only token gate
 * and the read verbs), cached and refreshed in the background; the journal is
 * opened read-only on every request. Nothing here imports a graph write, and
 * `test/serve.test.ts` walks the import graph to keep it so.
 *
 * **The launch is the principal's session, not the machine account's.** This
 * process runs under `~/bin/ranger`, whose environment carries the machine
 * account's `GH_TOKEN`, the `RANGER_*` write and Discord tokens and an isolated
 * `GH_CONFIG_DIR`. The launcher's environment is an allowlist (`childEnv`), the
 * prompt carries a configured repo and a numeric id only, and the endpoint
 * refuses a foreign Host or Origin, a missing token, and any node that is not
 * a grilling on the cached frontier and still open and unclaimed when read
 * live. **What the allowlist proves is narrower than the session**: it is the
 * environment `osascript` runs with, and `test/serve.test.ts` holds it. The
 * shell iTerm2 then opens is started by iTerm2, and is expected to take
 * iTerm2's own environment rather than this process's — that is how a
 * launched app's window works, and it is not tested here.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";
import {
 expandHome,
 type RangerConfig,
 REPO_PATTERN,
 serveConfig,
 type WalkMode,
} from "./config.ts";
import { planTick, walkableCandidates } from "./candidates.ts";
import { pidAlive as defaultPidAlive } from "./exec.ts";
import { Journal, type WorkerRow } from "./journal.ts";
import { activeCooldown, readGraphqlBudget } from "./budget.ts";
import { cachedFrontier } from "./frontier-cache.ts";
import { type FrontierEntry, graphFrontier, RateLimitError } from "./graph.ts";
import { runCmd } from "./exec.ts";
import { classify, type ClassifiedNode, loadProbeRegistry } from "./route.ts";
import type { SubstrateReading } from "./journal.ts";
import { assertReadOnlyToken, gatedEnv } from "./token-gate.ts";

const ID_PATTERN = /^\d+$/;

/** A map the dashboard shows: a registered one, or a serve-only extra (#38). */
export interface ServeMap {
 /** `owner/name#root` — two maps may share a repo. */
 key: string;
 repo: string;
 root: number;
 walk: WalkMode;
 /** Shown here only: not walked, not in `ranger scout`'s report, no cards. */
 servedOnly: boolean;
 /** The principal's checkout, `~` expanded; unset means no session button. */
 localCheckout?: string;
 /** Why a configured `localCheckout` was refused (it is a machine-account clone). */
 checkoutRefused?: string;
 nodes?: string[];
 skip?: string[];
}

/**
 * The principal's checkout for a map, or the reason it is refused: a path
 * inside `state.canonicalRoot`, or the map's own `canonical`, is a machine-
 * account clone, and a session there would be the principal working in it.
 */
function checkoutFor(
 config: RangerConfig,
 repo: string,
 configured: string | undefined,
 canonical: string | undefined,
): Pick<ServeMap, "localCheckout" | "checkoutRefused"> {
 if (configured === undefined) return {};
 const path = resolve(expandHome(configured));
 const root = resolve(expandHome(config.state.canonicalRoot));
 const clone = resolve(expandHome(canonical ?? `${config.state.canonicalRoot}/${repo}`));
 if (path === root || path.startsWith(root + sep) || path === clone) {
  return {
   checkoutRefused: `localCheckout ${path} is a machine-account clone (state.canonicalRoot or canonical)`,
  };
 }
 return { localCheckout: path };
}

export function servedMaps(config: RangerConfig): ServeMap[] {
 const maps: ServeMap[] = config.maps.map((m) => ({
  key: `${m.repo}#${m.root}`,
  repo: m.repo,
  root: m.root,
  walk: m.walk,
  servedOnly: false,
  ...checkoutFor(config, m.repo, m.localCheckout, m.canonical),
  nodes: m.nodes,
  skip: m.skip,
 }));
 for (const extra of serveConfig(config).extraMaps) {
  const key = `${extra.repo}#${extra.root}`;
  if (maps.some((m) => m.key === key)) continue;
  maps.push({
   key,
   repo: extra.repo,
   root: extra.root,
   walk: "none",
   servedOnly: true,
   ...checkoutFor(config, extra.repo, extra.localCheckout, undefined),
  });
 }
 return maps;
}

// ---- state ----

/** One map's frontier as the dashboard has it. */
export interface MapRead {
 ok: boolean;
 error?: string;
 /** Classified exactly as the walk classifies. */
 frontier: ClassifiedNode[];
 /** When it was read from GitHub. */
 readAt: string | null;
 /**
  * `ranger`: the frontier the tick cached in the journal (no GitHub call from
  * here). `serve`: a serve-only map this dashboard read itself, rarely.
  */
 source: "ranger" | "serve";
}

export interface StateInputs {
 maps: ServeMap[];
 /** Frontier reads by `ServeMap.key`. */
 reports: Map<string, MapRead>;
 /** Titles of in-flight nodes not on any frontier, by `repo#id`. */
 titles: Map<string, string>;
 workers: WorkerRow[];
 laneHolder: WorkerRow | null;
 paused: boolean;
 spawnsToday: number;
 spawnCap: number;
 vetoed: (nodeId: string) => boolean;
 pidAlive: (pid: number | null) => boolean;
 refreshing: boolean;
 refreshError: string | null;
 now: Date;
 /** Latest substrate quota readings (node #45). */
 substrateReadings?: SubstrateReading[];
}

export interface CurrentJob {
 repo: string;
 nodeId: string;
 title: string | null;
 status: WorkerRow["status"];
 phase: WorkerRow["phase"];
 lane: string | null;
 prNumber: number | null;
 reviewRound: number;
 startedAt: string | null;
 pid: number | null;
 /** A claimed/running row whose process is gone: stale until `sweep` runs. */
 stale: boolean;
}

export interface NodeView {
 id: string;
 title: string;
 kind: string;
 url: string;
 lane?: "implement" | "research";
}

export interface NextJob {
 nodeId?: string;
 title?: string;
 url?: string;
 lane?: "implement" | "research";
 /** The node is next but waits for the implement lane to free. */
 waiting: boolean;
 reason: string;
}

export interface GrillingView extends NodeView {
 launchable: boolean;
 why?: string;
}

export interface DashboardMap {
 key: string;
 repo: string;
 root: number;
 walk: WalkMode;
 servedOnly: boolean;
 ok: boolean;
 error?: string;
 readAt: string | null;
 source: "ranger" | "serve";
 localCheckout?: string;
 next: NextJob;
 autonomous: NodeView[];
 grillings: GrillingView[];
}

/** A substrate's latest quota reading, as the panel shows it (node #45). */
export type SubstrateView = SubstrateReading;

export interface DashboardState {
 generatedAt: string;
 refreshing: boolean;
 refreshError: string | null;
 gates: {
  paused: boolean;
  spawnsToday: number;
  spawnCap: number;
  laneHolder: { repo: string; nodeId: string; status: string } | null;
 };
 current: CurrentJob[];
 maps: DashboardMap[];
 substrates: SubstrateView[];
}

const IN_FLIGHT = new Set<WorkerRow["status"]>(["claimed", "running", "awaiting-merge"]);

const laneOf = (n: ClassifiedNode): "implement" | "research" | undefined =>
 n.route.route === "implement" || n.route.route === "research"
  ? n.route.route
  : undefined;

const view = (n: ClassifiedNode): NodeView => ({
 id: n.id,
 title: n.title,
 kind: n.kind,
 url: n.url,
 lane: laneOf(n),
});

/**
 * What one tick has spent by the time it reaches a map: walk visits maps in
 * config order, and an earlier map's claims take the implement lane and
 * count against the shared daily cap before a later map is planned.
 */
interface TickSoFar {
 holder: { repo: string; nodeId: string; thisTick: boolean } | null;
 spawns: number;
}

function nextFor(
 map: ServeMap,
 report: MapRead | undefined,
 inputs: StateInputs,
 tick: TickSoFar,
): NextJob {
 const none = (reason: string): NextJob => ({ waiting: false, reason });
 if (map.servedOnly) return none("not walked by ranger yet: shown here only (#38)");
 if (report === undefined) return none("no frontier read yet");
 if (!report.ok) return none(`frontier unavailable: ${report.error ?? "unknown error"}`);
 if (map.walk === "none") return none("walk: none — registered, not walked");
 if (inputs.paused) return none("dead-man paused — claiming stopped until `ranger resume-run`");
 if (tick.spawns >= inputs.spawnCap) {
  return none(
   tick.spawns > inputs.spawnsToday
    ? `the daily spawn cap (${inputs.spawnCap}) is spent by earlier maps this tick`
    : `daily spawn cap reached (${inputs.spawnsToday}/${inputs.spawnCap})`,
  );
 }
 // The tick's own plan (candidates.ts): the order and the veto rule walk uses.
 const holder = tick.holder;
 const plan = planTick(report.frontier, {
  laneBusy: holder !== null,
  vetoed: inputs.vetoed,
 });
 // What this map spends of the tick, for the maps after it.
 const claims = plan.take.slice(0, inputs.spawnCap - tick.spawns);
 tick.spawns += claims.length;
 const implementClaim = claims.find((n) => plan.implement.includes(n));
 if (implementClaim !== undefined) {
  tick.holder = { repo: map.key, nodeId: implementClaim.id, thisTick: true };
 }
 const first = claims[0];
 if (first !== undefined) {
  return {
   nodeId: first.id,
   title: first.title,
   url: first.url,
   lane: laneOf(first),
   waiting: false,
   reason: "the next tick claims this",
  };
 }
 if (holder !== null && plan.waiting !== null) {
  return {
   nodeId: plan.waiting.id,
   title: plan.waiting.title,
   url: plan.waiting.url,
   lane: "implement",
   waiting: true,
   reason: holder.thisTick
    ? `waits for the implement lane: this tick claims #${holder.nodeId} (${holder.repo}) first`
    : `waits for the implement lane, held by #${holder.nodeId} (${holder.repo})`,
  };
 }
 const vetoed = plan.vetoed.map((n) => `#${n.id}`);
 if (vetoed.length > 0) {
  return none(`${vetoed.join(", ")} vetoed — the tick claims nothing else this pass`);
 }
 return none("nothing walkable on this map's frontier");
}

export function assembleState(inputs: StateInputs): DashboardState {
 const titleOf = (repo: string, id: string): string | null => {
  for (const map of inputs.maps) {
   if (map.repo !== repo) continue;
   const report = inputs.reports.get(map.key);
   const hit = report?.frontier.find((n) => n.id === id)?.title;
   if (hit !== undefined) return hit;
  }
  return inputs.titles.get(`${repo}#${id}`) ?? null;
 };

 const current: CurrentJob[] = inputs.workers
  .filter((w) => IN_FLIGHT.has(w.status))
  .map((w) => ({
   repo: w.repo,
   nodeId: w.nodeId,
   title: titleOf(w.repo, w.nodeId),
   status: w.status,
   phase: w.phase,
   lane: w.lane,
   prNumber: w.prNumber,
   reviewRound: w.reviewRound,
   startedAt: w.startedAt,
   pid: w.pid,
   stale:
    (w.status === "claimed" || w.status === "running") &&
    w.pid !== null &&
    !inputs.pidAlive(w.pid),
  }));

 const lane = inputs.laneHolder;
 const tick: TickSoFar = {
  holder: lane === null ? null : { repo: lane.repo, nodeId: lane.nodeId, thisTick: false },
  spawns: inputs.spawnsToday,
 };
 // In config order, as walk visits them, so each map sees what the earlier ones spent.
 const maps: DashboardMap[] = inputs.maps.map((map) => {
  const report = inputs.reports.get(map.key);
  const frontier = report?.ok ? report.frontier : [];
  const walked = !map.servedOnly && map.walk !== "none";
  return {
   key: map.key,
   repo: map.repo,
   root: map.root,
   walk: map.walk,
   servedOnly: map.servedOnly,
   ok: report?.ok ?? false,
   error: report?.error,
   readAt: report?.readAt ?? null,
   source: report?.source ?? (map.servedOnly ? "serve" : "ranger"),
   localCheckout: map.localCheckout,
   next: nextFor(map, report, inputs, tick),
   autonomous: walked ? walkableCandidates(frontier).map(view) : [],
   grillings: frontier
    .filter((n) => n.kind === "grilling")
    .map((n) => ({
     ...view(n),
     launchable: map.localCheckout !== undefined,
     why:
      map.localCheckout !== undefined
       ? undefined
       : (map.checkoutRefused ?? `no localCheckout for ${map.repo} in ranger.yaml`),
    })),
  };
 });

 const holder = inputs.laneHolder;
 return {
  generatedAt: inputs.now.toISOString(),
  refreshing: inputs.refreshing,
  refreshError: inputs.refreshError,
  gates: {
   paused: inputs.paused,
   spawnsToday: inputs.spawnsToday,
   spawnCap: inputs.spawnCap,
   laneHolder:
    holder === null
     ? null
     : { repo: holder.repo, nodeId: holder.nodeId, status: holder.status },
  },
  current,
  maps,
  substrates: inputs.substrateReadings ?? [],
 };
}

// ---- the launch ----

/** Environment keys a launched session may inherit — an allowlist, never a denylist. */
const CHILD_ENV_KEYS = [
 "PATH",
 "HOME",
 "USER",
 "LOGNAME",
 "SHELL",
 "LANG",
 "LC_ALL",
 "LC_CTYPE",
 "TMPDIR",
] as const;

export function childEnv(
 env: Record<string, string | undefined>,
): Record<string, string> {
 const out: Record<string, string> = {};
 for (const key of CHILD_ENV_KEYS) {
  const value = env[key];
  if (value !== undefined) out[key] = value;
 }
 return out;
}

/** POSIX single-quote a string for a shell. */
const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Escape a string for an AppleScript string literal. */
const appleQuote = (s: string): string =>
 `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export interface LaunchPlan {
 prompt: string;
 shellCommand: string;
 argv: string[];
}

/**
 * The command that opens an iTerm2 window in the principal's checkout and
 * starts `claude` on one grilling node (the principal's terminal, 2026-10-03).
 * The prompt is built from the repo and the id only; no tracker text.
 */
export function launchPlan(args: {
 repo: string;
 root: number;
 nodeId: string;
 cwd: string;
}): LaunchPlan {
 if (!REPO_PATTERN.test(args.repo)) throw new Error(`bad repo: ${args.repo}`);
 if (!ID_PATTERN.test(args.nodeId)) throw new Error(`bad node id: ${args.nodeId}`);
 if (!Number.isInteger(args.root) || args.root <= 0) throw new Error(`bad root: ${args.root}`);
 const prompt =
  `Grill node #${args.nodeId} with me, on map #${args.root} of ${args.repo}. ` +
  `Read it with \`soma graph node ${args.nodeId} --repo ${args.repo}\`, ` +
  `then work it with the grilling skill.`;
 const shellCommand = `cd ${shellQuote(args.cwd)} && claude ${shellQuote(prompt)}`;
 const script = [
  'tell application "iTerm2"',
  " set w to (create window with default profile)",
  ` tell current session of w to write text ${appleQuote(shellCommand)}`,
  " activate",
  "end tell",
 ].join("\n");
 return { prompt, shellCommand, argv: ["osascript", "-e", script] };
}

function spawnLaunch(argv: string[], env: Record<string, string>): void {
 const [command, ...args] = argv;
 const child = spawn(command, args, { env, stdio: "ignore", detached: true });
 // A failed spawn (ENOENT) is reported, never an unhandled crash of the server.
 child.on("error", (error) => {
  process.stderr.write(`ranger serve: launch failed: ${error.message}\n`);
 });
 child.unref();
}

// ---- HTTP ----

export interface HandlerContext {
 port: number;
 token: string;
 getState: () => DashboardState;
 refresh: () => void;
 launch: (argv: string[], env: Record<string, string>) => void;
 /**
  * Read the node live before a launch: the frontier cache can be minutes
  * old. Resolves `null` when it is still an open, unclaimed grilling, or the
  * reason it is not.
  */
 verifyGrilling: (map: DashboardMap, nodeId: string) => Promise<string | null>;
}

const json = (status: number, body: unknown): Response =>
 new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
 });

const refuse = (status: number, error: string): Response => json(status, { error });

function tokenMatches(given: string | null, token: string): boolean {
 if (given === null) return false;
 const a = Buffer.from(given);
 const b = Buffer.from(token);
 return a.length === b.length && timingSafeEqual(a, b);
}

export function createHandler(ctx: HandlerContext): (req: Request) => Promise<Response> {
 const hosts = [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`];
 const origins = hosts.map((h) => `http://${h}`);
 return async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  // DNS rebinding: a page on another name must not read or drive this server.
  const host = req.headers.get("host") ?? url.host;
  if (!hosts.includes(host)) return refuse(403, "host refused");

  if (req.method === "GET" && url.pathname === "/") {
   return new Response(renderPage(ctx.token), {
    headers: {
     "content-type": "text/html; charset=utf-8",
     "cache-control": "no-store",
     // No other page may frame this one and steer a click onto "Start session".
     "content-security-policy": "frame-ancestors 'none'",
     "x-frame-options": "DENY",
    },
   });
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
   return json(200, ctx.getState());
  }
  if (req.method !== "POST") return refuse(404, "not found");

  const origin = req.headers.get("origin");
  if (origin !== null && !origins.includes(origin)) return refuse(403, "origin refused");
  if (!tokenMatches(req.headers.get("x-ranger-token"), ctx.token)) {
   return refuse(403, "token refused");
  }

  if (url.pathname === "/api/refresh") {
   ctx.refresh();
   return json(202, { refreshing: true });
  }
  if (url.pathname !== "/api/grill") return refuse(404, "not found");

  let body: { key?: unknown; id?: unknown; dryRun?: unknown };
  try {
   body = (await req.json()) as typeof body;
  } catch {
   return refuse(400, "body is not JSON");
  }
  if (typeof body.key !== "string" || typeof body.id !== "string") {
   return refuse(400, "key and id are required strings");
  }
  if (!ID_PATTERN.test(body.id)) return refuse(400, "id must be numeric");
  const state = ctx.getState();
  const map = state.maps.find((m) => m.key === body.key);
  if (map === undefined) return refuse(404, `no map ${body.key}`);
  const grilling = map.grillings.find((g) => g.id === body.id);
  if (grilling === undefined) {
   return refuse(404, `#${body.id} is not an open grilling on ${map.key}'s frontier`);
  }
  if (!grilling.launchable || map.localCheckout === undefined) {
   return refuse(409, grilling.why ?? "no checkout configured");
  }
  const stale = await ctx.verifyGrilling(map, grilling.id);
  if (stale !== null) return refuse(409, stale);
  const plan = launchPlan({
   repo: map.repo,
   root: map.root,
   nodeId: grilling.id,
   cwd: map.localCheckout,
  });
  if (body.dryRun === true) return json(200, { dryRun: true, ...plan });
  ctx.launch(plan.argv, childEnv(process.env));
  return json(200, { launched: true, nodeId: grilling.id, cwd: map.localCheckout });
 };
}

// ---- the page ----

export function renderPage(token: string): string {
 return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ranger-token" content="${token}">
<title>Ranger</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e3e3de; --accent:#2f6fde; --warn:#b4561b; --ok:#2b7a3d; }
@media (prefers-color-scheme: dark) { :root { --bg:#151515; --fg:#e8e8e3; --muted:#9a9a93; --card:#1e1e1e; --line:#2e2e2b; --accent:#7aa7ff; --warn:#e2925a; --ok:#6cc17e; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; padding:16px 20px; border-bottom:1px solid var(--line); }
header h1 { margin:0; font-size:18px; }
header .meta { color:var(--muted); font-size:12px; }
header button { margin-left:auto; }
main { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:16px; padding:16px 20px; }
section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; min-width:0; }
section h2 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
h3 { margin:12px 0 4px; font-size:13px; }
ul { list-style:none; margin:0; padding:0; }
li { padding:6px 0; border-top:1px solid var(--line); display:flex; gap:8px; align-items:baseline; }
li:first-child { border-top:0; }
li .t { flex:1; min-width:0; overflow-wrap:anywhere; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.id { font-variant-numeric:tabular-nums; color:var(--muted); white-space:nowrap; }
.tag { font-size:11px; padding:1px 6px; border-radius:10px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
.stale { color:var(--warn); border-color:var(--warn); }
.empty, .why { color:var(--muted); font-size:12px; }
.reason { color:var(--muted); font-size:12px; display:block; }
button { font:inherit; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid var(--line); background:transparent; color:var(--fg); cursor:pointer; white-space:nowrap; }
button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
button:disabled { opacity:.45; cursor:default; }
#msg { padding:0 20px; color:var(--ok); min-height:1em; font-size:12px; }
#msg.err { color:var(--warn); }
</style>
</head>
<body>
<header><h1>Ranger</h1><span class="meta" id="meta">loading…</span><button id="refresh" title="Re-reads only the maps this dashboard reads itself; ranger's maps come from its tick">Refresh</button></header>
<div id="msg"></div>
<main>
<section><h2>Current job</h2><div id="current"></div></section>
<section><h2>Substrates</h2><div id="substrates"></div></section>
<section><h2>Next in queue</h2><div id="next"></div></section>
<section><h2>Autonomous — ranger can take these</h2><div id="auto"></div></section>
<section><h2>Open grillings</h2><div id="grill"></div></section>
</main>
<script>
const TOKEN = document.querySelector('meta[name="ranger-token"]').content;
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n[k] = v; } for (const c of kids) if (c) n.append(c); return n; };
const link = (url, text) => el("a", { href: url, target: "_blank", rel: "noopener", text });
const empty = (text) => el("p", { class: "empty", text });
const ago = (iso) => { if (!iso) return "never"; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 90 ? s + " s ago" : Math.round(s / 60) + " min ago"; };
function say(text, err) { const m = document.getElementById("msg"); m.textContent = text; m.className = err ? "err" : ""; }
async function post(path, body) { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-ranger-token": TOKEN }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }
const unavailable = (m, none) => empty(m.ok ? none : "Frontier unavailable: " + (m.error || "not read yet"));
const mapHead = (m, extra) => el("h3", { text: m.repo + " · map #" + m.root + (extra || "") + " · read " + ago(m.readAt) + (m.source === "ranger" ? " by ranger" : " by this dashboard") });
function renderMeta(s) {
 const g = s.gates;
 document.getElementById("meta").textContent = "maps read by ranger's tick, shown from its cache" + (s.refreshing ? " · dashboard reading…" : "") + (s.refreshError ? " · dashboard read: " + s.refreshError : "") + " · spawns today " + g.spawnsToday + "/" + g.spawnCap + (g.paused ? " · DEAD-MAN PAUSED" : "");
}
function jobTag(j) {
 if (j.stale) return el("span", { class: "tag stale", text: "stale: process gone" });
 const parts = [j.status, j.phase, j.prNumber ? "PR #" + j.prNumber : "", j.reviewRound ? "round " + j.reviewRound : ""];
 return el("span", { class: "tag", text: parts.filter(Boolean).join(" · ") });
}
function renderCurrent(s) {
 const box = document.getElementById("current"); box.replaceChildren();
 if (s.current.length === 0) { box.append(empty("No worker is running.")); return; }
 box.append(el("ul", {}, ...s.current.map((j) => el("li", {}, el("span", { class: "id", text: "#" + j.nodeId }), el("span", { class: "t", text: (j.title || "(title not in the frontier read)") + " — " + j.repo }), jobTag(j)))));
}
function renderNext(s) {
 const box = document.getElementById("next"); box.replaceChildren();
 for (const m of s.maps) {
  box.append(mapHead(m));
  const n = m.next;
  if (!n.nodeId) { box.append(empty(n.reason)); continue; }
  box.append(el("p", {}, el("span", { class: "id", text: "#" + n.nodeId + " " }), link(n.url, n.title), el("span", { class: "reason", text: (n.lane ? n.lane + " lane · " : "") + n.reason })));
 }
}
function renderAuto(s) {
 const box = document.getElementById("auto"); box.replaceChildren();
 for (const m of s.maps) {
  if (m.servedOnly) continue;
  box.append(mapHead(m, " (walk: " + m.walk + ")"));
  if (m.autonomous.length === 0) { box.append(unavailable(m, "None.")); continue; }
  box.append(el("ul", {}, ...m.autonomous.map((n) => el("li", {}, el("span", { class: "id", text: "#" + n.id }), el("span", { class: "t" }, link(n.url, n.title)), el("span", { class: "tag", text: n.lane + " · " + n.kind })))));
 }
}
function grillButton(m, g) {
 const b = el("button", { text: "Start session", disabled: !g.launchable, title: g.why || "Open iTerm2 in " + m.localCheckout + " and start claude on #" + g.id });
 b.onclick = async () => {
  b.disabled = true;
  try { await post("/api/grill", { key: m.key, id: g.id }); say("Opened a session on #" + g.id + " in iTerm2."); }
  catch (e) { say("Could not start #" + g.id + ": " + e.message, true); }
  finally { setTimeout(() => (b.disabled = !g.launchable), 3000); }
 };
 return b;
}
function renderGrill(s) {
 const box = document.getElementById("grill"); box.replaceChildren();
 for (const m of s.maps) {
  box.append(mapHead(m, m.servedOnly ? " (shown only)" : ""));
  if (m.grillings.length === 0) { box.append(unavailable(m, "None open.")); continue; }
  box.append(el("ul", {}, ...m.grillings.map((g) => el("li", {}, el("span", { class: "id", text: "#" + g.id }), el("span", { class: "t" }, link(g.url, g.title)), grillButton(m, g)))));
 }
}
function renderSubstrates(s) {
 const box = document.getElementById("substrates"); box.replaceChildren();
 if (!s.substrates || s.substrates.length === 0) { box.append(empty("No substrate readings yet.")); return; }
 box.append(el("ul", {}, ...s.substrates.map((sub) => {
  const parts = [sub.substrate.toUpperCase()];
  if (sub.fiveHourUsedPct !== null) parts.push("5h: " + sub.fiveHourUsedPct + "%");
  if (sub.sevenDayUsedPct !== null) parts.push("7d: " + sub.sevenDayUsedPct + "%");
  if (sub.resetsAt) parts.push("resets " + new Date(sub.resetsAt).toLocaleString());
  parts.push("read " + ago(sub.readAt));
  const until = sub.cappedUntil && new Date(sub.cappedUntil).getTime() > Date.now() ? sub.cappedUntil : null;
  const capped = sub.capped || until !== null;
  if (capped) parts.push("CAPPED until " + (until ? new Date(until).toLocaleString() : "next reading"));
  return el("li", {}, el("span", { class: "t", text: parts.join(" · ") }), el("span", { class: capped ? "tag stale" : "tag", text: capped ? "capped" : "ok" }));
 })));
}
function render(s) { renderMeta(s); renderCurrent(s); renderSubstrates(s); renderNext(s); renderAuto(s); renderGrill(s); }
async function load() { try { const r = await fetch("/api/state", { cache: "no-store" }); render(await r.json()); } catch (e) { say("Could not read state: " + e.message, true); } }
document.getElementById("refresh").onclick = async () => { try { await post("/api/refresh"); say("Refreshing the frontier…"); setTimeout(load, 1500); } catch (e) { say(e.message, true); } };
load(); setInterval(load, 15000);
</script>
</body>
</html>`;
}

// ---- the server ----

/**
 * **The dashboard spends almost none of the principal's GitHub budget.**
 * Ranger's read-only PATs belong to the principal (`budget.ts`), so every
 * GraphQL point serve spends is one their own `gh`, sage and Claude sessions
 * cannot. So:
 *
 * - a registered map is shown from the frontier the tick cached in the
 *   journal (`frontier-cache.ts`) — no GitHub call at all;
 * - a serve-only map (#38) is read here, one map at a time, at most every
 *   `serve.refreshSec`, and only while the journal shows no cooldown on the
 *   token and `/rate_limit` (free) shows the allowance above
 *   `budget.graphqlFloor`; a refusal backs off in memory, doubling to an hour;
 * - the titles of in-flight nodes and the launch check use REST
 *   (`/repos/{repo}/issues/{id}`), a separate bucket from GraphQL.
 */
export class ServeReader {
 extra = new Map<string, MapRead>();
 titles = new Map<string, string>();
 refreshing = false;
 lastError: string | null = null;
 private backoffUntil = 0;
 private strikes = 0;
 private wantedTitles = new Set<string>();

 constructor(
  private readonly config: RangerConfig,
  private readonly maps: ServeMap[],
  private readonly journalPath: string,
 ) {}

 /** Ask for titles of nodes no frontier names; fetched on the next refresh. */
 want(keys: string[]): void {
  for (const key of keys) if (!this.titles.has(key)) this.wantedTitles.add(key);
 }

 refresh(): void {
  if (this.refreshing) return;
  this.refreshing = true;
  this.run()
   .then(() => {
    this.lastError = null;
   })
   .catch((error) => {
    this.lastError = error instanceof Error ? error.message : String(error);
   })
   .finally(() => {
    this.refreshing = false;
   });
 }

 private async run(): Promise<void> {
  const now = new Date();
  if (now.getTime() < this.backoffUntil) {
   throw new Error(`backing off GitHub until ${new Date(this.backoffUntil).toISOString()}`);
  }
  const registry = loadProbeRegistry();
  for (const map of this.maps.filter((m) => m.servedOnly)) {
   const prev = this.extra.get(map.key);
   const keep = (error: string): void => {
    this.extra.set(map.key, {
     ok: prev?.ok ?? false,
     frontier: prev?.frontier ?? [],
     readAt: prev?.readAt ?? null,
     source: "serve",
     error,
    });
   };
   const { token } = await assertReadOnlyToken(this.config, map.repo);
   const journal = Journal.openReadOnly(this.journalPath);
   const cooling = journal === null ? null : activeCooldown(journal, token.source, now);
   journal?.close();
   if (cooling !== null) {
    keep(`deferred: ${token.source} cooling down until ${cooling.until.toISOString()} (${cooling.reason})`);
    continue;
   }
   const budget = await readGraphqlBudget(token.token);
   if (budget !== null && budget.remaining < this.config.budget.graphqlFloor) {
    keep(`deferred: GraphQL allowance ${budget.remaining}/${budget.limit} under the floor of ${this.config.budget.graphqlFloor}`);
    continue;
   }
   try {
    const read = await graphFrontier(map.repo, map.root, token);
    this.extra.set(map.key, {
     ok: true,
     frontier: read.frontier.map((e: FrontierEntry) =>
      classify(e, map.repo, "none", registry, { botIdentity: this.config.bot.identity }),
     ),
     readAt: now.toISOString(),
     source: "serve",
    });
    this.strikes = 0;
   } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    this.strikes += 1;
    const ms = Math.min(
     this.config.budget.rateLimitCooldownMin * 60_000 * 2 ** (this.strikes - 1),
     60 * 60_000,
    );
    this.backoffUntil = now.getTime() + ms;
    keep(`GitHub refused the read; backing off until ${new Date(this.backoffUntil).toISOString()}`);
    return;
   }
  }
  for (const key of [...this.wantedTitles]) {
   const [repo, id] = key.split("#");
   const issue = await readIssue(this.config, repo, id);
   if (issue !== null) this.titles.set(key, issue.title);
   this.wantedTitles.delete(key);
  }
 }
}

interface IssueRead {
 title: string;
 state: string;
 assignees: string[];
 kind: string | null;
}

/** One issue over REST under the read-only gate: no GraphQL. Null if unreadable. */
async function readIssue(
 config: RangerConfig,
 repo: string,
 id: string,
): Promise<IssueRead | null> {
 if (!REPO_PATTERN.test(repo) || !ID_PATTERN.test(id)) return null;
 const { token } = await assertReadOnlyToken(config, repo);
 const gated = gatedEnv(token.token);
 try {
  const result = await runCmd("gh", ["api", `repos/${repo}/issues/${id}`], {
   env: gated.env,
   timeoutMs: 15_000,
  });
  if (result.code !== 0) return null;
  const raw = JSON.parse(result.stdout) as {
   title?: string;
   state?: string;
   assignees?: { login?: string }[];
   body?: string | null;
  };
  // The node's kind is in its typed block, which the verbs write (#89-style
  // `soma:work-graph-node` JSON in an HTML comment).
  const block = /<!--\s*soma:work-graph-node\s*([\s\S]*?)-->/.exec(raw.body ?? "")?.[1];
  let kind: string | null = null;
  if (block !== undefined) {
   try {
    kind = (JSON.parse(block) as { kind?: string }).kind ?? null;
   } catch {
    kind = null;
   }
  }
  return {
   title: raw.title ?? "",
   state: raw.state ?? "unknown",
   assignees: (raw.assignees ?? []).map((a) => a.login ?? "").filter(Boolean),
   kind,
  };
 } finally {
  gated.cleanup();
 }
}

export function stateFromJournal(
 config: RangerConfig,
 maps: ServeMap[],
 reader: ServeReader,
 now = new Date(),
): DashboardState {
 const journal = Journal.openReadOnly(expandHome(config.state.journalPath));
 try {
  const registry = loadProbeRegistry();
  const reports = new Map<string, MapRead>();
  for (const map of maps) {
   if (map.servedOnly) {
    reports.set(
     map.key,
     reader.extra.get(map.key) ?? {
      ok: false,
      error: "not read yet",
      frontier: [],
      readAt: null,
      source: "serve",
     },
    );
    continue;
   }
   const cached = journal === null ? null : cachedFrontier(journal, map.repo, map.root);
   reports.set(
    map.key,
    cached === null
     ? {
        ok: false,
        error: "ranger has not cached this map's frontier yet; the next tick does",
        frontier: [],
        readAt: null,
        source: "ranger",
       }
     : {
        ok: true,
        frontier: cached.frontier.frontier.map((e) =>
         classify(e, map.repo, map.walk, registry, {
          botIdentity: config.bot.identity,
          allowlist: map.nodes,
          skip: map.skip,
         }),
        ),
        readAt: cached.fetchedAt,
        source: "ranger",
       },
   );
  }
  const vetoed = journal?.listVetoes() ?? new Set<string>();
  const state = assembleState({
   maps,
   reports,
   titles: reader.titles,
   workers: journal?.listWorkers() ?? [],
   laneHolder: journal?.implementLaneHolder() ?? null,
   paused: journal?.isPaused() ?? false,
   spawnsToday: journal?.spawnsToday(now) ?? 0,
   spawnCap: config.workers.spawnCapPerDay,
   vetoed: (id) => vetoed.has(id),
   pidAlive: defaultPidAlive,
   refreshing: reader.refreshing,
   refreshError: reader.lastError,
   now,
   substrateReadings: journal?.listSubstrateReadings() ?? [],
  });
  reader.want(
   state.current.filter((j) => j.title === null).map((j) => `${j.repo}#${j.nodeId}`),
  );
  return state;
 } finally {
  journal?.close();
 }
}

/** The live check behind `verifyGrilling`: one REST read under the read-only gate. */
export async function verifyGrillingLive(
 config: RangerConfig,
 map: DashboardMap,
 nodeId: string,
): Promise<string | null> {
 try {
  const issue = await readIssue(config, map.repo, nodeId);
  if (issue === null) return `could not read #${nodeId} live`;
  if (issue.state !== "open") return `#${nodeId} is ${issue.state} now`;
  if (issue.kind !== "grilling") return `#${nodeId} is a ${issue.kind ?? "untyped node"} now`;
  if (issue.assignees.length > 0) return `#${nodeId} is claimed by ${issue.assignees.join(", ")}`;
  return null;
 } catch (error) {
  return `could not read #${nodeId} live: ${error instanceof Error ? error.message : String(error)}`;
 }
}

export function startServe(opts: {
 config: RangerConfig;
 port?: number;
 open?: boolean;
}): { url: string; stop: () => void } {
 const serve = serveConfig(opts.config);
 const port = opts.port ?? serve.port;
 const token = randomBytes(24).toString("hex");
 const maps = servedMaps(opts.config);
 const reader = new ServeReader(
  opts.config,
  maps,
  expandHome(opts.config.state.journalPath),
 );
 reader.refresh();
 const timer = setInterval(() => reader.refresh(), serve.refreshSec * 1000);
 const handler = createHandler({
  port,
  token,
  getState: () => stateFromJournal(opts.config, maps, reader),
  refresh: () => reader.refresh(),
  launch: spawnLaunch,
  verifyGrilling: (map, nodeId) => verifyGrillingLive(opts.config, map, nodeId),
 });
 const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
 const url = `http://127.0.0.1:${port}/`;
 if (opts.open === true) spawnLaunch(["open", url], childEnv(process.env));
 return {
  url,
  stop: () => {
   clearInterval(timer);
   server.stop();
  },
 };
}

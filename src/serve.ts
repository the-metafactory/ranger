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
 * an open grilling on the current frontier.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
 expandHome,
 type RangerConfig,
 serveConfig,
 type WalkMode,
} from "./config.ts";
import { implementCandidates, selectCandidates } from "./candidates.ts";
import { pidAlive as defaultPidAlive } from "./exec.ts";
import { Journal, type WorkerRow } from "./journal.ts";
import type { MapReport } from "./report.ts";
import { type ClassifiedNode, loadProbeRegistry } from "./route.ts";
import { scoutOneMap } from "./scout.ts";

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const ID_PATTERN = /^\d+$/;

/** A map the dashboard shows: a registered one, or a serve-only extra (#38). */
export interface ServeMap {
 /** `owner/name#root` — two maps may share a repo. */
 key: string;
 repo: string;
 root: number;
 walk: WalkMode;
 /** Shown here only: ranger neither walks nor scouts it elsewhere. */
 servedOnly: boolean;
 /** The principal's checkout, `~` expanded; unset means no session button. */
 localCheckout?: string;
 nodes?: string[];
 skip?: string[];
}

export function servedMaps(config: RangerConfig): ServeMap[] {
 const local = (path: string | undefined) =>
  path === undefined ? undefined : expandHome(path);
 const maps: ServeMap[] = config.maps.map((m) => ({
  key: `${m.repo}#${m.root}`,
  repo: m.repo,
  root: m.root,
  walk: m.walk,
  servedOnly: false,
  localCheckout: local(m.localCheckout),
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
   localCheckout: local(extra.localCheckout),
  });
 }
 return maps;
}

// ---- state ----

export interface StateInputs {
 maps: ServeMap[];
 /** Scout reports by `ServeMap.key`. */
 reports: Map<string, MapReport>;
 workers: WorkerRow[];
 laneHolder: WorkerRow | null;
 paused: boolean;
 spawnsToday: number;
 spawnCap: number;
 vetoed: (nodeId: string) => boolean;
 pidAlive: (pid: number | null) => boolean;
 frontierAt: string | null;
 refreshing: boolean;
 refreshError: string | null;
 now: Date;
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
 localCheckout?: string;
 next: NextJob;
 autonomous: NodeView[];
 grillings: GrillingView[];
}

export interface DashboardState {
 generatedAt: string;
 frontierAt: string | null;
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

function nextFor(
 map: ServeMap,
 report: MapReport | undefined,
 inputs: StateInputs,
): NextJob {
 const none = (reason: string): NextJob => ({ waiting: false, reason });
 if (map.servedOnly) return none("not walked by ranger yet: shown here only (#38)");
 if (report === undefined) return none("no frontier read yet");
 if (!report.ok) return none(`frontier unavailable: ${report.error ?? "unknown error"}`);
 if (map.walk === "none") return none("walk: none — registered, not walked");
 if (inputs.paused) return none("dead-man paused — claiming stopped until `ranger resume-run`");
 if (inputs.spawnsToday >= inputs.spawnCap) {
  return none(`daily spawn cap reached (${inputs.spawnsToday}/${inputs.spawnCap})`);
 }
 // walk's own order: select, then drop vetoed candidates (walk.ts).
 const laneBusy = inputs.laneHolder !== null;
 const { implement, research } = selectCandidates(report.frontier, laneBusy);
 const selected = [...implement, ...research];
 const first = selected.find((n) => !inputs.vetoed(n.id));
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
 const vetoed = selected.filter((n) => inputs.vetoed(n.id)).map((n) => `#${n.id}`);
 if (vetoed.length > 0) {
  return none(`${vetoed.join(", ")} vetoed — the tick claims nothing else this pass`);
 }
 if (laneBusy && inputs.laneHolder !== null) {
  const queued = implementCandidates(report.frontier).find((n) => !inputs.vetoed(n.id));
  if (queued !== undefined) {
   return {
    nodeId: queued.id,
    title: queued.title,
    url: queued.url,
    lane: "implement",
    waiting: true,
    reason: `waits for the implement lane, held by #${inputs.laneHolder.nodeId} (${inputs.laneHolder.repo})`,
   };
  }
 }
 return none("nothing walkable on this map's frontier");
}

export function assembleState(inputs: StateInputs): DashboardState {
 const titleOf = (repo: string, id: string): string | null => {
  for (const map of inputs.maps) {
   if (map.repo !== repo) continue;
   const report = inputs.reports.get(map.key);
   const hit =
    report?.claims.find((c) => c.id === id)?.title ??
    report?.frontier.find((n) => n.id === id)?.title;
   if (hit !== undefined) return hit;
  }
  return null;
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
   localCheckout: map.localCheckout,
   next: nextFor(map, report, inputs),
   autonomous: walked
    ? frontier
       .filter(
        (n) =>
         (n.route.route === "implement" || n.route.route === "research") &&
         n.route.walkable,
       )
       .map(view)
    : [],
   grillings: frontier
    .filter((n) => n.kind === "grilling")
    .map((n) => ({
     ...view(n),
     launchable: map.localCheckout !== undefined,
     why:
      map.localCheckout === undefined
       ? `no localCheckout for ${map.repo} in ranger.yaml`
       : undefined,
    })),
  };
 });

 const holder = inputs.laneHolder;
 return {
  generatedAt: inputs.now.toISOString(),
  frontierAt: inputs.frontierAt,
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
 child.unref();
}

// ---- HTTP ----

export interface HandlerContext {
 port: number;
 token: string;
 getState: () => DashboardState;
 refresh: () => void;
 launch: (argv: string[], env: Record<string, string>) => void;
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
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
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
<header><h1>Ranger</h1><span class="meta" id="meta">loading…</span><button id="refresh">Refresh frontier</button></header>
<div id="msg"></div>
<main>
<section><h2>Current job</h2><div id="current"></div></section>
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
function render(s) {
 document.getElementById("meta").textContent = "frontier read " + ago(s.frontierAt) + (s.refreshing ? " · refreshing…" : "") + (s.refreshError ? " · refresh failed: " + s.refreshError : "") + " · spawns today " + s.gates.spawnsToday + "/" + s.gates.spawnCap + (s.gates.paused ? " · DEAD-MAN PAUSED" : "");
 const cur = document.getElementById("current"); cur.replaceChildren();
 if (s.current.length === 0) cur.append(empty("No worker is running."));
 else cur.append(el("ul", {}, ...s.current.map((j) => el("li", {}, el("span", { class: "id", text: "#" + j.nodeId }), el("span", { class: "t", text: (j.title || "(title not in the frontier read)") + " — " + j.repo }), el("span", { class: "tag" + (j.stale ? " stale" : ""), text: j.stale ? "stale: process gone" : [j.status, j.phase, j.prNumber ? "PR #" + j.prNumber : "", j.reviewRound ? "round " + j.reviewRound : ""].filter(Boolean).join(" · ") })))));
 const next = document.getElementById("next"); next.replaceChildren();
 for (const m of s.maps) {
  next.append(el("h3", { text: m.repo + " · map #" + m.root }));
  const n = m.next;
  next.append(n.nodeId ? el("p", {}, el("span", { class: "id", text: "#" + n.nodeId + " " }), link(n.url, n.title), el("span", { class: "reason", text: (n.lane ? n.lane + " lane · " : "") + n.reason })) : empty(n.reason));
 }
 const auto = document.getElementById("auto"); auto.replaceChildren();
 for (const m of s.maps) {
  if (m.servedOnly) continue;
  auto.append(el("h3", { text: m.repo + " · map #" + m.root + " (walk: " + m.walk + ")" }));
  auto.append(m.autonomous.length === 0 ? empty(m.ok ? "None." : "Frontier unavailable: " + (m.error || "not read yet")) : el("ul", {}, ...m.autonomous.map((n) => el("li", {}, el("span", { class: "id", text: "#" + n.id }), el("span", { class: "t" }, link(n.url, n.title)), el("span", { class: "tag", text: n.lane + " · " + n.kind })))));
 }
 const grill = document.getElementById("grill"); grill.replaceChildren();
 for (const m of s.maps) {
  grill.append(el("h3", { text: m.repo + " · map #" + m.root + (m.servedOnly ? " (shown only)" : "") }));
  if (m.grillings.length === 0) { grill.append(empty(m.ok ? "None open." : "Frontier unavailable: " + (m.error || "not read yet"))); continue; }
  grill.append(el("ul", {}, ...m.grillings.map((g) => { const b = el("button", { text: "Start session", disabled: !g.launchable, title: g.why || "Open iTerm2 in " + m.localCheckout + " and start claude on #" + g.id }); b.onclick = async () => { b.disabled = true; try { await post("/api/grill", { key: m.key, id: g.id }); say("Opened a session on #" + g.id + " in iTerm2."); } catch (e) { say("Could not start #" + g.id + ": " + e.message, true); } finally { setTimeout(() => (b.disabled = !g.launchable), 3000); } }; return el("li", {}, el("span", { class: "id", text: "#" + g.id }), el("span", { class: "t" }, link(g.url, g.title)), b); })));
 }
}
async function load() { try { const r = await fetch("/api/state", { cache: "no-store" }); render(await r.json()); } catch (e) { say("Could not read state: " + e.message, true); } }
document.getElementById("refresh").onclick = async () => { try { await post("/api/refresh"); say("Refreshing the frontier…"); setTimeout(load, 1500); } catch (e) { say(e.message, true); } };
load(); setInterval(load, 15000);
</script>
</body>
</html>`;
}

// ---- the server ----

/** One background frontier read at a time; the last good one is kept. */
export class FrontierCache {
 reports = new Map<string, MapReport>();
 at: string | null = null;
 refreshing = false;
 error: string | null = null;

 constructor(private readonly read: () => Promise<Map<string, MapReport>>) {}

 refresh(): void {
  if (this.refreshing) return;
  this.refreshing = true;
  this.read()
   .then((reports) => {
    this.reports = reports;
    this.at = new Date().toISOString();
    this.error = null;
   })
   .catch((error) => {
    this.error = error instanceof Error ? error.message : String(error);
   })
   .finally(() => {
    this.refreshing = false;
   });
 }
}

export async function readReports(
 config: RangerConfig,
 maps: ServeMap[],
): Promise<Map<string, MapReport>> {
 const registry = loadProbeRegistry();
 const reports = new Map<string, MapReport>();
 for (const map of maps) {
  reports.set(
   map.key,
   await scoutOneMap(
    config,
    { repo: map.repo, root: map.root, walk: map.walk, nodes: map.nodes, skip: map.skip },
    registry,
   ),
  );
 }
 return reports;
}

export function stateFromJournal(
 config: RangerConfig,
 maps: ServeMap[],
 cache: FrontierCache,
 now = new Date(),
): DashboardState {
 const journal = Journal.openReadOnly(expandHome(config.state.journalPath));
 try {
  const vetoed = new Set<string>();
  if (journal !== null) {
   for (const report of cache.reports.values()) {
    for (const node of report.frontier) if (journal.hasVeto(node.id)) vetoed.add(node.id);
   }
  }
  return assembleState({
   maps,
   reports: cache.reports,
   workers: journal?.listWorkers() ?? [],
   laneHolder: journal?.implementLaneHolder() ?? null,
   paused: journal?.isPaused() ?? false,
   spawnsToday: journal?.spawnsToday(now) ?? 0,
   spawnCap: config.workers.spawnCapPerDay,
   vetoed: (id) => vetoed.has(id),
   pidAlive: defaultPidAlive,
   frontierAt: cache.at,
   refreshing: cache.refreshing,
   refreshError: cache.error,
   now,
  });
 } finally {
  journal?.close();
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
 const cache = new FrontierCache(() => readReports(opts.config, maps));
 cache.refresh();
 const timer = setInterval(() => cache.refresh(), serve.refreshSec * 1000);
 const handler = createHandler({
  port,
  token,
  getState: () => stateFromJournal(opts.config, maps, cache),
  refresh: () => cache.refresh(),
  launch: spawnLaunch,
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

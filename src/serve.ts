import { lastImplementMaps, mapKey, implementMapOrder } from "./maps.ts";
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
 *
 * **"Needs you" actions run outside this process (node #54).** The parked,
 * failed and needs-eye rows (`serve-parked.ts`) carry buttons, and each one
 * only spawns an existing CLI verb (`ranger resume-node`), `gh pr merge` with
 * no machine-account token or gh config in its environment (gh uses the login
 * stored under HOME; which account that is goes unchecked), or
 * the iTerm2 launch above. The process itself still writes nothing: the
 * journal stays read-only here and no graph write is imported. Each action is
 * guarded like the launch — Host, Origin, page token, a numeric id — and the
 * id must name a row the journal holds in the action's state when the request
 * is read.
 *
 * **Build now (node #58) is the principal's own CLI verb, run for them.** The
 * button spawns `~/bin/ranger build-now <id> --map <repo#root> --force` with
 * the same allowlisted environment (the wrapper injects the machine account's
 * credentials itself), for a node this dashboard reads as walkable on the
 * map's cached frontier at the moment of the request. Every graph write is
 * the verb's, in its own process: this module still imports none.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import { implementLane, workerLane, type ImplementLane } from "./lanes.ts";
import { activeCooldown, readGraphqlBudget } from "./budget.ts";
import { cachedFrontier } from "./frontier-cache.ts";
import { type FrontierEntry, graphFrontier, RateLimitError } from "./graph.ts";
import { runCmd } from "./exec.ts";
import { classify, classifyFrontier, type ClassifiedNode, loadProbeRegistry } from "./route.ts";
import { liveSession, substrateUsageViews, type SubstrateUsageView } from "./substrate-usage.ts";
import { assertReadOnlyToken, gatedEnv, tokenBatch, type TokenBatch } from "./token-gate.ts";
import { childEnv, itermArgv, shellQuote } from "./launch.ts";
import {
 type ActionKind,
 type ActionRunner,
 checkRunsFromPages,
 ciState,
 needsYouEntries,
 type NeedsYouEntry,
 type PrView,
 runAction,
 uncheckedNeedsEye,
} from "./serve-parked.ts";

export { childEnv };

const ID_PATTERN = /^\d+$/;

/** A map the dashboard shows: a registered one, or a serve-only extra (#38). */
export interface ServeMap {
 /** `owner/name#root` — two maps may share a repo. */
 key: string;
 repo: string;
 root: number;
 walk: WalkMode;
 lane: ImplementLane;
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
  lane: implementLane(m),
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
   lane: "headless",
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
 lastImplementMaps?: Partial<Record<ImplementLane, string | null>>;
 /** Frontier reads by `ServeMap.key`. */
 reports: Map<string, MapRead>;
 /** Titles of in-flight nodes not on any frontier, by `repo#id`. */
 titles: Map<string, string>;
 workers: WorkerRow[];
 laneHolders: Record<ImplementLane, WorkerRow | null>;
 paused: boolean;
 spawnsToday: number;
 spawnCap: number;
 vetoed: (nodeId: string) => boolean;
 pidAlive: (pid: number | null) => boolean;
 refreshing: boolean;
 refreshError: string | null;
 now: Date;
 /** Every substrate's limits and sessions, as the panel shows them (node #56). */
 substrates?: SubstrateUsageView[];
 /** Parked, failed and needs-eye rows (node #54). */
 needsYou?: NeedsYouEntry[];
 /** Awaiting-merge rows whose labels are not known yet, with the read's error. */
 needsYouUnchecked?: UncheckedRow[];
}

/** An awaiting-merge row that may need the principal's eye; its labels are unknown. */
export interface UncheckedRow {
 key: string;
 /** The last failed read of its labels; null while it is only unread. */
 error: string | null;
}

export interface CurrentJob {
 repo: string;
 nodeId: string;
 title: string | null;
 status: WorkerRow["status"];
 phase: WorkerRow["phase"];
 lane: string | null;
 resourceLane: ImplementLane | null;
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
 lane: ImplementLane;
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

export interface DashboardState {
 generatedAt: string;
 refreshing: boolean;
 refreshError: string | null;
 gates: {
  paused: boolean;
  spawnsToday: number;
  spawnCap: number;
  laneHolders: Record<ImplementLane, { repo: string; root: number; nodeId: string; status: string } | null>;
 };
 current: CurrentJob[];
 maps: DashboardMap[];
 substrates: SubstrateUsageView[];
 needsYou: NeedsYouEntry[];
 needsYouUnchecked: UncheckedRow[];
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
 * persisted rotation order, and an earlier map's claims take the implement lane and
 * count against the shared daily cap before a later map is planned.
 */
interface TickSoFar {
 holders: Record<ImplementLane, { repo: string; nodeId: string; thisTick: boolean } | null>;
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
 const holder = tick.holders[map.lane];
 const plan = planTick(report.frontier, {
  laneBusy: holder !== null,
  vetoed: inputs.vetoed,
 });
 // What this map spends of the tick, for the maps after it.
 const claims = plan.take.slice(0, inputs.spawnCap - tick.spawns);
 tick.spawns += claims.length;
 const implementClaim = claims.find((n) => plan.implement.includes(n));
 if (implementClaim !== undefined) {
  tick.holders[map.lane] = { repo: map.key, nodeId: implementClaim.id, thisTick: true };
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
    ? `waits for the ${map.lane} implement lane: this tick claims #${holder.nodeId} (${holder.repo}) first`
    : `waits for the ${map.lane} implement lane, held by #${holder.nodeId} (${holder.repo})`,
  };
 }
 const vetoed = plan.vetoed.map((n) => `#${n.id}`);
 if (vetoed.length > 0) {
  return none(`${vetoed.join(", ")} vetoed — the tick claims nothing else this pass`);
 }
 return none("nothing walkable on this map's frontier");
}

export function assembleState(inputs: StateInputs): DashboardState {
 const laneMaps = inputs.maps.filter((m) => !m.servedOnly).map((m) => ({ ...m, commands: {} }));
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
   resourceLane: w.lane === "implement" ? workerLane(w, laneMaps) : null,
   prNumber: w.prNumber,
   reviewRound: w.reviewRound,
   startedAt: w.startedAt,
   pid: w.pid,
   stale:
    (w.status === "claimed" || w.status === "running") &&
    w.pid !== null &&
    !inputs.pidAlive(w.pid),
  }));

 const tickHolder = (lane: ImplementLane) => {
  const holder = inputs.laneHolders[lane];
  return holder === null ? null : { repo: mapKey(holder), nodeId: holder.nodeId, thisTick: false };
 };
 const tick: TickSoFar = {
  holders: { visual: tickHolder("visual"), headless: tickHolder("headless") },
  spawns: inputs.spawnsToday,
 };
 // Plan in the walk's rotation order; retain config order for display.
 const planned = new Map<string, NextJob>();
 for (const map of implementMapOrder(inputs.maps, inputs.lastImplementMaps ?? {}, m => m.lane)) {
  planned.set(map.key, nextFor(map, inputs.reports.get(map.key), inputs, tick));
 }
 const maps: DashboardMap[] = inputs.maps.map((map) => {
  const report = inputs.reports.get(map.key);
  const frontier = report?.ok ? report.frontier : [];
  const walked = !map.servedOnly && map.walk !== "none";
  return {
   key: map.key,
   repo: map.repo,
   root: map.root,
   walk: map.walk,
   lane: map.lane,
   servedOnly: map.servedOnly,
   ok: report?.ok ?? false,
   error: report?.error,
   readAt: report?.readAt ?? null,
   source: report?.source ?? (map.servedOnly ? "serve" : "ranger"),
   localCheckout: map.localCheckout,
   next: planned.get(map.key)!,
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

 const holderView = (lane: ImplementLane) => {
  const holder = inputs.laneHolders[lane];
  return holder === null ? null : { repo: holder.repo, root: holder.root, nodeId: holder.nodeId, status: holder.status };
 };
 return {
  generatedAt: inputs.now.toISOString(),
  refreshing: inputs.refreshing,
  refreshError: inputs.refreshError,
  gates: {
   paused: inputs.paused,
   spawnsToday: inputs.spawnsToday,
   spawnCap: inputs.spawnCap,
   laneHolders: { visual: holderView("visual"), headless: holderView("headless") },
  },
  current,
  maps,
  substrates: inputs.substrates ?? [],
  needsYou: inputs.needsYou ?? [],
  needsYouUnchecked: inputs.needsYouUnchecked ?? [],
 };
}

// ---- the launch ----

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
 return { prompt, shellCommand, argv: itermArgv(shellCommand) };
}

/** The token-injecting wrapper every scheduled ranger run goes through (node #11). */
export const RANGER_BIN = "~/bin/ranger";

/** The CLI the Build now button runs: `build-now --force`, nothing a principal can't type. */
export function buildNowArgv(args: {
 bin: string;
 key: string;
 nodeId: string;
 configPath: string;
}): string[] {
 if (!ID_PATTERN.test(args.nodeId)) throw new Error(`bad node id: ${args.nodeId}`);
 const [repo, root] = args.key.split("#");
 if (!REPO_PATTERN.test(repo) || !ID_PATTERN.test(root ?? "")) throw new Error(`bad map: ${args.key}`);
 return [args.bin, "build-now", args.nodeId, "--map", args.key, "--force", "--config", args.configPath];
}

export interface VerbRun {
 /** The verb's exit code; null while it still runs past the wait (it is never killed). */
 code: number | null;
 /** The last lines of stdout and stderr together. */
 tail: string;
}

const TAIL_LINES = 20;
/** The verb's own reads, announce, claim and lock wait are each bounded; past this the page stops waiting. */
const BUILD_NOW_WAIT_MS = 180_000;

/**
 * Run a ranger verb detached in its own process group and wait for its exit:
 * the verb returns once its run-node is spawned, and that worker (detached
 * again, stdio ignored) outlives both. A verb still running past the wait is
 * left to finish: killing it could land between its graph claim and its
 * `claimed` row. The answer then says it is still running, with no exit code,
 * and the page re-reads state.
 */
export function runVerb(argv: string[], env: Record<string, string>, waitMs = BUILD_NOW_WAIT_MS): Promise<VerbRun> {
 return new Promise((resolveRun) => {
  const [command, ...args] = argv;
  let out = "";
  let settled = false;
  const settle = (run: VerbRun) => {
   if (settled) return;
   settled = true;
   clearTimeout(timer);
   resolveRun(run);
  };
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const take = (chunk: Buffer) => {
   out = (out + chunk.toString()).slice(-16_000);
  };
  // The pipes stay read after a timed-out answer, so the verb never blocks on a full one.
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const tail = () => out.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  const timer = setTimeout(() => {
   settle({
    code: null,
    tail: `${tail()}\n(still running after ${Math.round(waitMs / 1000)} s, pid ${child.pid ?? "?"}; not killed: \`ranger journal\` shows how it ends)`.trimStart(),
   });
  }, waitMs);
  child.on("error", (error) => {
   settle({ code: -1, tail: `could not start ${command}: ${error.message}` });
  });
  child.on("close", (code, signal) => {
   settle({ code: code ?? (signal === null ? -1 : 128), tail: tail() });
  });
 });
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
 /** Build now (node #58); unset refuses it. */
 buildNow?: {
  /** The `build-now --force` argv for a node; null when serve has no config path to run it with. */
  command: (map: DashboardMap, nodeId: string) => string[] | null;
  /** Run a verb and wait for its exit code and output tail. */
  runVerb: (argv: string[], env: Record<string, string>) => Promise<VerbRun>;
 };
 /** The "Needs you" actions (node #54); unset refuses them. */
 actions?: {
  run: ActionRunner;
  /** The environment the children are built from (default: this process's). */
  env?: Record<string, string | undefined>;
  /** `~/bin/ranger`, expanded. */
  rangerBin: string;
  /** The ranger.yaml serve was started with; `resume-node` gets the same one. */
  configPath?: string;
  readPr: (repo: string, pr: number) => Promise<PrView | null>;
  exists: (path: string) => boolean;
  /** Called after an action ran, to re-read what it changed. */
  after?: (entry: NeedsYouEntry) => void;
 };
}

const ACTION_PATHS: Record<string, ActionKind> = {
 "/api/resume": "resume",
 "/api/merge": "merge",
 "/api/session": "session",
};

const json = (status: number, body: unknown): Response =>
 new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
 });

const refuse = (status: number, error: string): Response => json(status, { error });

/** A POST body that parses to a JSON object; null for anything else (`null`, an array, a number, bad JSON). */
async function readObject(req: Request): Promise<Record<string, unknown> | null> {
 try {
  const body: unknown = await req.json();
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
 } catch {
  return null;
 }
}

function tokenMatches(given: string | null, token: string): boolean {
 if (given === null) return false;
 const a = Buffer.from(given);
 const b = Buffer.from(token);
 return a.length === b.length && timingSafeEqual(a, b);
}

export function createHandler(ctx: HandlerContext): (req: Request) => Promise<Response> {
 const hosts = [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`];
 const inFlight = new Set<string>();
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
  const action = ACTION_PATHS[url.pathname];
  if (action !== undefined) {
   if (ctx.actions === undefined) return refuse(501, "actions are not wired in this server");
   const body = await readObject(req);
   if (body === null) return refuse(400, "body is not a JSON object");
   const actions = ctx.actions;
   const result = await runAction(action, body, {
    entries: ctx.getState().needsYou,
    run: actions.run,
    env: actions.env ?? process.env,
    rangerBin: actions.rangerBin,
    configPath: actions.configPath,
    readPr: actions.readPr,
    exists: actions.exists,
    inFlight,
   });
   if (result.entry !== undefined) actions.after?.(result.entry);
   return json(result.status, result.body);
  }
  if (url.pathname !== "/api/grill" && url.pathname !== "/api/build-now") {
   return refuse(404, "not found");
  }

  const body: { key?: unknown; id?: unknown; dryRun?: unknown } | null = await readObject(req);
  if (body === null) return refuse(400, "body is not a JSON object");
  if (typeof body.key !== "string" || typeof body.id !== "string") {
   return refuse(400, "key and id are required strings");
  }
  if (!ID_PATTERN.test(body.id)) return refuse(400, "id must be numeric");
  const state = ctx.getState();
  const map = state.maps.find((m) => m.key === body.key);
  if (map === undefined) return refuse(404, `no map ${body.key}`);
  if (url.pathname === "/api/build-now") {
   // `autonomous` is the walkable set of the frontier ranger cached, read
   // from the journal for this request; the verb re-reads and re-checks it.
   const node = map.autonomous.find((n) => n.id === body.id);
   if (node === undefined) {
    return refuse(404, `#${body.id} is not walkable on ${map.key}'s frontier`);
   }
   if (ctx.buildNow === undefined) return refuse(501, "build now is not wired in this server");
   const argv = ctx.buildNow.command(map, node.id);
   if (argv === null) return refuse(409, "serve was started without a config path to build with");
   if (body.dryRun === true) return json(200, { dryRun: true, argv });
   const run = await ctx.buildNow.runVerb(argv, childEnv(process.env));
   return json(200, { nodeId: node.id, exitCode: run.code, tail: run.tail });
  }
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
#out { margin:4px 20px 0; padding:8px 10px; font:12px/1.4 ui-monospace, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--card); border:1px solid var(--line); border-radius:6px; }
#out:empty { display:none; }
#needs { grid-column:1 / -1; }
.card { border-top:1px solid var(--line); padding:8px 0; }
.card:first-child { border-top:0; }
.card .facts { color:var(--muted); font-size:12px; }
.card .acts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:6px; }
.card label { font-size:12px; color:var(--muted); }
.card pre { margin:6px 0 0; padding:6px 8px; font-size:11px; white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid var(--line); border-radius:6px; }
.card pre.err { color:var(--warn); border-color:var(--warn); }
.line { display:block; font-size:12px; }
.muted { opacity:.5; }
.warn { color:var(--warn); }
</style>
</head>
<body>
<header><h1>Ranger</h1><span class="meta" id="meta">loading…</span><button id="refresh" title="Re-reads only the maps this dashboard reads itself; ranger's maps come from its tick">Refresh</button></header>
<div id="msg"></div>
<pre id="out"></pre>
<main>
<section><h2>Current job</h2><div id="current"></div></section>
<section><h2>Substrates</h2><div id="substrates"></div></section>
<section><h2>Next in queue</h2><div id="next"></div></section>
<section><h2>Autonomous — ranger can take these</h2><div id="auto"></div></section>
<section id="needs"><h2>Needs you</h2><div id="needsyou"></div></section>
<section><h2>Open grillings</h2><div id="grill"></div></section>
</main>
<script>
const TOKEN = document.querySelector('meta[name="ranger-token"]').content;
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n[k] = v; } for (const c of kids) if (c) n.append(c); return n; };
const link = (url, text) => el("a", { href: url, target: "_blank", rel: "noopener", text });
const empty = (text) => el("p", { class: "empty", text });
const ago = (iso) => { if (!iso) return "never"; const s = Math.round((Date.now() - Date.parse(iso)) / 1000); const m = Math.round(s / 60); return s < 90 ? s + " s ago" : m < 90 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
// The page token rotates when serve restarts: a refused one means this page is stale.
const REFUSED = "token refused";
const RELOAD = "the dashboard restarted and this page's token is stale: reload the page";
function say(text, err) { const m = document.getElementById("msg"); m.textContent = text; m.className = err ? "err" : ""; }
async function post(path, body) { const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-ranger-token": TOKEN }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error === REFUSED ? RELOAD : (j.error || r.statusText)); return j; }
const unavailable = (m, none) => empty(m.ok ? none : "Frontier unavailable: " + (m.error || "not read yet"));
const mapHead = (m, extra) => el("h3", { text: m.repo + " · map #" + m.root + (extra || "") + " · read " + ago(m.readAt) + (m.source === "ranger" ? " by ranger" : " by this dashboard") });
function renderMeta(s) {
 const g = s.gates;
 document.getElementById("meta").textContent = "maps read by ranger's tick, shown from its cache" + (s.refreshing ? " · dashboard reading…" : "") + (s.refreshError ? " · dashboard read: " + s.refreshError : "") + " · spawns today " + g.spawnsToday + "/" + g.spawnCap + (g.paused ? " · DEAD-MAN PAUSED" : "");
}
function jobTag(j) {
 if (j.stale) return el("span", { class: "tag stale", text: "stale: process gone" });
 const parts = [j.resourceLane || j.lane, j.status, j.phase, j.prNumber ? "PR #" + j.prNumber : "", j.reviewRound ? "round " + j.reviewRound : ""];
 return el("span", { class: "tag", text: parts.filter(Boolean).join(" · ") });
}
function renderCurrent(s) {
 const box = document.getElementById("current"); box.replaceChildren();
 if (s.current.length === 0) { box.append(empty("No worker is running.")); return; }
 box.append(el("ul", {}, ...s.current.map((j) => el("li", {}, el("span", { class: "id", text: "#" + j.nodeId }), el("span", { class: "t", text: (j.title || "(title not in the frontier read)") + " — " + j.repo }), jobTag(j)))));
}
function renderNext(s) {
 const box = document.getElementById("next"); box.replaceChildren();
 for (const lane of ["visual", "headless"]) {
  const holder = s.gates.laneHolders[lane];
  box.append(el("h3", { text: lane + " lane · " + (holder ? "held by #" + holder.nodeId + " (" + holder.repo + "#" + holder.root + ")" : "free") }));
  for (const m of s.maps.filter((m) => m.lane === lane)) {
   box.append(mapHead(m));
   const n = m.next;
   if (!n.nodeId) { box.append(empty(n.reason)); continue; }
   box.append(el("p", {}, el("span", { class: "id", text: "#" + n.nodeId + " " }), link(n.url, n.title), " ", buildButton(s, m, { id: n.nodeId, title: n.title, lane: n.lane }), el("span", { class: "reason", text: (n.lane ? n.lane + " lane · " : "") + n.reason })));
  }
 }
}
// build-now's exit codes: 0 started, 3 claimed with no run-node (BUILD_NOW_NOT_STARTED), null still running.
function buildOutcome(id, code) {
 if (code === null) return "build-now #" + id + " is still running — the page shows how it ends.";
 if (code === 0) return "build-now #" + id + " exited 0 — started.";
 if (code === 3) return "build-now #" + id + " exited 3 — claimed, but no worker started.";
 return "build-now #" + id + " exited " + code + " — refused or failed.";
}
function buildButton(s, m, n) {
 const b = el("button", { text: "Build now", title: "ranger build-now " + n.id + " --map " + m.key + " --force" });
 b.onclick = async () => {
  const holder = n.lane === "implement" ? s.gates.laneHolders[m.lane] : null;
  const beside = holder ? "\\n\\nBuilds beside #" + holder.nodeId + " (" + holder.repo + "#" + holder.root + ", " + holder.status + "), which holds the " + m.lane + " lane." : "";
  if (!confirm("Build #" + n.id + " — " + n.title + " now?\\n\\nClaims it under the machine account and starts its worker (ranger build-now --force)." + beside)) return;
  b.disabled = true;
  say("Building #" + n.id + "…");
  document.getElementById("out").textContent = "";
  try {
   const r = await post("/api/build-now", { key: m.key, id: n.id });
   say(buildOutcome(n.id, r.exitCode), r.exitCode !== 0);
   document.getElementById("out").textContent = r.tail;
  } catch (e) { say("Could not build #" + n.id + ": " + e.message, true); }
  finally { b.disabled = false; load(); }
 };
 return b;
}
function renderAuto(s) {
 const box = document.getElementById("auto"); box.replaceChildren();
 for (const m of s.maps) {
  if (m.servedOnly) continue;
  box.append(mapHead(m, " (walk: " + m.walk + ")"));
  if (m.autonomous.length === 0) { box.append(unavailable(m, "None.")); continue; }
  box.append(el("ul", {}, ...m.autonomous.map((n) => el("li", {}, el("span", { class: "id", text: "#" + n.id }), el("span", { class: "t" }, link(n.url, n.title)), el("span", { class: "tag", text: n.lane + " · " + n.kind }), buildButton(s, m, n)))));
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
const short = (sha) => (sha || "").slice(0, 8);
function prLifecycle(v) {
 if (v.merged) return "merged";
 if (v.state === "closed") return "closed";
 return v.draft ? "draft" : "ready";
}
function prFacts(pr) {
 const v = pr.view;
 const parts = ["PR #" + pr.number];
 if (v) parts.push(prLifecycle(v), "head " + short(v.headSha), ...(v.ci === "not-read" ? [] : ["CI " + v.ci]));
 if (pr.error) parts.push(v ? "stale, read " + ago(v.readAt) + "; the last refresh failed: " + pr.error : "the read failed: " + pr.error);
 else if (!v) parts.push("not read yet");
 return parts.join(" · ");
}
function needsFacts(n) {
 const facts = [n.repo + " · map #" + n.root, n.status, "ended " + ago(n.endedAt)];
 if (n.pr) facts.push(prFacts(n.pr));
 if (n.sage) facts.push("sage round " + n.sage.round + (n.sageOnHead === false ? " (an earlier head, " + short(n.sage.sha) + "; the current head is unreviewed)" : "") + ": " + n.sage.blockers + " blocker(s), " + n.sage.majors + " major(s)");
 if (n.probe) facts.push("probes " + (n.probe.passed ? "passed" : "FAILED") + " at " + short(n.probe.sha));
 return facts.join(" · ");
}
function actionButton(text, title, enabled, run) {
 const b = el("button", { text, title, disabled: !enabled });
 b.onclick = async () => { b.disabled = true; try { await run(); } finally { setTimeout(() => (b.disabled = !enabled), 3000); } };
 return b;
}
// The last result per card survives the re-render that follows every action.
const results = new Map();
const forced = new Set();
async function act(kind, n, extra) {
 const id = n.key + "/" + n.nodeId;
 try {
  const r = await post("/api/" + kind, Object.assign({ key: n.key, id: n.nodeId }, extra));
  results.set(id, { err: !r.ok, text: kind + " #" + n.nodeId + ": exit " + (r.code === null ? "none" : r.code) + (r.stderr ? "\\n" + r.stderr : "") });
  say(kind + " #" + n.nodeId + (r.ok ? " ran." : " failed: see its card."), !r.ok);
 } catch (e) { results.set(id, { err: true, text: kind + " #" + n.nodeId + " refused: " + e.message }); say(e.message, true); }
 load(); setTimeout(load, 3000);
}
function needsCard(n) {
 const id = n.key + "/" + n.nodeId;
 const force = el("input", { type: "checkbox", checked: forced.has(id) });
 force.onchange = () => { if (force.checked) forced.add(id); else forced.delete(id); };
 const acts = el("div", { class: "acts" });
 if (n.actions.resume) {
  acts.append(actionButton("Resume", "ranger resume-node " + n.nodeId + " --map " + n.key, true, () => act("resume", n, { force: force.checked })));
  acts.append(el("label", {}, force, document.createTextNode(" run beside the lane holder")));
 }
 const merge = n.actions.merge;
 acts.append(actionButton("Merge", merge.offered ? "gh pr merge --squash, pinned to " + short(merge.headSha) + ", under gh's configured login (machine-account tokens stripped; the account is not checked)" : merge.why, merge.offered, async () => {
  if (!confirm("Squash-merge PR #" + n.pr.number + " on " + n.repo + " at head " + merge.headSha + "?\\n\\nIt runs under gh's configured login: the machine account's GH_TOKEN, GITHUB_TOKEN and GH_CONFIG_DIR are stripped, but the account itself is not checked. " + (n.status === "failed" ? "The merge desk watches only parked and awaiting-merge rows, so Resume it afterwards to run the close." : "On its next tick the merge desk starts the close; check that the node closed (a failed spawn or a refused close leaves it open)."))) return;
  await act("merge", n, { sha: merge.headSha });
 }));
 const session = n.actions.session;
 acts.append(actionButton("Open session", session.offered ? "Open iTerm2 in " + session.cwd + " and start claude on #" + n.nodeId : session.why, session.offered, () => act("session", n, {})));
 if (n.pr) acts.append(link(n.pr.url, "Open PR"));
 const last = results.get(id);
 return el("div", { class: "card" },
  el("div", {}, el("span", { class: "id", text: "#" + n.nodeId + " " }), link(n.url, n.title || "(title not read yet)"), document.createTextNode(" "), el("span", { class: "tag stale", text: n.reason.class })),
  el("div", { class: "facts", text: needsFacts(n) }),
  el("div", { class: "reason", text: n.reason.detail }),
  acts,
  last ? el("pre", { class: last.err ? "err" : "", text: last.text }) : null);
}
function renderNeeds(s) {
 const box = document.getElementById("needsyou");
 box.replaceChildren();
 const unchecked = s.needsYouUnchecked || [];
 if (unchecked.length > 0) {
  const errs = unchecked.filter((u) => u.error).map((u) => u.key + ": " + u.error);
  box.append(el("div", { class: "reason", text: unchecked.length + " awaiting-merge row(s) not yet checked for needs-eye (" + unchecked.map((u) => u.key).join(", ") + "): " + (errs.length > 0 ? "the label read failed — " + errs.join("; ") : "labels not read yet") }));
 }
 if (!s.needsYou || s.needsYou.length === 0) {
  if (unchecked.length === 0) box.append(empty("Nothing is parked, failed or waiting on a needs-eye merge."));
  return;
 }
 box.append(...s.needsYou.map(needsCard));
}
const KINDS = [["worker", "worker"], ["fix-pass", "fix pass"], ["review", "review"]];
const span = (text, cls) => el("span", { class: "line" + (cls ? " " + cls : ""), text });
const until = (min) => min === null ? "" : min === 0 ? " (reset reached)" : " (in " + (min >= 1440 ? (min / 1440).toFixed(1) + " d" : min >= 60 ? Math.floor(min / 60) + " h " + (min % 60) + " min" : min + " min") + ")";
const at = (iso) => new Date(iso).toLocaleString();
function quotaWindow(label, w) {
 if (!w) return label + ": not reported";
 return label + ": " + w.usedPct + "% used, threshold " + w.threshold.toFixed(1) + "% \u00B7 " + (w.resetsAt ? "resets " + at(w.resetsAt) + until(w.resetInMin) : "reset unknown");
}
function sessionCounts(label, c) {
 const kinds = KINDS.map(([k, name]) => {
  const n = c[k]; const bad = ["failed", "capped", "transient"].filter((o) => n[o] > 0).map((o) => n[o] + " " + o);
  return n.sessions + " " + name + (bad.length ? " (" + bad.join(", ") + ")" : "");
 });
 return label + ": " + kinds.join(" \u00B7 ");
}
function renderSubstrates(s) {
 const box = document.getElementById("substrates"); box.replaceChildren();
 if (!s.substrates || s.substrates.length === 0) { box.append(empty("No substrates.")); return; }
 box.append(el("ul", {}, ...s.substrates.map((sub) => {
  const lines = [];
  if (sub.quota === "none") lines.push(span("no quota (always eligible)"));
  else if (sub.quota === "unread") lines.push(span("no reading: treated as capped", "warn"));
  else {
   const grey = sub.fresh ? "" : "muted";
   lines.push(span(quotaWindow("5h", sub.fiveHour), grey), span(quotaWindow("7d", sub.sevenDay), grey));
   lines.push(span("read " + sub.ageMin + " min ago (max " + sub.maxAgeMin + " min)" + (sub.cappedUntil ? " \u00B7 capped until " + at(sub.cappedUntil) : sub.capped ? " \u00B7 capped until the next reading" : ""), grey));
  }
  lines.push(span("eligible now: " + sub.eligible.state + " \u00B7 " + sub.eligible.reason));
  if (!sub.sessions) lines.push(span("sessions: no session history to read", "muted"));
  else {
   const running = KINDS.filter(([k]) => sub.sessions.running[k] > 0).map(([k, name]) => sub.sessions.running[k] + " " + name);
   lines.push(span("running now: " + (running.length ? running.join(" \u00B7 ") : "none")));
   lines.push(span(sessionCounts("last 24 h", sub.sessions.day)), span(sessionCounts("last 7 d", sub.sessions.week)));
  }
  const last = sub.lastSession;
  if (sub.sessions) lines.push(span(last ? "last: #" + last.nodeId + " (" + last.repo + ") " + KINDS.find(([k]) => k === last.kind)[1] + ", started " + ago(last.startedAt) + (last.endedAt ? ", " + (last.outcome || "ended") : ", open") : "last: no session yet"));
  const tag = sub.eligible.state === "yes" ? "eligible" : sub.eligible.state === "stale" ? "stale" : "ineligible";
  return el("li", {}, el("span", { class: "t" }, el("strong", { text: sub.substrate.toUpperCase() }), ...lines), el("span", { class: sub.eligible.state === "no" ? "tag stale" : "tag", text: tag }));
 })));
}
function render(s) { renderMeta(s); renderCurrent(s); renderSubstrates(s); renderNext(s); renderAuto(s); renderNeeds(s); renderGrill(s); }
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
 *   (`/repos/{repo}/issues/{id}`), a separate bucket from GraphQL;
 * - the "Needs you" issues and PRs (node #54) are REST too, read on every
 *   refresh whatever the frontier's backoff, with the read-only gate run once
 *   per repo per batch (`tokenBatch`).
 */
export class ServeReader {
 extra = new Map<string, MapRead>();
 titles = new Map<string, string>();
 refreshing = false;
 lastError: string | null = null;
 private backoffUntil = 0;
 private strikes = 0;
 private wantedTitles = new Set<string>();
 /** "Needs you" details (node #54): issue labels by `repo#id`, PRs by `repo#pr`. */
 labels = new Map<string, string[]>();
 prs = new Map<string, PrView>();
 /**
  * Failed detail reads by key (`issue:repo#id`, `pr:repo#n`), kept apart from
  * the frontier's `lastError`; a key's entry goes when its read succeeds.
  */
 detailErrors = new Map<string, string>();
 private detailIssues = new Set<string>();
 private detailPrs = new Set<string>();
 /** Keys tried since they were last wanted fresh: a failed read waits for the timer. */
 private detailTried = new Set<string>();
 private detailing: Promise<void> | null = null;
 private readonly details: DetailReader;

 constructor(
  private readonly config: RangerConfig,
  private readonly maps: ServeMap[],
  private readonly journalPath: string,
  details?: DetailReader,
 ) {
  this.details = details ?? {
   issue: (repo, id, tokens) => readIssue(config, repo, id, tokens),
   pr: (repo, n, tokens) => readPrLive(config, repo, n, tokens),
  };
 }

 /**
  * The issues and PRs the "Needs you" rows show. Read by `refreshDetails`,
  * never from a state read: the dashboard spends REST on the refresh timer,
  * once for a row it has not tried yet, and after an action.
  */
 wantDetails(issues: string[], prs: string[]): void {
  this.detailIssues = new Set(issues);
  this.detailPrs = new Set(prs);
  // Drop what no row wants any more, so the caches hold today's candidates,
  // not every node the dashboard has ever shown.
  for (const key of this.labels.keys()) if (!this.detailIssues.has(key)) this.labels.delete(key);
  for (const key of this.prs.keys()) if (!this.detailPrs.has(key)) this.prs.delete(key);
  for (const set of [this.detailErrors, this.detailTried]) {
   for (const key of set.keys()) if (!this.wantedDetail(key)) set.delete(key);
  }
 }

 private wantedDetail(key: string): boolean {
  if (key.startsWith("issue:")) return this.detailIssues.has(key.slice("issue:".length));
  if (key.startsWith("pr:")) return this.detailPrs.has(key.slice("pr:".length));
  return false;
 }

 private unread(): { issues: string[]; prs: string[] } {
  return {
   issues: [...this.detailIssues].filter((k) => !this.labels.has(k) && !this.detailTried.has(`issue:${k}`)),
   prs: [...this.detailPrs].filter((k) => !this.prs.has(k) && !this.detailTried.has(`pr:${k}`)),
  };
 }

 /** A wanted issue or PR that has not been read, nor tried since it was wanted. */
 hasUnreadDetails(): boolean {
  const { issues, prs } = this.unread();
  return issues.length + prs.length > 0;
 }

 /** Forget an entry's details, so the next read takes them fresh (after an action). */
 forget(issue: string, pr: string | null): void {
  this.labels.delete(issue);
  this.detailTried.delete(`issue:${issue}`);
  if (pr !== null) {
   this.prs.delete(pr);
   this.detailTried.delete(`pr:${pr}`);
  }
 }

 /**
  * Read the details: only the untried ones (`all: false`, on a state read or
  * after an action), or every wanted one (the refresh timer). One read at a
  * time; a failed key is not retried until the timer comes round.
  */
 refreshDetails(all = false): Promise<void> {
  if (this.detailing !== null) return this.detailing;
  this.detailing = this.readDetails(all).finally(() => {
   this.detailing = null;
  });
  return this.detailing;
 }

 private async readDetails(all: boolean): Promise<void> {
  const keys = all ? { issues: [...this.detailIssues], prs: [...this.detailPrs] } : this.unread();
  // One gate per repo for the whole batch, not two REST calls before every read.
  const tokens = tokenBatch(this.config);
  const attempt = async (key: string, read: () => Promise<void>, unknown?: () => void): Promise<void> => {
   this.detailTried.add(key);
   try {
    await read();
    this.detailErrors.delete(key);
   } catch (error) {
    this.detailErrors.set(key, error instanceof Error ? error.message : String(error));
    unknown?.();
   }
  };
  // Issues and PRs are independent reads: one queue, a few at a time, so a
  // slow issue does not hold every PR (nor the refresh an action waits on).
  const jobs: (() => Promise<void>)[] = [
   ...keys.issues.map((key) => () =>
    attempt(`issue:${key}`, async () => {
     const [repo, id] = key.split("#");
     const issue = await this.details.issue(repo, id, tokens);
     if (issue === null) throw new Error("could not read the issue");
     this.labels.set(key, issue.labels);
     this.titles.set(key, issue.title);
    },
    // A failed refresh leaves the labels unknown, not as last read: a label
    // added since must not hide behind "nothing waits".
    () => this.labels.delete(key)),
   ),
   ...keys.prs.map((key) => () =>
    attempt(`pr:${key}`, async () => {
     const [repo, n] = key.split("#");
     const pr = await this.details.pr(repo, Number(n), tokens);
     if (pr === null) throw new Error("could not read the PR");
     this.prs.set(key, pr);
    }),
   ),
  ];
  let next = 0;
  const worker = async (): Promise<void> => {
   while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, jobs.length) }, worker));
 }

 /** Ask for titles of nodes no frontier names; fetched on the next refresh. */
 want(keys: string[]): void {
  for (const key of keys) if (!this.titles.has(key)) this.wantedTitles.add(key);
 }

 refresh(): void {
  // "Needs you" reads REST, apart from the frontier: a GraphQL backoff, a
  // deferral or a failed frontier read must not leave labels unknown and PR
  // reads stale until it clears.
  void this.refreshDetails(true);
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
  const tokens = tokenBatch(this.config);
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
   const token = await tokens(map.repo);
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
   const issue = await readIssue(this.config, repo, id, tokens);
   if (issue !== null) this.titles.set(key, issue.title);
   this.wantedTitles.delete(key);
  }
 }
}

/** How many "Needs you" REST reads run at once. */
export const DETAIL_CONCURRENCY = 4;

/** The REST reads behind "Needs you"; injected so no test runs `gh`. */
export interface DetailReader {
 issue: (repo: string, id: string, tokens: TokenBatch) => Promise<Pick<IssueRead, "title" | "labels"> | null>;
 pr: (repo: string, pr: number, tokens: TokenBatch) => Promise<PrView | null>;
}

interface IssueRead {
 title: string;
 state: string;
 assignees: string[];
 labels: string[];
 kind: string | null;
}

/** One `gh api` GET under the read-only gate; null on any failure. */
async function restRead(tokens: TokenBatch, repo: string, path: string, flags: string[] = []): Promise<unknown> {
 const token = await tokens(repo);
 const gated = gatedEnv(token.token);
 try {
  const result = await runCmd("gh", ["api", path, ...flags], { env: gated.env, timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  try {
   return JSON.parse(result.stdout) as unknown;
  } catch {
   return null;
  }
 } finally {
  gated.cleanup();
 }
}

/**
 * A PR and the CI state of its head, over REST under the read-only gate: run
 * once for both reads, or once for a whole refresh batch when `tokens` is given.
 */
export async function readPrLive(
 config: RangerConfig,
 repo: string,
 number: number,
 tokens: TokenBatch = tokenBatch(config),
): Promise<PrView | null> {
 if (!REPO_PATTERN.test(repo) || !Number.isInteger(number) || number <= 0) return null;
 const raw = (await restRead(tokens, repo, `repos/${repo}/pulls/${number}`)) as Record<string, unknown> | null;
 if (raw === null) return null;
 const head = (raw.head ?? {}) as { sha?: unknown };
 const headSha = typeof head.sha === "string" ? head.sha : "";
 const terminal = raw.state === "closed" || raw.merged === true;
 // Every page: a failure on page two must not read as green. A closed or
 // merged PR offers no action its checks could gate, so they are not read.
 const checks = !terminal && /^[0-9a-f]{40}$/.test(headSha)
  ? checkRunsFromPages(
     await restRead(tokens, repo, `repos/${repo}/commits/${headSha}/check-runs?filter=latest&per_page=100`, [
      "--paginate",
      "--slurp",
     ]),
    )
  : null;
 return {
  number,
  url: typeof raw.html_url === "string" ? raw.html_url : `https://github.com/${repo}/pull/${number}`,
  state: raw.state === "closed" ? "closed" : "open",
  merged: raw.merged === true,
  draft: raw.draft === true,
  headSha,
  mergeable: typeof raw.mergeable === "boolean" ? raw.mergeable : null,
  ci: terminal ? "not-read" : checks === null ? "unreadable" : ciState(checks),
  readAt: new Date().toISOString(),
 };
}

/** One issue over REST under the read-only gate: no GraphQL. Null if unreadable. */
async function readIssue(
 config: RangerConfig,
 repo: string,
 id: string,
 tokens: TokenBatch = tokenBatch(config),
): Promise<IssueRead | null> {
 if (!REPO_PATTERN.test(repo) || !ID_PATTERN.test(id)) return null;
 const raw = (await restRead(tokens, repo, `repos/${repo}/issues/${id}`)) as {
  title?: string;
  state?: string;
  assignees?: { login?: string }[];
  labels?: ({ name?: string } | string)[];
  body?: string | null;
 } | null;
 if (raw === null || typeof raw !== "object") return null;
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
  labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
  kind,
 };
}

export function stateFromJournal(
 config: RangerConfig,
 maps: ServeMap[],
 reader: ServeReader,
 now = new Date(),
): DashboardState {
 const journal = Journal.openReadOnly(expandHome(config.state.journalPath), config.maps);
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
        frontier: classifyFrontier(cached.frontier.frontier, map, registry, config.bot.identity),
        readAt: cached.fetchedAt,
        source: "ranger",
       },
   );
  }
  const vetoed = journal?.listVetoes() ?? new Set<string>();
  const workers = journal?.listWorkers() ?? [];
  const needsYou = needsYouEntries({
   maps,
   workers,
   events: (repo, nodeId) => journal?.listNodeEvents(repo, nodeId) ?? [],
   labels: (repo, nodeId) => reader.labels.get(`${repo}#${nodeId}`) ?? null,
   prs: (repo, pr) => reader.prs.get(`${repo}#${pr}`) ?? null,
   prError: (repo, pr) => reader.detailErrors.get(`pr:${repo}#${pr}`) ?? null,
   titleOf: (repo, nodeId) => {
    for (const map of maps) {
     if (map.repo !== repo) continue;
     const hit = reports.get(map.key)?.frontier.find((n) => n.id === nodeId)?.title;
     if (hit !== undefined) return hit;
    }
    return reader.titles.get(`${repo}#${nodeId}`) ?? null;
   },
   reviewRounds: config.workers.reviewRounds,
   exists: existsSync,
  });
  const needsYouUnchecked = uncheckedNeedsEye({
   maps,
   workers,
   labels: (repo, nodeId) => reader.labels.get(`${repo}#${nodeId}`) ?? null,
  }).map((key) => ({ key, error: reader.detailErrors.get(`issue:${key}`) ?? null }));
  // Details for every row that may need the principal: an awaiting-merge row
  // shows only once its labels say needs-eye.
  const candidates = workers.filter(
   (w) =>
    (w.status === "parked" || w.status === "failed" || w.status === "awaiting-merge") &&
    maps.some((m) => m.repo === w.repo && m.root === w.root),
  );
  reader.wantDetails(
   candidates.map((w) => `${w.repo}#${w.nodeId}`),
   candidates.filter((w) => w.prNumber !== null).map((w) => `${w.repo}#${w.prNumber}`),
  );
  const state = assembleState({
   maps,
   reports,
   titles: reader.titles,
   workers,
   needsYou,
   needsYouUnchecked,
   lastImplementMaps: lastImplementMaps(journal),
   laneHolders: { visual: journal?.laneHolder("visual") ?? null, headless: journal?.laneHolder("headless") ?? null },
   paused: journal?.isPaused() ?? false,
   spawnsToday: journal?.spawnsToday(now) ?? 0,
   spawnCap: config.workers.spawnCapPerDay,
   vetoed: (id) => vetoed.has(id),
   pidAlive: defaultPidAlive,
   refreshing: reader.refreshing,
   refreshError: reader.lastError,
   now,
   substrates: substrateUsageViews({
    readings: journal?.listSubstrateReadings() ?? [],
    sessions: journal?.listSubstrateSessions(new Date(now.getTime() - 7 * 24 * 60 * 60_000)) ?? null,
    lastSession: (substrate) => journal?.lastSubstrateSession(substrate) ?? null,
    live: liveSession(workers, defaultPidAlive),
    config: config.substrates,
    now,
   }),
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

/**
 * Run an action's child and wait for its exit, keeping the tail of its
 * stderr for the page. `resume-node` returns once it has detached run-node,
 * so waiting on it is short; the child is detached all the same, so a serve
 * restart never takes a resume down with it.
 */
export const spawnAction: ActionRunner = (argv, env, opts) =>
 new Promise((done) => {
  const [command, ...args] = argv;
  let stderr = "";
  let settled = false;
  let markExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
   markExited = resolve;
  });
  const settle = (code: number | null, extra = "") => {
   if (settled) return;
   settled = true;
   clearTimeout(timer);
   done({ code, stderr: (stderr + extra).slice(-4000), exited });
  };
  const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"], detached: opts.detached });
  // The page is answered at the timeout; the child is not killed (a resume
  // cut mid-journal-write is worse than a slow one), and `exited` keeps the
  // node held until it really ends.
  const timer = setTimeout(() => settle(null, `\n(no exit after ${ACTION_TIMEOUT_MS / 1000} s; still running)`), ACTION_TIMEOUT_MS);
  child.stderr?.on("data", (chunk: Buffer) => {
   stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on("error", (error) => {
   settle(null, `could not start ${command}: ${error.message}`);
   markExited();
  });
  child.on("close", (code) => {
   settle(code);
   markExited();
  });
  if (opts.detached) child.unref();
 });

const ACTION_TIMEOUT_MS = 120_000;

export function startServe(opts: {
 config: RangerConfig;
 /** The ranger.yaml this was loaded from; `resume-node` and `build-now` are run with the same one. */
 configPath?: string;
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
  getState: () => {
   const state = stateFromJournal(opts.config, maps, reader);
   // A row that newly needs the principal gets its PR and labels read now,
   // not on the next timer.
   if (reader.hasUnreadDetails()) void reader.refreshDetails();
   return state;
  },
  refresh: () => reader.refresh(),
  launch: spawnLaunch,
  verifyGrilling: (map, nodeId) => verifyGrillingLive(opts.config, map, nodeId),
  buildNow: {
   command: (map, nodeId) =>
    opts.configPath === undefined
     ? null
     : buildNowArgv({ bin: expandHome(RANGER_BIN), key: map.key, nodeId, configPath: opts.configPath }),
   runVerb: (argv, env) => runVerb(argv, env),
  },
  actions: {
   run: spawnAction,
   rangerBin: expandHome("~/bin/ranger"),
   configPath: opts.configPath,
   readPr: (repo, pr) => readPrLive(opts.config, repo, pr),
   exists: existsSync,
   after: (entry) => {
    reader.forget(`${entry.repo}#${entry.nodeId}`, entry.pr === null ? null : `${entry.repo}#${entry.pr.number}`);
    void reader.refreshDetails();
   },
  },
 });
 const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: (req, srv) => {
   // A build-now answer waits for the verb (BUILD_NOW_WAIT_MS), longer than
   // Bun's default 10 s idle timeout would keep the connection open.
   if (new URL(req.url).pathname === "/api/build-now") srv.timeout(req, 0);
   return handler(req);
  },
 });
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

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import type { RangerMapConfig } from "./config.ts";
import { DISCORD_MAX_FILES, DISCORD_MAX_FILE_BYTES, DISCORD_MAX_FILES_BYTES, type DiscordFile, sleep } from "./discord.ts";
import { killProcessGroup, runCmd, type RunResult } from "./exec.ts";
import { safeGit } from "./git-ops.ts";
import { NEEDS_EYE_LABEL } from "./labels.ts";
import { readFile } from "node:fs/promises";

const VIEW_NAME = /^[\w-]+$/;
const SHA = /^[a-f0-9]{40,64}$/;
const TIMEOUT_MS = 30 * 60_000;

/** Values are ranger-owned, shell-quoted arguments. Templates must leave placeholders unquoted. */
export function fillViewsTemplate(template: string, values: Record<string, string | number>): string {
 return template.replace(/\{([^{}]*)\}/g, (_, key: string) => {
  if (!Object.hasOwn(values, key)) throw new Error(`unknown views placeholder {${key}}`);
  return `'${String(values[key]).replaceAll("'", "'\\''")}'`;
 });
}

export interface ViewDiff { view: string; change: number; noise: number }
const byMostChanged = (a: ViewDiff, b: ViewDiff): number => b.change - a.change || a.view.localeCompare(b.view);
export type ViewsRecord =
 | { sha: string; status: "ok"; rows: ViewDiff[] }
 | { sha: string; status: "failed"; reason: string };

export function viewsDirectory(journalPath: string, repo: string, nodeId: string, sha: string): string {
 if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some(p => p === "." || p === "..") || !/^\d+$/.test(nodeId) || !SHA.test(sha)) {
  throw new Error("invalid views artifact key");
 }
 return resolve(dirname(journalPath), "views", repo, nodeId, sha);
}

/** Parses the adopter's text diff, including Seelite's `moved >24/255` rows. */
export function parseViewsDiff(output: string): Map<string, number> {
 const rows = new Map<string, number>();
 for (const line of output.split("\n")) {
  const match = line.match(/^([\w-]+)\s+moved >\d+\/255:\s*([\d.]+)%\s+any change:/);
  if (match === null) {
   if (line.includes("sizes differ") || line.includes("moved >")) throw new Error(`invalid view diff: ${line}`);
   continue;
  }
  const change = Number(match[2]);
  if (!Number.isFinite(change) || change < 0 || change > 100 || rows.has(match[1])) {
   throw new Error(`invalid view diff: ${line}`);
  }
  rows.set(match[1], change);
 }
 if (rows.size === 0) throw new Error("diff reported no views");
 return rows;
}

export function compareViews(change: Map<string, number>, noise: Map<string, number>): ViewDiff[] {
 if (change.size !== noise.size || [...change.keys()].some(view => !noise.has(view))) {
  throw new Error("before/after and control view sets differ");
 }
 return [...change].map(([view, value]) => ({ view, change: value, noise: noise.get(view)! }));
}

export interface ViewsSelection {
 attached: ViewDiff[];
 omitted: { view: string; reason: string }[];
}

/** Keep each before/after pair intact. A numeric difference is evidence, never a merge gate. */
export function chooseViews(
 rows: readonly ViewDiff[],
 sizes: (view: string) => readonly [number, number],
 limits = { files: DISCORD_MAX_FILES, fileBytes: DISCORD_MAX_FILE_BYTES, totalBytes: DISCORD_MAX_FILES_BYTES },
): ViewsSelection {
 const attached: ViewDiff[] = [];
 const omitted: ViewsSelection["omitted"] = [];
 let bytes = 0;
 for (const row of [...rows].sort(byMostChanged)) {
  if (row.change <= row.noise) {
   omitted.push({ view: row.view, reason: "change does not exceed single control sample" });
   continue;
  }
  let pair: readonly [number, number];
  try { pair = sizes(row.view); } catch {
   omitted.push({ view: row.view, reason: "PNG unavailable" });
   continue;
  }
  if (pair.some(size => !Number.isFinite(size) || size <= 0 || size > limits.fileBytes)) {
   omitted.push({ view: row.view, reason: "file size limit" });
  } else if ((attached.length + 1) * 2 > limits.files || bytes + pair[0] + pair[1] > limits.totalBytes) {
   omitted.push({ view: row.view, reason: "message attachment limit" });
  } else {
   attached.push(row);
   bytes += pair[0] + pair[1];
  }
 }
 return { attached, omitted };
}

export function viewsTable(rows: readonly ViewDiff[]): string {
 return [
  "| View | Before → after | After → after2 (single control sample) |",
  "| --- | ---: | ---: |",
  ...rows.map(r => `| ${r.view} | ${r.change.toFixed(2)}% | ${r.noise.toFixed(2)}% |`),
 ].join("\n");
}

export function viewsComment(record: ViewsRecord, out: string): string {
 return [
  `<!-- ranger:views sha=${record.sha} -->`,
  "## Visual evidence (principal's eye is the gate)",
  record.status === "ok" ? viewsTable(record.rows) : `Sheet could not be made: ${record.reason}`,
  `Full local sheet: \`${join(out, "index.html")}\``,
 ].join("\n\n");
}

export function saveViewsRecord(out: string, record: ViewsRecord): void {
 mkdirSync(out, { recursive: true });
 const tmp = join(out, "ranger-views.json.tmp");
 writeFileSync(tmp, JSON.stringify(record));
 renameSync(tmp, join(out, "ranger-views.json"));
}

export function loadViewsRecord(out: string, sha: string): ViewsRecord | undefined {
 try {
  const record = JSON.parse(readFileSync(join(out, "ranger-views.json"), "utf8"));
  if (record.sha !== sha) return undefined;
  if (record.status === "failed" && typeof record.reason === "string") return record;
  if (record.status !== "ok" || !Array.isArray(record.rows) || record.rows.length === 0) return undefined;
  if (new Set(record.rows.map((r: ViewDiff) => r.view)).size !== record.rows.length) return undefined;
  if (record.rows.some((r: ViewDiff) => typeof r.view !== "string" || !VIEW_NAME.test(r.view) ||
   !Number.isFinite(r.change) || !Number.isFinite(r.noise) || r.change < 0 || r.change > 100 || r.noise < 0 || r.noise > 100)) return undefined;
  return record;
 } catch { return undefined; }
}

function pngSize(out: string, label: string, view: string): number {
 if (!VIEW_NAME.test(view)) throw new Error("invalid view name");
 const stat = lstatSync(join(out, label, `${view}.png`));
 if (!stat.isFile()) throw new Error("capture PNG is not a regular file");
 return stat.size;
}

function verifyCaptureSet(out: string, rows: readonly ViewDiff[]): void {
 const expected = rows.map(r => `${r.view}.png`).sort().join("\n");
 for (const label of ["before", "after", "after2"]) {
  const names = readdirSync(join(out, label)).filter(n => n.endsWith(".png")).sort();
  if (names.join("\n") !== expected) throw new Error(`${label} PNGs differ from the diff view set`);
  for (const row of rows) pngSize(out, label, row.view);
 }
 if (!existsSync(join(out, "index.html"))) throw new Error("capture did not write index.html");
}

export async function viewsCard(out: string, sha: string): Promise<{ summary: string; files: DiscordFile[] }> {
 const record = loadViewsRecord(out, sha);
 if (record === undefined) return { summary: "Sheet could not be made: no capture record for this head.", files: [] };
 if (record.status === "failed") return { summary: `Sheet could not be made: ${record.reason}`, files: [] };
 const sizes = (view: string): [number, number] => [pngSize(out, "before", view), pngSize(out, "after", view)];
 let selection = chooseViews(record.rows, sizes);
 const summaryFor = (selected: ViewsSelection) => [
  "Visual evidence: before → after; after → after2 is one same-build noise sample, not an established noise floor. Your eye is the gate.",
  ...[...record.rows].sort(byMostChanged).map(r => `${r.view}: ${r.change.toFixed(2)}% (noise ${r.noise.toFixed(2)}%)`),
  `Attached pairs: ${selected.attached.map(r => r.view).join(", ") || "none"}.`,
  `Left out: ${selected.omitted.map(r => `${r.view} (${r.reason})`).join(", ") || "none"}.`,
  `Full sheet: ${join(out, "index.html")}`,
 ].join("\n");
 let summary = summaryFor(selection);
 let summaryFile: DiscordFile | undefined;
 if (summary.length > 6000) {
  // Preserve every omitted name when the full text cannot fit in Discord's embeds.
  const textBytes = Buffer.byteLength(summary) + 1024;
  selection = chooseViews(record.rows, sizes, { files: DISCORD_MAX_FILES - 1, fileBytes: DISCORD_MAX_FILE_BYTES, totalBytes: DISCORD_MAX_FILES_BYTES - textBytes });
  const full = summaryFor(selection);
  summaryFile = { name: "views-summary.txt", data: new Blob([full], { type: "text/plain" }) };
  summary = `Visual evidence: ${selection.attached.length} before/after pairs above one same-build noise sample. Full diff and every left-out view are named in views-summary.txt and the PR comment. Your eye is the gate.\nFull sheet: ${join(out, "index.html")}`;
 }
 const files: DiscordFile[] = await Promise.all(selection.attached.flatMap(row => ["before", "after"].map(async label => ({
  name: `${row.view}-${label}.png`,
  description: `${row.view}: ${label}`,
  data: new Blob([await readFile(join(out, label, `${row.view}.png`))], { type: "image/png" }),
 }))));
 if (summaryFile !== undefined) files.push(summaryFile);
 return { summary, files };
}

export function viewsCardMessage(content: string, evidence?: Awaited<ReturnType<typeof viewsCard>>): {
 content: string; files?: DiscordFile[]; embeds?: { description: string }[];
} {
 if (evidence === undefined) return { content };
 if (content.length + evidence.summary.length + 1 <= 2000) {
  return { content: `${content}\n${evidence.summary}`, files: evidence.files };
 }
 return {
  content, files: evidence.files,
  embeds: [
   { description: evidence.summary.slice(0, 4096) },
   ...(evidence.summary.length > 4096 ? [{ description: evidence.summary.slice(4096) }] : []),
  ],
 };
}

export function redactViewsReason(reason: string, env: NodeJS.ProcessEnv): string {
 for (const [key, value] of Object.entries(env)) {
  if (value && /token|secret|password|passwd|credential|api_?key|private_?key/i.test(key)) {
   reason = reason.replaceAll(value, "[redacted]");
  }
 }
 return reason
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,})\b/g, "[redacted]")
  .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{24,}\.[\w-]{6}\.[\w-]{27,})\b/g, "[redacted]")
  .slice(-1000);
}

export interface ViewsServer { stop(): Promise<void> }
export interface ViewsDependencies {
 run?: typeof runCmd;
 git?: typeof safeGit;
 freePort?: () => Promise<number>;
 startServer?: (command: string, cwd: string, env: NodeJS.ProcessEnv, origin: string) => Promise<ViewsServer>;
}

export async function freeViewsPort(): Promise<number> {
 return new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "localhost", () => {
   const address = server.address();
   if (address === null || typeof address === "string") return server.close(() => reject(new Error("no capture port")));
   server.close(error => error ? reject(error) : resolvePort(address.port));
  });
 });
}

/** A bounded readiness wait; the shell, dev server and descendants share one killable process group. */
export async function startViewsServer(command: string, cwd: string, env: NodeJS.ProcessEnv, origin: string): Promise<ViewsServer> {
 const child = spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
 let diagnostic = "";
 let error: Error | undefined;
 let closed = false;
 const done = new Promise<void>(resolveDone => {
  child.once("close", () => { closed = true; resolveDone(); });
 });
 child.once("error", e => { error = e; });
 const read = (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4000); };
 child.stdout?.on("data", read);
 child.stderr?.on("data", read);
 const server: ViewsServer = { stop: async () => {
  if (child.pid !== undefined) killProcessGroup(child.pid);
  await done;
 } };
 try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
   if (error || closed) throw new Error(`views server failed: ${redactViewsReason(error?.message ?? diagnostic, env)}`);
   try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    if (response.ok) return server;
   } catch { /* waiting for the server to bind */ }
   await sleep(100);
  }
  throw new Error(`views server readiness timed out: ${redactViewsReason(diagnostic, env)}`);
 } catch (e) {
  await server.stop();
  throw e;
 }
}

export interface CaptureViewsContext {
 map: RangerMapConfig;
 nodeId: string;
 sha: string;
 labels: readonly string[];
 probePassed: boolean;
 journalPath: string;
 worktree: string;
 env: NodeJS.ProcessEnv;
 dependencies?: ViewsDependencies;
}

/** Called inside run-node's existing awake hold, after the final-head probe tier. */
export async function captureViews(ctx: CaptureViewsContext): Promise<ViewsRecord | undefined> {
 if (!ctx.labels.includes(NEEDS_EYE_LABEL) || !ctx.map.commands.views) return undefined;
 const { map, sha, dependencies: deps = {} } = ctx;
 const out = viewsDirectory(ctx.journalPath, map.repo, ctx.nodeId, sha);
 const cached = loadViewsRecord(out, sha);
 if (cached?.status === "ok") return cached;
 const run = deps.run ?? runCmd;
 const git = deps.git ?? safeGit;
 const shell = async (command: string, cwd: string, step: string, origin?: string): Promise<string> => {
  const result: RunResult = await run("/bin/sh", ["-c", command], {
   cwd, env: { ...ctx.env, ...(origin ? { PROBE_ORIGIN: origin } : {}) }, timeoutMs: TIMEOUT_MS, processGroup: true,
  });
  if (result.code !== 0) throw new Error(`${step} ${result.code === -1 ? "timed out or was killed" : `failed (exit ${result.code})`}: ${result.stderr + result.stdout}`);
  return result.stdout;
 };
 const checkedGit = async (args: string[]): Promise<string> => {
  const result = await git(args, { cwd: ctx.worktree });
  if (result.code !== 0) throw new Error(`views git ${args[0]} failed: ${redactViewsReason(result.stderr, ctx.env)}`);
  return result.stdout.trim();
 };
 let scratch: string | undefined;
 let before: string | undefined;
 let record: ViewsRecord;
 try {
  if (!ctx.probePassed) throw new Error("no passing probe tier on the final head");
  if (!map.commands.views || !map.commands.viewsServe || !map.commands.viewsDiff) throw new Error("views, viewsServe and viewsDiff are not all configured");
  const { views, viewsServe, viewsDiff } = map.commands;
  if (out.startsWith(resolve(ctx.worktree) + sep)) throw new Error("views output must be outside the worktree");
  if (await checkedGit(["rev-parse", "HEAD"]) !== sha) throw new Error("worktree differs from final PR head");
  const base = await checkedGit(["merge-base", sha, `origin/${map.base}`]);
  if (!SHA.test(base)) throw new Error("invalid merge base");
  mkdirSync(out, { recursive: true });
  // A retry must not inherit partial frames from a prior crashed capture.
  for (const label of ["before", "after", "after2", "index.html"]) rmSync(join(out, label), { recursive: true, force: true });
  scratch = mkdtempSync(join(dirname(out), "before-"));
  before = join(scratch, "worktree");
  await checkedGit(["worktree", "add", "--detach", before, base]);
  if (map.commands.install) await shell(map.commands.install, before, "before dependency install");
  const capture = async (cwd: string, labels: string[]) => {
   const port = await (deps.freePort ?? freeViewsPort)();
   const origin = `http://localhost:${port}`;
   const server = await (deps.startServer ?? startViewsServer)(fillViewsTemplate(viewsServe, { port }), cwd, ctx.env, origin);
   try {
    for (const label of labels) await shell(fillViewsTemplate(views, { label, out, origin }), cwd, `${label} capture`, origin);
   } finally { await server.stop(); }
  };
  await capture(before, ["before"]);
  await capture(ctx.worktree, ["after", "after2"]);
  if (await checkedGit(["rev-parse", "HEAD"]) !== sha) throw new Error("head moved during capture");
  const diff = async (a: string, b: string) => parseViewsDiff(await shell(fillViewsTemplate(viewsDiff, { out, a, b }), ctx.worktree, `${a} → ${b} diff`));
  const change = await diff("before", "after");
  const noise = await diff("after", "after2");
  const rows = compareViews(change, noise);
  verifyCaptureSet(out, rows);
  record = { sha, status: "ok", rows };
 } catch (error) {
  record = { sha, status: "failed", reason: redactViewsReason(error instanceof Error ? error.message : String(error), ctx.env) };
 } finally {
  if (before !== undefined) {
   try { await checkedGit(["worktree", "remove", "--force", before]); } catch { /* best-effort after an incomplete add */ }
  }
  if (scratch !== undefined) {
   try { rmSync(scratch, { recursive: true, force: true }); } catch { /* cleanup must not turn evidence into a gate */ }
   try { await checkedGit(["worktree", "prune"]); } catch { /* cleanup must not turn evidence into a gate */ }
  }
 }
 try { saveViewsRecord(out, record); } catch { /* evidence storage failure must not block ready */ }
 return record;
}

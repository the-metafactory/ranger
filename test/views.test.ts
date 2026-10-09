import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { captureViews, chooseViews, compareViews, fillViewsTemplate, freeViewsPort, loadViewsRecord, parseViewsDiff, redactViewsReason, saveViewsRecord, startViewsServer, viewsCard, viewsCardMessage, viewsComment, viewsDirectory, VIEWS_FAILURE_LOG, type CaptureViewsContext, type ViewsDependencies } from "../src/views.ts";
import { pidAlive, processGroupCommands, runCmd } from "../src/exec.ts";
import { baseConfigLines } from "./support.ts";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function rig() {
 const dir = mkdtempSync(join(tmpdir(), "ranger-views-"));
 dirs.push(dir);
 const path = join(dir, "config.yaml");
 writeFileSync(path, baseConfigLines(dir).join("\n"));
 const { config } = loadConfig(path);
 const map = config.maps[0];
 map.commands.views = "capture {label} {out} {origin}";
 map.commands.viewsServe = "serve {port}";
 map.commands.viewsDiff = "diff {out} {a} {b}";
 map.commands.install = "install";
 const out = viewsDirectory(join(dir, "journal.sqlite"), map.repo, "52", SHA);
 const calls: string[] = [];
 const servers: { cwd: string; origin: string; stopped: boolean }[] = [];
 const dependencies: ViewsDependencies = {
  git: async (args) => {
   calls.push(`git ${args.join(" ")}`);
   return { code: 0, stdout: args[0] === "merge-base" ? BASE : SHA, stderr: "" };
  },
  freePort: async () => 43210 + servers.length,
  startServer: async (command, cwd, env, origin) => {
   expect(command).toMatch(/^serve '4321\d'$/);
   expect(env).toEqual({ PATH: "/bin" });
   const server = { cwd, origin, stopped: false };
   servers.push(server);
   return { stop: async () => { server.stopped = true; calls.push("stop"); } };
  },
  run: async (bin, args, opts) => {
   expect(bin).toBe("/bin/sh");
   expect(opts?.processGroup).toBe(true);
   expect(opts?.timeoutMs).toBe(30 * 60_000);
   calls.push(args[1]);
   if (args[1].startsWith("capture")) {
    const label = args[1].match(/capture '(before|after|after2)'/)![1];
    expect(opts?.env?.PROBE_ORIGIN).toBe(servers.at(-1)?.origin);
    mkdirSync(join(out, label), { recursive: true });
    writeFileSync(join(out, label, "hull.png"), "PNG");
    writeFileSync(join(out, label, "sky.png"), "PNG");
    writeFileSync(join(out, "index.html"), "full sheet");
   }
   const change = args[1].endsWith("'after' 'after2'") ? "0.10" : "2.30";
   return { code: 0, stdout: args[1].startsWith("diff") ? `hull                 moved >24/255:   ${change}%   any change: 3.00%\nsky                  moved >24/255:   0.00%   any change: 0.00%\n` : "", stderr: "" };
  },
 };
 const ctx: CaptureViewsContext = {
  map, nodeId: "52", sha: SHA, labels: ["ranger:needs-eye"], probePassed: true,
  journalPath: join(dir, "journal.sqlite"), worktree: join(dir, "node-worktree"), env: { PATH: "/bin" }, dependencies,
 };
 return { ctx, out, calls, servers };
}

describe("views templates", () => {
 test("fills owned arguments and quotes paths with spaces and apostrophes", () => {
  expect(fillViewsTemplate("PROBE_ORIGIN={origin} capture {label} {out}", { origin: "http://127.0.0.1:4567", label: "before", out: "/tmp/principal's views" }))
   .toBe("PROBE_ORIGIN='http://127.0.0.1:4567' capture 'before' '/tmp/principal'\\''s views'");
  expect(fillViewsTemplate("serve {port}", { port: 43210 })).toBe("serve '43210'");
  expect(fillViewsTemplate("diff {out} {a} {b}", { out: "/tmp/out", a: "after", b: "after2" })).toBe("diff '/tmp/out' 'after' 'after2'");
 });
 test("refuses unknown placeholders, including inherited object properties", () => {
  for (const key of ["node", "title", "constructor", ""]) expect(() => fillViewsTemplate(`capture {${key}}`, { label: "after" })).toThrow("unknown views placeholder");
 });
 test("artifact keys refuse tracker text and traversal", () => {
  expect(() => viewsDirectory("/tmp/state.sqlite", "acme/widgets", "52; evil", SHA)).toThrow();
  expect(() => viewsDirectory("/tmp/state.sqlite", "acme/widgets", "52", "../../x")).toThrow();
  expect(() => viewsDirectory("/tmp/state.sqlite", "../widgets", "52", SHA)).toThrow();
 });
});

describe("diff selection", () => {
 test("strictly above each single control sample, most changed first, whole pairs under the cap", () => {
  const rows = [
   { view: "quiet", change: 1, noise: 1 },
   { view: "noisy", change: 2, noise: 3 },
   { view: "small", change: 2, noise: 0 },
   { view: "big", change: 10, noise: 1 },
   { view: "medium", change: 5, noise: 0 },
  ];
  const selected = chooseViews(rows, () => [1, 1], { files: 4, fileBytes: 10, totalBytes: 100 });
  expect(selected.attached.map(r => r.view)).toEqual(["big", "medium"]);
  expect(selected.omitted).toEqual([
   { view: "noisy", reason: "change does not exceed single control sample" },
   { view: "small", reason: "message attachment limit" },
   { view: "quiet", reason: "change does not exceed single control sample" },
  ]);
 });
 test("file and total byte budgets and missing PNGs omit pairs while smaller pairs still fit", () => {
  const rows = ["huge", "first", "second", "small", "missing"].map((view, i) => ({ view, change: 10 - i, noise: 0 }));
  const selected = chooseViews(rows, view => {
   if (view === "missing") throw new Error("not found");
   return view === "huge" ? [11, 1] : view === "small" ? [1, 1] : [4, 4];
  }, { files: 10, fileBytes: 10, totalBytes: 10 });
  expect(selected.attached.map(r => r.view)).toEqual(["first", "small"]);
  expect(selected.omitted.map(r => r.reason)).toEqual(["file size limit", "message attachment limit", "PNG unavailable"]);
 });
 test("real Seelite text parsed; malformed, duplicate, viewport or missing-control diffs fail", () => {
  const output = "before → after, 1 views, threshold 24/255\n\nhull                 moved >24/255:   1.23%   any change: 10.00%\n";
  expect([...parseViewsDiff(output)]).toEqual([["hull", 1.23]]);
  for (const bad of ["", "hull sizes differ — captured at two viewports", output + output, "hull moved >24/255: 999% any change: 1%"])
   expect(() => parseViewsDiff(bad)).toThrow();
  expect(() => compareViews(new Map([["hull", 2]]), new Map([["sky", 0]]))).toThrow("view sets differ");
 });
});

describe("capture orchestration", () => {
 test("diff processes sharing the output directory never overlap", async () => {
  const r = rig();
  const run = r.ctx.dependencies!.run!;
  let active = false;
  const completed: string[] = [];
  r.ctx.dependencies!.run = async (bin, args, opts) => {
   if (!args[1].startsWith("diff")) return run(bin, args, opts);
   if (active) throw new Error("overlapping diffs");
   active = true;
   try {
    await new Promise(resolve => setTimeout(resolve, 10));
    const result = await run(bin, args, opts);
    completed.push(args[1]);
    return result;
   } finally { active = false; }
  };
  expect(await captureViews(r.ctx)).toMatchObject({ status: "ok" });
  expect(completed).toHaveLength(2);
  expect(completed[0]).toEndWith("'before' 'after'");
  expect(completed[1]).toEndWith("'after' 'after2'");
 });
 test("failed worktree removal still prunes after deleting the scratch directory", async () => {
  const r = rig();
  const git = r.ctx.dependencies!.git!;
  let pruned = false;
  r.ctx.dependencies!.git = async (args, opts) => {
   if (args[0] === "worktree" && args[1] === "remove") return { code: 1, stdout: "", stderr: "remove refused" };
   if (args[0] === "worktree" && args[1] === "prune") {
    expect(existsSync(r.servers[0].cwd)).toBe(false);
    pruned = true;
   }
   return git(args, opts);
  };
  expect(await captureViews(r.ctx)).toMatchObject({ status: "ok" });
  expect(pruned).toBe(true);
 });
 test("unconfigured needs-eye map does not run or persist failure evidence", async () => {
  const r = rig();
  r.ctx.map.commands.views = undefined;
  expect(await captureViews(r.ctx)).toBeUndefined();
  expect(r.calls).toEqual([]);
  expect(existsSync(r.out)).toBe(false);
 });
 test("failed preflight retries on the same SHA once probes pass", async () => {
  const r = rig();
  r.ctx.probePassed = false;
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed" });
  r.ctx.probePassed = true;
  expect(await captureViews(r.ctx)).toMatchObject({ status: "ok" });
  expect(loadViewsRecord(r.out, SHA)).toMatchObject({ status: "ok" });
  expect(r.servers).toHaveLength(2);
 });
 test("transient capture failure retries, removing partial frames before recapture", async () => {
  const r = rig();
  const run = r.ctx.dependencies!.run!;
  r.ctx.dependencies!.run = async (bin, args, opts) => {
   const result = await run(bin, args, opts);
   if (args[1].startsWith("capture 'after2'")) {
    writeFileSync(join(r.out, "after2", "partial.png"), "stale");
    return { code: -1, stdout: "", stderr: "transient timeout" };
   }
   return result;
  };
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed" });
  expect(existsSync(join(r.out, "after2", "partial.png"))).toBe(true);
  r.ctx.dependencies!.run = run;
  expect(await captureViews(r.ctx)).toMatchObject({ status: "ok" });
  expect(existsSync(join(r.out, "after2", "partial.png"))).toBe(false);
  expect(r.servers).toHaveLength(4);
  expect(r.servers.every(s => s.stopped)).toBe(true);
 });
 test("command secrets are redacted before persistence, PR comment and card", async () => {
  const r = rig();
  const secret = "worker-secret-value";
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  r.ctx.env.API_KEY = secret;
  r.ctx.dependencies!.run = async () => ({ code: 1, stdout: token, stderr: `install refused ${secret}\n` });
  const record = await captureViews(r.ctx);
  expect(record).toMatchObject({ status: "failed" });
  const published = [readFileSync(join(r.out, "ranger-views.json"), "utf8"), viewsComment(record!, r.out), (await viewsCard(r.out, SHA)).summary];
  for (const text of published) {
   expect(text).not.toContain(secret);
   expect(text).not.toContain(token);
   expect(text).toContain("[redacted]");
  }
  expect(redactViewsReason(`refused ${secret}`, { PASSWORD: secret })).toBe("refused [redacted]");
  const log = readFileSync(join(r.out, VIEWS_FAILURE_LOG), "utf8");
  expect(log).not.toContain(secret);
  expect(log).not.toContain(token);
 });
 test("a failed after2 capture names its step, exit and stderr ahead of a long stdout, and saves the full output", async () => {
  const r = rig();
  const run = r.ctx.dependencies!.run!;
  const listing = Array.from({ length: 60 }, (_, i) => `pit  station-trade · overhead-deep view-${i}`).join("\n");
  expect(listing.length).toBeGreaterThan(2048);
  r.ctx.dependencies!.run = async (bin, args, opts) => args[1].startsWith("capture 'after2'")
   ? { code: 1, stdout: listing, stderr: "Error: page crashed at npc-arrival\n" }
   : run(bin, args, opts);
  const record = await captureViews(r.ctx);
  expect(record).toMatchObject({ status: "failed", output: VIEWS_FAILURE_LOG });
  if (record?.status !== "failed") throw new Error("expected a failed record");
  expect(record.reason).toStartWith("after2 capture failed (exit 1): Error: page crashed at npc-arrival\nstdout: …");
  expect(record.reason.length).toBeLessThanOrEqual(1000);
  expect(record.reason).toEndWith("view-59");
  expect(loadViewsRecord(r.out, SHA)).toEqual(record);
  const log = readFileSync(join(r.out, VIEWS_FAILURE_LOG), "utf8");
  expect(log).toContain("step: after2 capture\nexit: 1\n");
  expect(log).toContain("Error: page crashed at npc-arrival");
  expect(log).toContain(listing);
  expect(viewsComment(record, r.out)).toContain(`Full output of the failed step: \`${join(r.out, VIEWS_FAILURE_LOG)}\``);
  expect((await viewsCard(r.out, SHA)).summary).toContain(join(r.out, VIEWS_FAILURE_LOG));
  // A retry that passes leaves no failure log behind for the new record.
  r.ctx.dependencies!.run = run;
  expect(await captureViews(r.ctx)).toMatchObject({ status: "ok" });
  expect(existsSync(join(r.out, VIEWS_FAILURE_LOG))).toBe(false);
 });
 test("a killed step leads with it even when stderr alone exceeds the limit", async () => {
  const r = rig();
  r.ctx.dependencies!.run = async () => ({ code: -1, stdout: "listing ".repeat(500), stderr: `${"noise ".repeat(400)}final error` });
  const record = await captureViews(r.ctx);
  if (record?.status !== "failed") throw new Error("expected a failed record");
  expect(record.reason).toStartWith("before dependency install timed out or was killed: …");
  expect(record.reason).toEndWith("final error");
  expect(record.reason).not.toContain("listing");
  expect(record.reason.length).toBeLessThanOrEqual(1000);
  expect(readFileSync(join(r.out, VIEWS_FAILURE_LOG), "utf8")).toContain("exit: timed out or was killed");
 });
 test("a secret where the cut lands is redacted before shortening", async () => {
  const r = rig();
  const secret = "s3cr3t-".repeat(20);
  r.ctx.env.SESSION_TOKEN = secret;
  const token = "ghp_" + "Z".repeat(60);
  for (let pad = 0; pad < 40; pad += 7) {
   // stdout's tail is cut mid-way through each secret at some padding.
   const stdout = `${secret} ${token} ${"x".repeat(pad)}\n${"y".repeat(800)}`;
   r.ctx.dependencies!.run = async () => ({ code: 1, stdout, stderr: "refused" });
   const record = await captureViews(r.ctx);
   if (record?.status !== "failed") throw new Error("expected a failed record");
   const published = [record.reason, viewsComment(record, r.out), readFileSync(join(r.out, VIEWS_FAILURE_LOG), "utf8")];
   for (const text of published) {
    expect(text).not.toContain(secret.slice(-16));
    expect(text).not.toContain(token.slice(-16));
   }
  }
 });
 test("non-step reasons keep their start when shortened", () => {
  const reason = redactViewsReason(`views server failed: ${"z".repeat(3000)} end`, {});
  expect(reason).toStartWith("views server failed: ");
  expect(reason).toEndWith(" end");
  expect(reason.length).toBeLessThanOrEqual(1000);
 });
 test("a record naming any other output file is not trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranger-views-"));
  dirs.push(dir);
  writeFileSync(join(dir, "ranger-views.json"), JSON.stringify({ sha: SHA, status: "failed", reason: "x", output: "../../etc/passwd" }));
  expect(loadViewsRecord(dir, SHA)).toBeUndefined();
 });
 test("without needs-eye runs nothing, even with missing configuration", async () => {
  const r = rig();
  r.ctx.labels = [];
  r.ctx.map.commands = { probeTimeoutMin: 30 };
  expect(await captureViews(r.ctx)).toBeUndefined();
  expect(r.calls).toEqual([]);
  expect(r.servers).toEqual([]);
  expect(existsSync(r.out)).toBe(false);
 });
 test("requires a passing probe before doing anything, but failure remains evidence", async () => {
  const r = rig();
  r.ctx.probePassed = false;
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed", reason: "no passing probe tier on the final head" });
  expect(r.calls).toEqual([]);
  expect((await viewsCard(r.out, SHA)).summary).toContain("Sheet could not be made");
 });
 test("merge-base detached before, final-head after/control, diff and cleanup, persisted per SHA", async () => {
  const r = rig();
  const record = await captureViews(r.ctx);
  expect(record).toEqual({ sha: SHA, status: "ok", rows: [{ view: "hull", change: 2.3, noise: 0.1 }, { view: "sky", change: 0, noise: 0 }] });
  expect(r.calls[0]).toBe("git rev-parse HEAD");
  expect(r.calls[1]).toBe(`git merge-base ${SHA} origin/main`);
  expect(r.calls[2]).toContain("worktree add --detach");
  expect(r.calls[2]).toEndWith(BASE);
  expect(r.calls.filter(c => c.startsWith("capture")).map(c => c.split(" ")[1])).toEqual(["'before'", "'after'", "'after2'"]);
  expect(r.calls.filter(c => c.startsWith("diff"))).toHaveLength(2);
  expect(r.servers).toHaveLength(2);
  expect(r.servers.every(s => s.stopped)).toBe(true);
  expect(r.servers[1].cwd).toBe(r.ctx.worktree);
  expect(existsSync(r.servers[0].cwd)).toBe(false);
  expect(r.calls.at(-2)).toStartWith("git worktree remove --force");
  expect(r.calls.at(-1)).toBe("git worktree prune");
  expect(loadViewsRecord(r.out, SHA)).toEqual(record);
  expect(loadViewsRecord(r.out, BASE)).toBeUndefined();
  const before = r.calls.length;
  await captureViews(r.ctx);
  expect(r.calls).toHaveLength(before); // resume uses only this head's evidence
  const card = await viewsCard(r.out, SHA);
  expect(card.files.map(f => f.name)).toEqual(["hull-before.png", "hull-after.png"]);
  expect(card.summary).toContain("sky (change does not exceed single control sample)");
  expect(viewsComment(record!, r.out)).toContain(`<!-- ranger:views sha=${SHA} -->`);
  expect(viewsComment(record!, r.out)).toContain("| hull | 2.30% | 0.10% |");
  expect(viewsComment(record!, r.out)).toContain(`${r.out}/index.html`);
 });
 test.each([1, -1])("capture failure (exit %p) stops server, removes worktree and records reason", async code => {
  const r = rig();
  r.ctx.dependencies!.run = async () => ({ code, stdout: "", stderr: "software renderer refused" });
  const record = await captureViews(r.ctx);
  expect(record).toMatchObject({ status: "failed" });
  expect((await viewsCard(r.out, SHA)).summary).toContain("software renderer refused");
  if (code === -1) expect((await viewsCard(r.out, SHA)).summary).toContain("timed out");
  expect(r.servers).toEqual([]); // failed install before any server starts
  expect(r.calls.at(-2)).toStartWith("git worktree remove --force");
  expect(r.calls.at(-1)).toBe("git worktree prune");
 });
 test("a refused capture stops its server in finally", async () => {
  const r = rig();
  r.ctx.map.commands.install = undefined;
  r.ctx.dependencies!.run = async () => ({ code: 1, stdout: "", stderr: "software renderer refused" });
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed" });
  expect(r.servers).toHaveLength(1);
  expect(r.servers[0].stopped).toBe(true);
 });
 test("after2 timeout stops both servers and leaves informational failure evidence", async () => {
  const r = rig();
  const run = r.ctx.dependencies!.run!;
  r.ctx.dependencies!.run = async (bin, args, opts) => args[1].startsWith("capture 'after2'")
   ? { code: -1, stdout: "", stderr: "capture exceeded its timeout" }
   : run(bin, args, opts);
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed" });
  expect(r.servers).toHaveLength(2);
  expect(r.servers.every(s => s.stopped)).toBe(true);
  expect((await viewsCard(r.out, SHA)).summary).toContain("after2 capture timed out");
 });
 test("server failure is informational and cleans the detached tree", async () => {
  const r = rig();
  r.ctx.dependencies!.startServer = async () => { throw new Error("server readiness timed out"); };
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed", reason: "server readiness timed out" });
  expect(r.calls.at(-2)).toStartWith("git worktree remove --force");
  expect(r.calls.at(-1)).toBe("git worktree prune");
 });
 test("moved worktree head cannot produce evidence for the reviewed head", async () => {
  const r = rig();
  r.ctx.dependencies!.git = async () => ({ code: 0, stdout: BASE, stderr: "" });
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed", reason: "worktree differs from final PR head" });
  expect(r.servers).toEqual([]);
 });
 test("unknown capture placeholders fail informationally and stop the server", async () => {
  const r = rig();
  r.ctx.map.commands.views = "capture {tracker}";
  expect(await captureViews(r.ctx)).toMatchObject({ status: "failed", reason: "unknown views placeholder {tracker}" });
  expect(r.servers[0].stopped).toBe(true);
 });
 test("full names survive large summaries in a text attachment within the message file cap", async () => {
  const r = rig();
  const rows = Array.from({ length: 100 }, (_, i) => ({ view: `view-${String(i).padStart(3, "0")}`, change: 100 - i, noise: 0 }));
  for (const label of ["before", "after"]) {
   mkdirSync(join(r.out, label), { recursive: true });
   for (const row of rows) writeFileSync(join(r.out, label, `${row.view}.png`), "PNG");
  }
  saveViewsRecord(r.out, { sha: SHA, status: "ok", rows });
  const card = await viewsCard(r.out, SHA);
  expect(card.summary.length).toBeLessThan(2000);
  expect(card.files).toHaveLength(9); // four intact pairs and the full text
  expect(card.files.at(-1)?.name).toBe("views-summary.txt");
  const summary = await card.files.at(-1)!.data.text();
  expect(summary).toContain("view-099 (message attachment limit)");
  expect(summary).toContain("view-004 (message attachment limit)");
 });
 test("missing sheet, partial control, or viewport mismatch becomes a failure", async () => {
  for (const issue of ["sheet", "control", "viewport"]) {
   const r = rig();
   const run = r.ctx.dependencies!.run!;
   r.ctx.dependencies!.run = async (bin, args, opts) => {
    const result = await run(bin, args, opts);
    if (args[1].startsWith("diff")) {
     if (issue === "sheet") rmSync(join(r.out, "index.html"), { force: true });
     if (issue === "control") result.stdout = result.stdout.replace(/^hull.*\n/, "");
     if (issue === "viewport") result.stdout = "hull sizes differ — captured at two viewports";
    }
    return result;
   };
   expect(await captureViews(r.ctx)).toMatchObject({ status: "failed" });
  }
 });
});

describe("card message fitting", () => {
 test("keeps small summaries in content and longer summaries within embed limits", () => {
  expect(viewsCardMessage("card")).toEqual({ content: "card" });
  expect(viewsCardMessage("card", { summary: "diff", files: [] })).toEqual({ content: "card\ndiff", files: [] });
  const summary = "s".repeat(6000);
  const card = viewsCardMessage("card", { summary, files: [] });
  expect(card.content).toBe("card");
  expect(card.embeds?.map(e => e.description.length)).toEqual([4096, 1904]);
  expect(card.embeds?.map(e => e.description).join("")).toBe(summary);
 });
});

describe("dev server lifecycle (no browser)", () => {
 test("localhost readiness and process-group shutdown include a descendant", async () => {
  const r = rig();
  const port = await freeViewsPort();
  const script = join(r.ctx.worktree, "dev-server.mjs");
  const info = join(r.ctx.worktree, "processes.json");
  mkdirSync(r.ctx.worktree, { recursive: true });
  writeFileSync(script, `import { createServer } from "node:http";\nimport { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn("/bin/sleep", ["60"]);\nwriteFileSync(process.argv[3], JSON.stringify({ pid: process.pid, child: child.pid }));\ncreateServer((_req, res) => res.end("ready")).listen(Number(process.argv[2]), "localhost");\n`);
  const command = fillViewsTemplate("{bun} {script} {port} {info}", { bun: process.execPath, script, port, info });
  const server = await startViewsServer(command, r.ctx.worktree, { PATH: process.env.PATH }, `http://localhost:${port}`);
  const pids = JSON.parse(readFileSync(info, "utf8"));
  try {
   expect(pidAlive(pids.pid)).toBe(true);
   expect(pidAlive(pids.child)).toBe(true);
   // The group is the detached `/bin/sh -c`'s, not the script's: macOS sh execs a
   // simple command in place, so the two coincide there, but dash (Ubuntu CI)
   // keeps the shell as leader. Ask for the script's group rather than assume it.
   const pgid = Number((await runCmd("ps", ["-o", "pgid=", "-p", String(pids.pid)], { timeoutMs: 10_000 })).stdout.trim());
   expect(Number.isInteger(pgid) && pgid > 1).toBe(true);
   expect((await processGroupCommands(pgid)).some(c => c.includes("sleep 60"))).toBe(true);
  } finally { await server.stop(); }
  // SIGKILL reaches the whole group at once, but where the shell stayed leader
  // the script is orphaned with it and stays a zombie, which kill(pid, 0) still
  // reports alive, until init reaps it. Wait for the reap, not the signal.
  const reaped = async (pid: number) => {
   for (const end = Date.now() + 5_000; pidAlive(pid) && Date.now() < end; ) await Bun.sleep(25);
   return !pidAlive(pid);
  };
  expect(await reaped(pids.pid)).toBe(true);
  expect(await reaped(pids.child)).toBe(true);
 }, 10_000);
 test("a server exiting before readiness fails with diagnostics", async () => {
  const r = rig();
  const port = await freeViewsPort();
  await expect(startViewsServer("echo server-refused >&2; exit 1", tmpdir(), {}, `http://localhost:${port}`)).rejects.toThrow("server-refused");
 });
});

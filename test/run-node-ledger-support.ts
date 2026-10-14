// Fixtures shared by the run-node run-ledger tests (run-node-ledger.test.ts,
// run-node-serves-goal.test.ts).
import { expect } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 createEnvelope, validateExecutionRunFinished,
 type ExecutionRunFinishedEvent, type MyelinEnvelope, type RunOutcome,
} from "@the-metafactory/myelin";
import type { RunRunNodeDeps } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import type { ForgePort } from "../src/forge.ts";
import { Journal } from "../src/journal.ts";
import { runLedgerPath, type RunLedgerDeps } from "../src/run-ledger.ts";
import type { RunNodeOutcome } from "../src/worker.ts";
import { fixturesBin } from "./support.ts";

export const AT = "2026-10-14T07:00:00.000Z";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const dirs: string[] = [];
export const savedEnv = new Map<string, string | undefined>();
export function env(key: string, value: string) {
 if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
 process.env[key] = value;
}
/** Restores the env `env` set and removes every fixture directory: each test file runs it after each test. */
export function cleanup(): void {
 for (const [key, value] of savedEnv) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
 }
 savedEnv.clear();
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function fixture(bus: string | null = "  principal: jc\n", repo = "acme/widgets", row = true) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-node-ledger-"));
 dirs.push(dir);
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(configPath, `maps:\n  - repo: ${repo}\n    root: 1\n    walk: full\nauth:\n  writeTokens:\n    "acme/*": RANGER_WRITE_TEST\nstate:\n  journalPath: ${join(dir, "state.sqlite")}\n${bus === null ? "" : `bus:\n${bus}`}`);
 const config = loadConfig(configPath, {}).config;
 const journal = new Journal(config.state.journalPath);
 if (row) {
  journal.upsertWorker({ nodeId: "10", repo, root: 1, status: "claimed" });
  // Prove detail_ref is for a resumed generation rather than hard-coded g1.
  journal.beginGeneration("10", repo);
 }
 let closed = false;
 const close = journal.close.bind(journal);
 journal.close = () => { closed = true; close(); };
 return { dir, configPath, config, journal, spool: runLedgerPath(config), closed: () => closed };
}
export type Fixture = ReturnType<typeof fixture>;
export function deps(f: Fixture, ledger: RunLedgerDeps = {}, overrides: RunRunNodeDeps = {}): RunRunNodeDeps {
 return {
  loadCtx: () => ({ config: f.config, journal: f.journal }),
  runNodeContext: async () => ({ token: "ghp_write", botIdentity: "ivy-bot" }),
  now: () => new Date(AT),
  ledger: { env: {}, ...ledger },
  ...overrides,
 };
}
export function result(status: RunNodeOutcome["status"]): RunNodeOutcome {
 return { nodeId: "10", repo: "acme/widgets", status, detail: "unchanged outcome", workerExit: null };
}
export function controlled(status: RunNodeOutcome["status"]): RunRunNodeDeps["runNode"] {
 return async (id, ctx) => {
  if (ctx.journal.getWorker(id, ctx.map.repo) === null) {
   ctx.journal.upsertWorker({ nodeId: id, repo: ctx.map.repo, root: ctx.map.root, status: "running" });
  }
  ctx.journal.beginGeneration(id, ctx.map.repo);
  return { ...result(status), repo: ctx.map.repo };
 };
}
export function valid(event: ExecutionRunFinishedEvent, outcome: RunOutcome) {
 const envelope = createEnvelope({ ...event.input, sovereignty: event.input.sovereignty as MyelinEnvelope["sovereignty"] });
 expect(validateExecutionRunFinished(envelope)).toEqual({ valid: true, errors: [] });
 expect(event.input.payload.outcome).toBe(outcome);
 expect(event.input.payload.run_id).toMatch(UUID);
 expect(event.input.payload).not.toHaveProperty("state");
 expect(envelope).not.toHaveProperty("state");
}
export function failures(f: Fixture) {
 const journal = new Journal(f.journal.path);
 try { return journal.listEvents().filter(event => event.kind === "ledger-failed"); }
 finally { journal.close(); }
}
export function spool(f: Fixture): { op: string; envelope: MyelinEnvelope }[] {
 return readFileSync(f.spool, "utf8").trim().split("\n").map(line => JSON.parse(line));
}
export function graphFixture(f: Fixture, options: { kind?: string; autonomy?: string; status?: string } = {}) {
 const data = join(import.meta.dir, "fixtures", "data");
 copyFileSync(join(data, "acme__widgets-node-1.json"), join(f.dir, "acme__widgets-node-1.json"));
 const node = JSON.parse(readFileSync(join(data, "acme__widgets-node-10.json"), "utf8"));
 writeFileSync(join(f.dir, "acme__widgets-node-10.json"), JSON.stringify({
  ...node, status: options.status ?? "open",
  node: { ...node.node, kind: options.kind ?? "task", autonomy: options.autonomy ?? "auto" },
 }));
 env("PATH", `${fixturesBin}:${process.env.PATH ?? ""}`);
 env("FAKE_SOMA_DIR", f.dir);
}
export function forge(findPrByHead: ForgePort["findPrByHead"]): ForgePort {
 const unexpected = async (): Promise<never> => { throw new Error("unexpected forge call"); };
 return {
  findPrByHead, getPr: unexpected, ciVerdictFor: unexpected, issueLabels: unexpected,
  listComments: unexpected, createDraftPr: unexpected, updatePrBody: unexpected,
  markReady: unexpected, postComment: unexpected, mergePr: unexpected,
 };
}

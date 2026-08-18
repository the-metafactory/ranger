#!/usr/bin/env bun
import { Command } from "commander";
import { resolve } from "node:path";
import {
 loadConfig,
 expandHome,
 type RangerConfig,
 type RangerMapConfig,
} from "./config.ts";
import {
 graphAudit,
 graphFrontier,
 graphNode,
 type FrontierEntry,
 type NodeResult,
} from "./graph.ts";
import {
 renderJson,
 renderText,
 type ClaimCard,
 type MapReport,
 type ScoutReport,
} from "./report.ts";
import { classify, hitlWaiting, loadProbeRegistry } from "./route.ts";
import {
 assertReadOnlyToken,
 GateError,
 type ResolvedToken,
} from "./token-gate.ts";
import { openJournal, type Journal } from "./journal.ts";
import {
 assertNotPrincipal,
 resolveBotIdentity,
 resolveWriteToken,
 WriteGateError,
} from "./identity.ts";
import { runNode } from "./worker.ts";
import { sweepMap } from "./sweep.ts";
import { walk } from "./walk.ts";
import {
 escalateMaps,
 runDigest,
 type EscalateResult,
 type DigestResult,
} from "./escalate.ts";
import type { WalkMode } from "./config.ts";

/**
 * ranger — autonomous orienteer work-graph walker.
 *
 * - `scout` (node #12) — read-only frontier/audit/HITL digest. Zero graph writes.
 * - `walk` (node #13) — the headless tick: claim + spawn + sweep. Graph writes.
 * - `run-node <id>` — the detached worker supervisor (research lane).
 * - `sweep` — reconcile the journal against reality.
 * - `journal` — inspect the journal.
 */

const READONLY_SURFACE = ["audit", "frontier", "node"] as const;

interface ScoutOptions {
 config: string;
 json: boolean;
}

async function scoutOneMap(
 config: RangerConfig,
 map: { repo: string; root: number; walk: WalkMode },
 registry: ReturnType<typeof loadProbeRegistry>,
): Promise<MapReport> {
 const base: MapReport = {
  repo: map.repo,
  root: map.root,
  walk: map.walk,
  ok: true,
  frontier: [],
  hitlWaiting: [],
  claims: [],
  receiptLessCloses: [],
  openWithoutCheckpoint: [],
  auditNodes: 0,
 };

 let token: ResolvedToken;
 try {
  ({ token } = await assertReadOnlyToken(config, map.repo));
 } catch (error) {
  return {
   ...base,
   ok: false,
   error: error instanceof GateError ? error.message : String(error),
  };
 }

 try {
  const [frontier, audit] = await Promise.all([
   graphFrontier(map.repo, map.root, token),
   graphAudit(map.repo, map.root, token),
  ]);

  const classified = frontier.frontier.map((entry: FrontierEntry) =>
   classify(entry, map.repo, map.walk, registry),
  );
  const waiting = hitlWaiting(classified);

  const claims: ClaimCard[] = [];
  for (const claimed of audit.openClaimed) {
   const node: NodeResult = await graphNode(map.repo, claimed.id, token);
   claims.push({
    id: claimed.id,
    title: node.node.title,
    assignees: claimed.assignees,
    worker: "unknown",
   });
  }

  return {
   ...base,
   frontier: classified,
   hitlWaiting: waiting,
   claims,
   receiptLessCloses: audit.closedWithoutReceipt,
   openWithoutCheckpoint: audit.openWithoutCheckpoint,
   auditNodes: audit.nodes,
  };
 } catch (error) {
  return {
   ...base,
   ok: false,
   error: error instanceof Error ? error.message : String(error),
  };
 }
}

async function runScout(opts: ScoutOptions): Promise<ScoutReport> {
 const configPath = resolve(process.cwd(), opts.config);
 const { config } = loadConfig(configPath);
 const registry = loadProbeRegistry();

 let identity = {
  login: "",
  tokenType: "fine-grained" as "classic" | "fine-grained",
 };
 for (const map of config.maps) {
  try {
   const { info } = await assertReadOnlyToken(config, map.repo);
   identity = { login: info.login, tokenType: info.tokenType };
   break;
  } catch {
   /* per-map gate handles the error */
  }
 }

 const maps: MapReport[] = [];
 for (const map of config.maps) {
  maps.push(await scoutOneMap(config, map, registry));
 }

 return {
  generatedAt: new Date().toISOString(),
  identity,
  readonlySurface: [...READONLY_SURFACE],
  maps,
 };
}

// ---- walker commands ----

function loadCtx(configPath: string): {
 config: RangerConfig;
 journal: Journal;
} {
 const { config } = loadConfig(configPath);
 const journal = openJournal(config);
 return { config, journal };
}

/** Resolve the write credential + bot identity for a map, gating the principal. */
async function writeContext(config: RangerConfig, map: RangerMapConfig) {
 const credential = resolveWriteToken(config, map.repo);
 const botIdentity = await resolveBotIdentity(config, credential.token);
 assertNotPrincipal(config, botIdentity);
 return { token: credential.token, botIdentity };
}

async function runWalk(configPath: string): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const result = await walk({ config, configPath, journal });
 return renderWalkJson(result);
}

async function runRunNode(
 nodeId: string,
 repo: string | undefined,
 configPath: string,
): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const map = pickMap(config, repo);
 const { token, botIdentity } = await writeContext(config, map);
 const outcome = await runNode(nodeId, {
  config,
  map,
  token,
  botIdentity,
  journal,
 });
 journal.close();
 return JSON.stringify(outcome, null, 2);
}

async function runSweep(configPath: string): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const results = [];
 for (const map of config.maps) {
  if (map.walk === "none") {
   results.push({
    repo: map.repo,
    walk: map.walk,
    swept: false,
    reason: "walk: none",
   });
   continue;
  }
  try {
   const { token, botIdentity } = await writeContext(config, map);
   const result = await sweepMap({ config, journal, map, token, botIdentity });
   results.push({ repo: map.repo, walk: map.walk, swept: true, result });
  } catch (error) {
   results.push({
    repo: map.repo,
    walk: map.walk,
    swept: false,
    error: error instanceof Error ? error.message : String(error),
   });
  }
 }
 journal.close();
 return JSON.stringify(results, null, 2);
}

async function runJournal(
 repo: string | undefined,
 configPath: string,
): Promise<string> {
 const { config, journal } = loadCtx(configPath);
 const target = repo === undefined ? undefined : normalizeRepo(repo, config);
 const rows = {
  journalPath: expandHome(config.state.journalPath),
  paused: journal.isPaused(),
  deadmanCount: journal.deadmanCount(),
  spawnsToday: journal.spawnsToday(),
  workers: journal.listWorkers(target),
  escalations: journal.listEscalations(target),
  events: journal.listEvents(target, 50),
 };
 journal.close();
 return JSON.stringify(rows, null, 2);
}

function pickMap(
 config: RangerConfig,
 repo: string | undefined,
): RangerMapConfig {
 if (repo !== undefined) {
  const map = config.maps.find((m) => m.repo === repo);
  if (map === undefined) {
   throw new Error(`no map registered for repo '${repo}'`);
  }
  return map;
 }
 if (config.maps.length === 1) return config.maps[0];
 throw new Error(
  `--map <repo> is required when more than one map is registered (registered: ${config.maps.map((m) => m.repo).join(", ")})`,
 );
}

function normalizeRepo(repo: string, config: RangerConfig): string {
 const map = config.maps.find(
  (m) => m.repo === repo || m.repo.endsWith(`/${repo}`),
 );
 return map?.repo ?? repo;
}

function renderWalkJson(result: unknown): string {
 return JSON.stringify(result, null, 2);
}

function renderEscalateText(result: EscalateResult | DigestResult): string {
 const lines: string[] = [`ranger escalate — ${result.generatedAt}`];
 for (const map of result.maps) {
  if (!map.ok) {
   lines.push(`map: ${map.repo}`, `  ✗ FAILED — ${map.error}`, "");
   continue;
  }
  if (map.kind === "digest") {
   const d = map;
   lines.push(`map: ${map.repo} (digest ${d.action} ${d.digestMessageId})`);
   lines.push(
    `  cards: ${d.cards.length}${d.cards.length ? ` (${d.cards.map((c) => `#${c.nodeId} ${c.ageDays}d`).join(", ")})` : " — clean"}`,
   );
   lines.push(
    `  audit: receipt-less ${d.receiptLessCloses.length}${d.receiptLessCloses.length ? ` ${d.receiptLessCloses.join(",")}` : ""} · stale ${d.openClaims.length} · budget ${d.budget.spawnsToday}/${d.budget.spawnCapPerDay}${d.budget.paused ? " PAUSED" : ""}`,
   );
  } else {
   const e = map;
   lines.push(`map: ${map.repo}`);
   lines.push(
    `  posted: ${e.posted.length ? e.posted.map((n) => `#${n}`).join(", ") : "—"}`,
   );
   lines.push(
    `  edited: ${e.edited.length ? e.edited.map((n) => `#${n}`).join(", ") : "—"}`,
   );
   lines.push(
    `  keptOpen: ${e.keptOpen.length ? e.keptOpen.map((n) => `#${n}`).join(", ") : "—"}`,
   );
   lines.push(`  cards: ${e.cards.length}`);
   if (e.cardErrors.length > 0) {
    lines.push(`  ⚠ retry-next-tick: ${e.cardErrors.join("; ")}`);
   }
  }
  lines.push("");
 }
 return lines.join("\n").trimEnd();
}

const program = new Command();
program
 .name("ranger")
 .description("Autonomous orienteer work-graph walker")
 .version("0.1.0");

program
 .command("scout")
 .description(
  "Read-only frontier/audit/HITL digest across registered maps (zero graph writes)",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .option("-j, --json", "emit machine-readable JSON")
 .action(async (options: { config: string; json: boolean }) => {
  try {
   const report = await runScout({
    config: options.config,
    json: options.json,
   });
   process.stdout.write(
    options.json ? renderJson(report) + "\n" : renderText(report) + "\n",
   );
   const failed = report.maps.some((m) => !m.ok);
   process.exit(failed ? 2 : 0);
  } catch (error) {
   process.stderr.write(
    `ranger scout: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("walk")
 .description(
  "Headless tick: claim decided research frontier nodes (announce-fail-closed, race-safe), spawn detached run-node workers, then sweep",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runWalk(configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger walk: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("tick")
 .description(
  "One bounded autonomous pass (design §1): escalation cards (design §5) then the walk claim phase — so HITL/provisioning cards are posted/edited on the schedule, not just by the daily digest. The launchd tick runs this.",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { config: string }) => {
  const configPath = resolve(process.cwd(), options.config);
  let config: RangerConfig;
  let journal: Journal;
  try {
   ({ config, journal } = loadCtx(configPath));
  } catch (error) {
   process.stderr.write(
    `ranger tick: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
  // Escalation must NOT prevent walking: a lock-contention timeout (an
  // overlapping digest/cards run holds the desk) or any other escalate
  // failure is REPORTED in the output, but walk still runs — scheduled
  // claims are independent of the desk (round-34 review).
  let escalateResult: EscalateResult | null = null;
  let escalateError: string | undefined;
  try {
   escalateResult = await escalateMaps(config, journal);
  } catch (error) {
   escalateError = error instanceof Error ? error.message : String(error);
  }
  try {
   // walk re-fetches its OWN frontier: claims must classify from a fresh
   // read — a ~120s-old escalation-pass frontier could misroute a node
   // edited to HITL in that window (round-29 review).
   const walkResult = await walk({ config, configPath, journal });
   journal.close();
   process.stdout.write(
    JSON.stringify(
     {
      generatedAt: new Date().toISOString(),
      escalate: escalateResult ?? { error: escalateError, maps: [] },
      walk: walkResult,
     },
     null,
     2,
    ) + "\n",
   );
   const failed =
    escalateError !== undefined ||
    (escalateResult?.maps.some((m) => !m.ok) ?? false) ||
    walkResult.maps.some((m) => m.errors.length > 0);
   process.exit(failed ? 2 : 0);
  } catch (error) {
   journal.close();
   process.stderr.write(
    `ranger tick: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("run-node")
 .description(
  "Detached worker supervisor: worktree, research worker, gated close, decisions --write",
 )
 .argument("<id>", "node id to execute")
 .option("-m, --map <repo>", "map repo (required with multiple maps)")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (id: string, options: { map?: string; config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runRunNode(id, options.map, configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger run-node: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(error instanceof WriteGateError ? 2 : 1);
  }
 });

program
 .command("sweep")
 .description(
  "Reconcile the journal against reality (crashed workers, stale claims)",
 )
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runSweep(configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger sweep: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("journal")
 .description("Inspect the journal (workers, events, health)")
 .option("--repo <repo>", "filter by map repo")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .action(async (options: { repo?: string; config: string }) => {
  try {
   const configPath = resolve(process.cwd(), options.config);
   process.stdout.write((await runJournal(options.repo, configPath)) + "\n");
  } catch (error) {
   process.stderr.write(
    `ranger journal: ${error instanceof Error ? error.message : String(error)}\n`,
   );
   process.exit(1);
  }
 });

program
 .command("escalate")
 .description(
  "Escalation desk (design §5): post/edit HITL + provisioning cards in each map's Discord thread (announce-once, edit-not-repost, age-banded); --digest emits the daily aged-cards + audit + budget digest. Graph-read-only.",
 )
 .option("--digest", "emit the daily digest instead of the cards pass")
 .option("-c, --config <path>", "path to ranger.yaml", "ranger.yaml")
 .option("-j, --json", "emit machine-readable JSON")
 .action(
  async (options: { digest: boolean; config: string; json: boolean }) => {
   try {
    const configPath = resolve(process.cwd(), options.config);
    const { config } = loadConfig(configPath);
    const journal = openJournal(config);
    // Test seam: RANGER_NOW injects the clock (age-banding tests).
    const now = process.env.RANGER_NOW
     ? new Date(process.env.RANGER_NOW)
     : undefined;
    const result = options.digest
     ? await runDigest(config, journal, now === undefined ? {} : { now })
     : await escalateMaps(config, journal, now === undefined ? {} : { now });
    journal.close();
    process.stdout.write(
     options.json
      ? JSON.stringify(result, null, 2) + "\n"
      : renderEscalateText(result) + "\n",
    );
    const failed = result.maps.some((m) => !m.ok);
    process.exit(failed ? 2 : 0);
   } catch (error) {
    process.stderr.write(
     `ranger escalate: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
   }
  },
 );

program.parseAsync(process.argv).catch((error) => {
 process.stderr.write(
  `ranger: ${error instanceof Error ? error.message : String(error)}\n`,
 );
 process.exit(1);
});

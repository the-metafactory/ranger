#!/usr/bin/env bun
import { Command } from "commander";
import { resolve } from "node:path";
import { loadConfig, type RangerConfig } from "./config.ts";
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

/**
 * ranger scout — read-only tick: frontier + audit + HITL digest across
 * registered maps, to a CLI report. Zero graph writes (design §9 build step 1).
 */

const READONLY_SURFACE = ["audit", "frontier", "node"] as const;

interface ScoutOptions {
  config: string;
  json: boolean;
}

async function scoutOneMap(
  config: RangerConfig,
  map: { repo: string; root: number; walk: "none" | "full" },
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

  // Gate the whole run on one representative token for the identity line — but
  // per-map gating still happens in scoutOneMap (a failing map must not fail
  // every map). First successful token wins for the header identity.
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

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(
    `ranger: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

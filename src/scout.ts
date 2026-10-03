/**
 * One map's read-only scout pass (node #12): frontier + audit under the
 * read-only token gate, classified exactly as the walk classifies. Shared by
 * `ranger scout` and `ranger serve` (#37); it performs zero graph writes.
 */
import type { RangerConfig, WalkMode } from "./config.ts";
import {
 graphAudit,
 graphFrontier,
 graphNode,
 type FrontierEntry,
 type NodeResult,
} from "./graph.ts";
import type { ClaimCard, MapReport } from "./report.ts";
import { classify, hitlWaiting, type loadProbeRegistry } from "./route.ts";
import {
 assertReadOnlyToken,
 GateError,
 type ResolvedToken,
} from "./token-gate.ts";

export async function scoutOneMap(
 config: RangerConfig,
 map: { repo: string; root: number; walk: WalkMode; nodes?: string[]; skip?: string[] },
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
   classify(entry, map.repo, map.walk, registry, {
        botIdentity: config.bot.identity,
        allowlist: map.nodes,
        skip: map.skip,
      }),
  );
  const waiting = hitlWaiting(classified);

  // In parallel: `ranger serve` (#37) re-reads every map on a timer.
  const claims: ClaimCard[] = await Promise.all(
   audit.openClaimed.map(async (claimed) => {
    const node: NodeResult = await graphNode(map.repo, claimed.id, token);
    return {
     id: claimed.id,
     title: node.node.title,
     assignees: claimed.assignees,
     worker: "unknown" as const,
    };
   }),
  );

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

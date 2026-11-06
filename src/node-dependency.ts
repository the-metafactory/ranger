import { OperationFailure } from "./operation-outcome.ts";
import { z } from "zod";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { requireEndpoint, requireReachable, type EndpointLookup, type EndpointProbe } from "./endpoint.ts";
import { selectSubstrate, type SubstrateName, type SubstrateReaders } from "./substrate.ts";
import { selectForBuild } from "./substrate-policy.ts";

export type NodeSelector = (map: RangerMapConfig, lane: "implement" | "research") => Promise<SubstrateName>;
export async function selectNodeSubstrate(journal: Journal, config: RangerConfig, excluded: ReadonlySet<SubstrateName>, readers?: SubstrateReaders) {
 return selectSubstrate(journal, { config: config.substrates, excluded, readers, pick: selectForBuild });
}
export function defaultNodeSelector(config: RangerConfig, journal: Journal, readers?: SubstrateReaders): NodeSelector {
 let build: Promise<SubstrateName> | undefined;
 return (_map, lane) => {
  if (lane === "research") return Promise.resolve("claude");
  build ??= selectNodeSubstrate(journal, config, new Set(), readers).then(result => result.substrate);
  return build;
 };
}
export async function nodePreflight(args: {
 config?: RangerConfig; map: RangerMapConfig; lane: "implement" | "research"; requiresModel: boolean;
 selector?: NodeSelector; probe?: EndpointProbe; lookup?: EndpointLookup;
}): Promise<SubstrateName | undefined> {
 await requireReachable(args.map.reachable, args.probe);
 if (!args.requiresModel || args.selector === undefined || process.env.RANGER_WORKER_CMD) return undefined;
 if (args.config === undefined) throw new OperationFailure({ kind: "unknown", operation: "node-selection", evidence: "model dispatch has no configuration", action: "supply the model dispatch configuration" });
 const selected = await args.selector(args.map, args.lane);
 await requireEndpoint(args.config, selected, undefined, args.probe, args.lookup);
 return selected;
}
const pinnedSchema = z.object({ generation: z.number().int(), substrate: z.enum(["claude", "codex", "pi"]) });
const key = (repo: string, nodeId: string) => `dispatch-substrate:${repo}#${nodeId}`;
export function pinNodeSubstrate(journal: Journal, owner: { nodeId: string; repo: string; generation: number }, substrate: SubstrateName): boolean {
 return journal.recoveryTransaction(owner, () => {
  if (!journal.updateReservation(owner.nodeId, owner.repo, owner.generation, { substrate })) return false;
  journal.setHealth(key(owner.repo, owner.nodeId), JSON.stringify({ generation: owner.generation, substrate }));
  return true;
 });
}
export function pinnedNodeSubstrate(journal: Journal, repo: string, nodeId: string, generation: number): SubstrateName | undefined {
 const raw = journal.getHealth(key(repo, nodeId));
 if (raw === null) return undefined;
 try {
  const pin = pinnedSchema.parse(JSON.parse(raw));
  return pin.generation === generation ? pin.substrate : undefined;
 } catch { return undefined; }
}

/**
 * `ranger serve`'s drain controls (node #166): Drain/Undrain on the visual
 * lane, one machine-wide switch, and on each headless map, each by running
 * `ranger drain` (node #165). The runner is injected, as for the Needs-you
 * actions, so no test runs ranger.
 */
import { REPO_PATTERN } from "./config.ts";
import { decodeForgeKey } from "./forge-ref.ts";
import type { ImplementLane } from "./lanes.ts";
import { holding, noConfigPath, refusal, runOperatorVerb, type ActionResponse, type ActionRunner } from "./serve-parked.ts";

/** What a drain names: the visual lane (one machine-wide switch), or one headless map. */
export type DrainTarget = { lane: "visual" } | { key: string };

/** `ranger drain` (node #165), the operator verb; `off` lifts the drain. */
export function drainArgv(args: { rangerBin: string; configPath: string; target: DrainTarget; off: boolean }): string[] {
 let selector: string[];
 if ("lane" in args.target) {
  if (args.target.lane !== "visual") throw new Error(`bad lane: ${String(args.target.lane)}`);
  selector = ["--lane", "visual"];
 } else {
  const { repo } = decodeForgeKey(args.target.key);
  if (!REPO_PATTERN.test(repo)) throw new Error(`bad map: ${args.target.key}`);
  selector = ["--map", args.target.key];
 }
 return [args.rangerBin, "drain", ...selector, ...(args.off ? ["--off"] : []), "-c", args.configPath];
}

export interface DrainBody {
 lane?: unknown;
 key?: unknown;
 off?: unknown;
 dryRun?: unknown;
}

export interface DrainDeps {
 /** The maps as the dashboard reads them now. */
 maps: { key: string; lane: ImplementLane; servedOnly: boolean }[];
 run: ActionRunner;
 env: Record<string, string | undefined>;
 rangerBin: string;
 configPath: string | undefined;
 /** Drains with a verb running now, owned by the server. */
 inFlight: Set<string>;
}

/**
 * Drain or undrain: the visual lane as one switch, or one headless map. A
 * visual map has no drain of its own, and a serve-only map is not ranger's
 * to drain: both are refused here, with nothing run, as the verb itself
 * would refuse them.
 */
export async function runDrainAction(body: DrainBody, deps: DrainDeps): Promise<ActionResponse> {
 if ((body.lane === undefined) === (body.key === undefined)) return refusal(400, "name exactly one of lane or key");
 let target: DrainTarget;
 if (body.lane !== undefined) {
  if (body.lane !== "visual") return refusal(400, "only the visual lane drains as one switch; a headless map drains on its own");
  target = { lane: "visual" };
 } else {
  if (typeof body.key !== "string") return refusal(400, "key must be a string");
  const map = deps.maps.find((m) => m.key === body.key);
  if (map === undefined) return refusal(404, `no map ${body.key}`);
  if (map.servedOnly) return refusal(409, `${map.key} is shown here only: ranger does not walk it, so there is nothing to drain`);
  if (map.lane === "visual") return refusal(409, `${map.key} is on the visual lane, which drains as one switch for every visual map: use the visual lane's drain`);
  target = { key: map.key };
 }
 if (deps.configPath === undefined) return noConfigPath("drain");
 const off = body.off === true;
 const argv = drainArgv({ rangerBin: deps.rangerBin, configPath: deps.configPath, target, off });
 const held = "lane" in target ? "drain:lane:visual" : `drain:map:${target.key}`;
 return holding(deps.inFlight, held, "a drain of this target is already running: wait for it, then reload",
  () => runOperatorVerb(argv, body.dryRun, deps, "drain", { ...target, off }));
}

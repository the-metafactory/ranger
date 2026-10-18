import { executableApproval } from "./approval-spec.ts";
import { holding, refusal, noConfigPath, runOperatorVerb, type ActionRunner, type ActionResponse } from "./serve-parked.ts";

export async function runApproveAction(body: Record<string, unknown>, deps: {
 maps: { key: string; walk: string; servedOnly: boolean; decisions: { id: string; kind: string; autonomy: string; approvalVersion?: string; approvable?: boolean }[] }[];
 configPath?: string;
 rangerBin: string;
 run: ActionRunner;
 env: Record<string, string | undefined>;
 inFlight: Set<string>;
}): Promise<ActionResponse> {
 if (typeof body.key !== "string" || typeof body.id !== "string" || !/^\d+$/.test(body.id)) return refusal(400, "a map key and numeric id are required");
 const map = deps.maps.find((m) => m.key === body.key);
 const node = map?.decisions.find((d) => d.id === body.id);
 if (map === undefined || node === undefined) return refusal(404, "node is not awaiting a decision on this map");
 if (map.servedOnly || map.walk !== "full" || node.approvable !== true || !executableApproval(node)) return refusal(409, "only approval-gated task/build nodes on implementation maps can be approved");
 if (typeof body.version !== "string" || !/^[a-f0-9]{64}$/.test(body.version) || body.version !== node.approvalVersion) return refusal(409, "node changed; refresh before approving");
 if (deps.configPath === undefined) return noConfigPath("approve");
 const argv = [deps.rangerBin, "approve-node", node.id, "--map", map.key, "--version", body.version, "-c", deps.configPath];
 return holding(deps.inFlight, "approve:" + map.key + "/" + node.id, "approval is already running", () =>
  runOperatorVerb(argv, body.dryRun, deps, "approve", { nodeId: node.id }));
}

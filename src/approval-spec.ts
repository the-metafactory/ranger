import { createHash } from "node:crypto";

export const isNodeId = (id: string): boolean => /^\d+$/.test(id);
export const isApprovalVersion = (version: string): boolean => /^[a-f0-9]{64}$/.test(version);

export const NODE_BLOCK = /<!--\s*soma:work-graph-node\s*([\s\S]*?)-->/g;

export function approvalVersion(node: { title: string; kind?: unknown; autonomy?: unknown; checkpointId?: unknown; probes?: unknown; budget?: unknown; serves?: unknown }, body = ""): string {
 return createHash("sha256").update(JSON.stringify({
  title: node.title,
  kind: node.kind,
  autonomy: node.autonomy,
  checkpointId: node.checkpointId,
  probes: node.probes ?? [],
  budget: node.budget,
  serves: node.serves,
  body: body.replace(NODE_BLOCK, "").trim(),
 })).digest("hex");
}

export const executableApproval = (node: { typed?: boolean; autonomy: string; kind: string }): boolean =>
 node.typed !== false && node.autonomy === "approve" && ["task", "build"].includes(node.kind);

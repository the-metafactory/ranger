import { createHash } from "node:crypto";

export const isNodeId = (id: string): boolean => /^\d+$/.test(id);
export const isApprovalVersion = (version: string): boolean => /^[a-f0-9]{64}$/.test(version);

export const NODE_BLOCK = /<!--\s*soma:work-graph-node\s*([\s\S]*?)-->/g;

export const APPROVAL_MARKER_LINE = /^<!-- ranger:approved by=([^\s<>]+) at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) version=([a-f0-9]{64}) -->$/;

const INTAKE_MARKER_LINE = /^<!-- ranger:intake discord=\d+ -->$/;

export function formatApprovalMarker(login: string, at: Date, version: string): string {
 return `<!-- ranger:approved by=${login} at=${at.toISOString()} version=${version} -->`;
}

export function stripApprovalMarker(body: string): string {
 return body.replace(/(?:^|\r?\n)[\t ]*<!-- ranger:approved\b[^\r\n]*-->\s*$/, "");
}

export function approvalVersion(node: { title: string; kind?: unknown; autonomy?: unknown; checkpointId?: unknown; probes?: unknown; budget?: unknown; serves?: unknown }, body = ""): string {
 return createHash("sha256").update(JSON.stringify({
  title: node.title,
  kind: node.kind,
  autonomy: node.autonomy,
  checkpointId: node.checkpointId,
  probes: node.probes ?? [],
  budget: node.budget,
  serves: node.serves,
  body: stripApprovalMarker(body).replace(NODE_BLOCK, "").trim(),
 })).digest("hex");
}

export const executableApproval = (node: { typed?: boolean; autonomy: string; kind: string }): boolean =>
 node.typed !== false && ["approve", "propose"].includes(node.autonomy) && ["task", "build"].includes(node.kind);

interface ApprovalSubject {
 author: string;
 body?: string;
 node: Parameters<typeof approvalVersion>[0];
}

export function principalFiled(node: ApprovalSubject, botIdentity: string, principal?: string): boolean {
 if (node.author.toLowerCase() !== botIdentity.toLowerCase()) return true;
 const last = (node.body ?? "").trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";
 if (INTAKE_MARKER_LINE.test(last)) return true;
 const approval = APPROVAL_MARKER_LINE.exec(last);
 return principal !== undefined && principal.trim() !== "" && approval !== null &&
  approval[1].toLowerCase() === principal.toLowerCase() &&
  Number.isFinite(Date.parse(approval[2])) && approval[3] === approvalVersion(node.node, node.body);
}

export function proposeApprovable(node: ApprovalSubject & { typed?: boolean }, botIdentity?: string, principal?: string): boolean {
 if (botIdentity === undefined) return false;
 return node.node.autonomy === "propose" &&
  executableApproval({ typed: node.typed, kind: String(node.node.kind), autonomy: node.node.autonomy }) &&
  node.author.toLowerCase() === botIdentity.toLowerCase() &&
  !principalFiled(node, botIdentity, principal);
}

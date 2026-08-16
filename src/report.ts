import type { ClassifiedNode } from "./route.ts";
import { byRoute, ESCALATE_REASONS, ROUTE_LABELS } from "./route.ts";
import type { WalkMode } from "./config.ts";

/**
 * Scout report model + text/JSON renderers.
 */

export interface ClaimCard {
  id: string;
  title: string;
  assignees: string[];
  /** v1 has no journal — a claim is "unknown" unless ranger's journal proves a live worker. */
  worker: "unknown" | "in-flight";
}

export interface MapReport {
  repo: string;
  root: number;
  walk: WalkMode;
  ok: boolean;
  error?: string;
  frontier: ClassifiedNode[];
  hitlWaiting: ClassifiedNode[];
  claims: ClaimCard[];
  receiptLessCloses: string[];
  openWithoutCheckpoint: string[];
  auditNodes: number;
}

export interface ScoutReport {
  generatedAt: string;
  identity: { login: string; tokenType: string };
  readonlySurface: string[];
  maps: MapReport[];
}

function clean(map: MapReport): boolean {
  return (
    map.receiptLessCloses.length === 0 && map.openWithoutCheckpoint.length === 0
  );
}

function nodeLine(node: ClassifiedNode): string {
  return `#${node.id} ${node.title}`;
}

function renderMapText(map: MapReport): string {
  const lines: string[] = [];
  const header = `map: ${map.repo} (root ${map.root}, walk: ${map.walk})`;
  if (!map.ok) {
    lines.push(header, `  ✗ FAILED — ${map.error}`, "");
    return lines.join("\n");
  }

  lines.push(header);

  // Frontier by route class
  const groups = byRoute(map.frontier);
  const ordered = [
    "escalate-hitl",
    "research",
    "research (not walked)",
    "implement",
    "implement (not walk:full)",
    "provisioning",
  ].filter((k) => groups.has(k));
  if (map.frontier.length === 0) {
    lines.push("  frontier: 0 — no open, unassigned, unblocked nodes");
  } else {
    lines.push(
      `  frontier: ${map.frontier.length} open, unassigned, unblocked`,
    );
    for (const key of ordered) {
      const entries = groups.get(key);
      if (!entries) continue;
      const label = ROUTE_LABELS[key] ?? key;
      lines.push(
        `    ${label.padEnd(22)} ${String(entries.length).padStart(2)}  ${entries.map(nodeLine).join(" · ")}`,
      );
    }
  }

  // HITL waiting
  if (map.hitlWaiting.length === 0) {
    lines.push("  HITL waiting: 0");
  } else {
    lines.push(`  HITL waiting: ${map.hitlWaiting.length}`);
    for (const node of map.hitlWaiting) {
      const reason =
        node.route.route === "escalate-hitl"
          ? ESCALATE_REASONS[node.route.reason]
          : "";
      lines.push(
        `    #${node.id} ${node.title} — ${node.autonomy} · ${node.kind}${reason ? ` — ${reason}` : ""}`,
      );
    }
  }

  // Audit
  lines.push(...renderAudit(map));
  lines.push("");
  return lines.join("\n");
}

function renderAudit(map: MapReport): string[] {
  const lines: string[] = ["  audit:"];
  lines.push(
    `    receipt-less closes:  ${map.receiptLessCloses.length}${map.receiptLessCloses.length ? ` (${map.receiptLessCloses.join(", ")})` : ""}`,
  );
  lines.push(
    `    open w/o checkpoint:  ${map.openWithoutCheckpoint.length}${map.openWithoutCheckpoint.length ? ` (${map.openWithoutCheckpoint.join(", ")})` : ""}`,
  );
  if (map.claims.length === 0) {
    lines.push("    claimed:              0");
  } else {
    lines.push(
      `    claimed:              ${map.claims.length} (in-flight or stale — no journal to arbitrate)`,
    );
    for (const claim of map.claims) {
      lines.push(
        `      #${claim.id} ${claim.title} [${claim.assignees.join(", ")}] — worker ${claim.worker}`,
      );
    }
  }
  lines.push(
    `  ${clean(map) ? "clean ✓" : "issues ✗ — the audit names; it does not repair"}`,
  );
  return lines;
}

export function renderText(report: ScoutReport): string {
  const lines: string[] = [];
  lines.push(`ranger scout — ${report.generatedAt}`);
  lines.push(
    `identity: ${report.identity.login || "unknown"} (${report.identity.tokenType}) · read-only surface: ${report.readonlySurface.join("/")}`,
  );
  lines.push("");
  for (const map of report.maps) {
    lines.push(renderMapText(map).trimEnd());
  }
  return lines.join("\n").trimEnd();
}

export function renderJson(report: ScoutReport): string {
  return JSON.stringify(report, null, 2);
}

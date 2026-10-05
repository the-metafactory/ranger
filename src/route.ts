import { readFileSync } from "node:fs";
import type { FrontierEntry } from "./graph.ts";
import type { WalkMode } from "./config.ts";

/**
 * Frontier classification — design §3 routing table, first match wins.
 *
 * Scout is read-only, so classes that depend on ranger's own state (1: vetoed/
 * parked, 6: budget-exhausted) are structurally absent in v1 — the journal and
 * ledger don't exist yet — and are documented, not guessed. Class 5 (probes not
 * satisfiable) is evaluated with a light local probe-registry preflight.
 */

export type EscalateReason =
  | "propose-approve"
  | "hitl-kind-as-auto"
  | "untyped";

export type RouteClass =
  | { route: "escalate-hitl"; reason: EscalateReason }
  | { route: "research"; walkable: boolean }
  | {
      route: "implement";
      walkable: boolean;
      /**
       * How the close is ratified: `auto` closes on probes + CI; `merge`
       * is a `propose` task/build node whose ratification is the
       * principal's merge of the PR (#23 ruling, 2026-10-03).
       */
      ratify: "auto" | "merge";
    }
  | { route: "provisioning" };

export interface ClassifiedNode {
  id: string;
  title: string;
  kind: string;
  autonomy: string;
  typed: boolean;
  url: string;
  checkpointId?: string;
  route: RouteClass;
  /** Auto node declaring command/url probes — the class-5 signal. */
  registryBlocked: boolean;
  /** The blocked probe specs (run/cwd/host) — rendered on provisioning cards. */
  blockedProbes?: BlockedProbe[];
  /** The node question/prose body — rendered on grilling cards (design §5). */
  body?: string;
}

/** Per-map walk scope beyond the walk mode (#23). */
export interface ClassifyOptions {
  /** The machine account. Nodes it authored never take the propose→merge route (node #9 ban). */
  botIdentity?: string;
  /** `ranger.yaml` map.nodes: when set, only these ids are walkable. */
  allowlist?: string[];
  /** `ranger.yaml` map.skip: these ids are never walkable. */
  skip?: string[];
}

export interface ClassifyContext {
  /** The map's `walk` mode from ranger.yaml (affects lane walkability). */
  walkMode: WalkMode;
  /** Probe registry (from `~/.soma/policy/probe-registry.json`), keyed by repo. */
  registry?: ProbeRegistry;
}

export interface ProbeRegistry {
  version?: number;
  repos?: Record<
    string,
    { commands?: { run: string; cwd: string }[]; urlHosts?: string[] }
  >;
}

export const ROUTE_LABELS: Record<string, string> = {
  "escalate-hitl": "escalate (HITL)",
  research: "research",
  implement: "implement",
  provisioning: "provisioning",
};

export const ESCALATE_REASONS: Record<EscalateReason, string> = {
  "propose-approve":
    "propose/approve — HITL decision, escalates to the principal",
  "hitl-kind-as-auto":
    "HITL kind (grilling/prototype) declared auto — map hygiene",
  untyped: "typed block missing/broken — node needs typing",
};

export const HITL_KINDS = new Set(["grilling", "prototype"]);
export const IMPLEMENT_KINDS = new Set(["task", "build"]);

/** Load the probe registry from soma-home; absent file → empty registry. */
export function loadProbeRegistry(
  path = process.env.HOME + "/.soma/policy/probe-registry.json",
): ProbeRegistry {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProbeRegistry;
  } catch {
    return {};
  }
}

/** Are a node's declared probes satisfiable by the registry on this host? */
export function probesRegistryBlocked(
  node: FrontierEntry["node"],
  repo: string,
  registry: ProbeRegistry,
): boolean {
  return blockedProbeSpecs(node, repo, registry).length > 0;
}

/** A declared probe the registry does not satisfy (class-5 preflight). */
export interface BlockedProbe {
  type: "command" | "url";
  /** command probe — the exact run string the registry must declare. */
  run?: string;
  /** command probe — the exact cwd the registry must declare. */
  cwd?: string;
  /** url probe — the target host the registry must declare. */
  target?: string;
  host?: string;
}

/** The declared probes that are not satisfiable by the registry on this host. */
export function blockedProbeSpecs(
  node: FrontierEntry["node"],
  repo: string,
  registry: ProbeRegistry,
): BlockedProbe[] {
  const probes = node.probes ?? [];
  if (probes.length === 0) return [];
  const repoEntry = registry.repos?.[repo];
  const declaredCommands = new Set(
    (repoEntry?.commands ?? []).map((c) => `${c.run}\u0000${c.cwd}`),
  );
  const declaredHosts = new Set(
    (repoEntry?.urlHosts ?? []).map((h) => h.toLowerCase()),
  );
  const blocked: BlockedProbe[] = [];
  for (const probe of probes) {
    if (probe.type === "command") {
      const run = typeof probe.run === "string" ? probe.run : "";
      const cwd = typeof probe.cwd === "string" ? probe.cwd : "";
      if (!declaredCommands.has(`${run}\u0000${cwd}`)) {
        blocked.push({ type: "command", run, cwd });
      }
    } else if (probe.type === "url") {
      let host = "";
      const target = typeof probe.target === "string" ? probe.target : "";
      try {
        host = new URL(target).host.toLowerCase();
      } catch {
        /* unparseable target counts as blocked */
        blocked.push({ type: "url", target, host: "(unparseable)" });
        continue;
      }
      if (!declaredHosts.has(host)) {
        blocked.push({ type: "url", target, host });
      }
    }
  }
  return blocked;
}

/**
 * Classify a frontier node per the §3 routing table. `registryBlocked` is
 * computed for auto nodes with command/url probes (class 5 preflight).
 */
export function classify(
  node: FrontierEntry,
  repo: string,
  walkMode: WalkMode,
  registry: ProbeRegistry,
  opts: ClassifyOptions = {},
): ClassifiedNode {
  const { autonomy, kind } = node.node;
  const { typed } = node;
  const id = node.ref.id;
  const base = {
    id,
    title: node.node.title,
    kind,
    autonomy,
    typed,
    url: node.url,
    checkpointId: node.node.checkpointId,
    registryBlocked: false,
    body: node.body,
  };

  // Class 4 — untyped block (fail-safe approve). Reported as needs-typing.
  if (!typed) {
    return { ...base, route: { route: "escalate-hitl", reason: "untyped" } };
  }
  const allowed =
    (opts.allowlist === undefined || opts.allowlist.includes(id)) &&
    !(opts.skip ?? []).includes(id);
  // Class 2a (#23 ruling) — a `propose` task/build node on a `walk: full`
  // map is walked like an auto one up to the merge; the principal's merge is
  // the ratification. Never for nodes ranger itself filed (node #9: ranger
  // never walks work it minted), never when the bot identity is unknown,
  // and never off the allowlist — an unwalked node keeps its HITL card.
  if (
    autonomy === "propose" &&
    IMPLEMENT_KINDS.has(kind) &&
    walkMode === "full" &&
    allowed &&
    opts.botIdentity !== undefined &&
    node.author !== opts.botIdentity &&
    blockedProbeSpecs(node.node, repo, registry).length === 0
  ) {
    return {
      ...base,
      route: { route: "implement", walkable: true, ratify: "merge" },
    };
  }
  // Class 2 — HITL autonomy, any kind.
  if (autonomy === "propose" || autonomy === "approve") {
    return {
      ...base,
      route: { route: "escalate-hitl", reason: "propose-approve" },
    };
  }
  // Class 3 — HITL kind declared auto.
  if (HITL_KINDS.has(kind)) {
    return {
      ...base,
      route: { route: "escalate-hitl", reason: "hitl-kind-as-auto" },
    };
  }
  // Classes 5–8 — auto + typed.
  if (autonomy !== "auto") {
    // Unknown autonomy value — fail safe toward escalation.
    return { ...base, route: { route: "escalate-hitl", reason: "untyped" } };
  }
  const blockedProbes = blockedProbeSpecs(node.node, repo, registry);
  if (blockedProbes.length > 0) {
    return {
      ...base,
      registryBlocked: true,
      blockedProbes,
      route: { route: "provisioning" },
    };
  }
  if (kind === "research") {
    return {
      ...base,
      route: {
        route: "research",
        walkable:
          allowed && (walkMode === "full" || walkMode === "research-only"),
      },
    };
  }
  if (IMPLEMENT_KINDS.has(kind)) {
    return {
      ...base,
      route: {
        route: "implement",
        walkable: allowed && walkMode === "full",
        ratify: "auto",
      },
    };
  }
  // Unknown kind — conservative hygiene escalate.
  return { ...base, route: { route: "escalate-hitl", reason: "untyped" } };
}

/**
 * Classify a map's whole frontier with its walk scope: walk mode, allowlist
 * and skip. The walk, `ranger build-now` (node #58) and `ranger serve` call
 * this one copy, so a node the dashboard shows as walkable is one the walk
 * would take.
 */
export function classifyFrontier(
  entries: FrontierEntry[],
  map: { repo: string; walk: WalkMode; nodes?: string[]; skip?: string[] },
  registry: ProbeRegistry,
  botIdentity: string | undefined,
): ClassifiedNode[] {
  return entries.map((entry) =>
    classify(entry, map.repo, map.walk, registry, {
      botIdentity,
      allowlist: map.nodes,
      skip: map.skip,
    }),
  );
}

/** HITL queue: frontier nodes whose route is escalate-hitl. */
export function hitlWaiting(nodes: ClassifiedNode[]): ClassifiedNode[] {
  return nodes.filter((n) => n.route.route === "escalate-hitl");
}

/** Group frontier by route for the report. */
export function byRoute(
  nodes: ClassifiedNode[],
): Map<string, ClassifiedNode[]> {
  const groups = new Map<string, ClassifiedNode[]>();
  for (const node of nodes) {
    const key = routeKey(node.route);
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  return groups;
}

function routeKey(route: RouteClass): string {
  if (route.route === "implement")
    return route.walkable ? "implement" : "implement (not walk:full)";
  if (route.route === "research")
    return route.walkable ? "research" : "research (not walked)";
  if (route.route === "escalate-hitl") return "escalate-hitl";
  return route.route;
}

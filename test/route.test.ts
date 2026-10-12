import { describe, expect, test } from "bun:test";
import {
  byRoute,
  classify,
  hitlWaiting,
  loadProbeRegistry,
  probesRegistryBlocked,
  type ClassifiedNode,
  type ProbeRegistry,
} from "../src/route.ts";
import type { FrontierEntry } from "../src/graph.ts";

interface EntryOverrides {
  ref?: { id: string };
  node?: Partial<FrontierEntry["node"]>;
  typed?: boolean;
  url?: string;
  assignees?: string[];
  parent?: { id: string };
  blockedBy?: { id: string; status: string }[];
  status?: string;
}

function entry(over: EntryOverrides = {}): FrontierEntry {
  const base: FrontierEntry = {
    ref: over.ref ?? { id: "1" },
    node: {
      id: "1",
      title: "test node",
      kind: "task",
      autonomy: "auto",
      probes: [],
      ...over.node,
    },
    status: over.status ?? "open",
    assignees: over.assignees ?? [],
    blockedBy: over.blockedBy ?? [],
    author: "alice",
    url: over.url ?? "https://github.com/acme/widgets/issues/1",
    typed: over.typed ?? true,
  };
  if (over.parent) base.parent = over.parent;
  return base;
}

const EMPTY_REGISTRY: ProbeRegistry = {};

describe("classify — design §3 routing table", () => {
  test("propose autonomy → escalate (HITL)", () => {
    const node = classify(
      entry({ node: { autonomy: "propose", kind: "task" } }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({
      route: "escalate-hitl",
      reason: "propose-approve",
    });
  });

  test("approve autonomy → escalate (HITL)", () => {
    const node = classify(
      entry({ node: { autonomy: "approve", kind: "grilling" } }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({
      route: "escalate-hitl",
      reason: "propose-approve",
    });
  });

  test("HITL kind declared auto → escalate (map hygiene)", () => {
    for (const kind of ["grilling", "prototype"]) {
      const node = classify(
        entry({ node: { autonomy: "auto", kind } }),
        "acme/widgets",
        "full",
        EMPTY_REGISTRY,
      );
      expect(node.route).toEqual({
        route: "escalate-hitl",
        reason: "hitl-kind-as-auto",
      });
    }
  });

  test("untyped block (fail-safe) → escalate (needs typing)", () => {
    const node = classify(
      entry({ typed: false }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({ route: "escalate-hitl", reason: "untyped" });
  });

  test("auto + research → research lane", () => {
    const node = classify(
      entry({ node: { autonomy: "auto", kind: "research" } }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({ route: "research", walkable: true });
  });

  test("auto + task on walk:full → implement lane, walkable", () => {
    const node = classify(
      entry({ node: { autonomy: "auto", kind: "task" } }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({ route: "implement", walkable: true, ratify: "auto" });
  });

  test("auto + build on walk:none → implement lane, not walkable", () => {
    const node = classify(
      entry({ node: { autonomy: "auto", kind: "build" } }),
      "acme/widgets",
      "none",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({ route: "implement", walkable: false, ratify: "auto" });
  });

  test("auto + undeclared command probe → provisioning (class 5)", () => {
    const node = classify(
      entry({
        node: {
          autonomy: "auto",
          kind: "task",
          probes: [{ type: "command", run: "bun test", cwd: "/tmp/x" }],
        },
      }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route).toEqual({ route: "provisioning" });
    expect(node.registryBlocked).toBe(true);
  });

  test("auto + declared command probe → NOT provisioning", () => {
    const registry: ProbeRegistry = {
      repos: {
        "acme/widgets": {
          commands: [{ run: "bun test", cwd: "/tmp/x" }],
          urlHosts: [],
        },
      },
    };
    const node = classify(
      entry({
        node: {
          autonomy: "auto",
          kind: "task",
          probes: [{ type: "command", run: "bun test", cwd: "/tmp/x" }],
        },
      }),
      "acme/widgets",
      "full",
      registry,
    );
    expect(node.route).toEqual({ route: "implement", walkable: true, ratify: "auto" });
    expect(node.registryBlocked).toBe(false);
  });

  test("auto + unknown kind → conservative escalate", () => {
    const node = classify(
      entry({ node: { autonomy: "auto", kind: "wibble" } }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    );
    expect(node.route.route).toBe("escalate-hitl");
  });
});

describe("probesRegistryBlocked", () => {
  const nodeWith = (probes: FrontierEntry["node"]["probes"]) =>
    ({
      id: "1",
      title: "x",
      kind: "task",
      autonomy: "auto",
      probes,
    }) as FrontierEntry["node"];

  test("url probe with undeclared host → blocked", () => {
    const registry: ProbeRegistry = {
      repos: {
        "acme/widgets": { commands: [], urlHosts: ["status.example.com"] },
      },
    };
    expect(
      probesRegistryBlocked(
        nodeWith([{ type: "url", target: "https://other.example.com/h" }]),
        "acme/widgets",
        registry,
      ),
    ).toBe(true);
    expect(
      probesRegistryBlocked(
        nodeWith([{ type: "url", target: "https://status.example.com/h" }]),
        "acme/widgets",
        registry,
      ),
    ).toBe(false);
  });

  test("git-ref-exists and artifact-exists probes are ungated", () => {
    expect(
      probesRegistryBlocked(
        nodeWith([{ type: "git-ref-exists", ref: "main" }]),
        "acme/widgets",
        {},
      ),
    ).toBe(false);
  });

  test("no probes → not blocked", () => {
    expect(probesRegistryBlocked(nodeWith([]), "acme/widgets", {})).toBe(false);
  });
});

describe("hitlWaiting + byRoute", () => {
  const nodes: ClassifiedNode[] = [
    classify(
      entry({
        ref: { id: "a" },
        node: { id: "a", autonomy: "propose", kind: "task" },
      }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    ),
    classify(
      entry({
        ref: { id: "b" },
        node: { id: "b", autonomy: "auto", kind: "research" },
      }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    ),
    classify(
      entry({
        ref: { id: "c" },
        node: { id: "c", autonomy: "auto", kind: "grilling" },
      }),
      "acme/widgets",
      "full",
      EMPTY_REGISTRY,
    ),
  ];

  test("hitlWaiting picks the escalate classes", () => {
    const waiting = hitlWaiting(nodes);
    expect(waiting.map((n) => n.id).sort()).toEqual(["a", "c"]);
  });

  test("byRoute groups by route key", () => {
    const groups = byRoute(nodes);
    expect(groups.get("escalate-hitl")).toHaveLength(2);
    expect(groups.get("research")).toHaveLength(1);
  });
});

describe("loadProbeRegistry", () => {
  test("missing file → empty registry", () => {
    expect(loadProbeRegistry("/nonexistent/probe-registry.json")).toEqual({});
  });
});

describe("classify — propose research lane (node #246, rulings D6 + D10)", () => {
  const propose = (over: EntryOverrides = {}, author = "alice"): FrontierEntry => ({
    ...entry({ ...over, node: { autonomy: "propose", kind: "research", ...over.node } }),
    author,
  });
  const gates = { botIdentity: "ivy-agent", principal: "jcfischer", rootAuthor: "jcfischer" };
  const PROPOSE_APPROVE = { route: "escalate-hitl", reason: "propose-approve" } as const;

  test("principal-rooted GitHub map, walk full or research-only → research lane, ratified by proposal", () => {
    for (const walk of ["full", "research-only"] as const) {
      const node = classify(propose(), "acme/widgets", walk, EMPTY_REGISTRY, gates);
      expect(node.route).toEqual({ route: "research", walkable: true, ratify: "propose" });
    }
  });

  test("the principal's login matches the root author case-insensitively", () => {
    const node = classify(propose(), "acme/widgets", "full", EMPTY_REGISTRY, { ...gates, rootAuthor: "JCFischer" });
    expect(node.route).toEqual({ route: "research", walkable: true, ratify: "propose" });
  });

  test("a root the principal did not author → escalates as propose-approve", () => {
    const node = classify(propose(), "acme/widgets", "full", EMPTY_REGISTRY, { ...gates, rootAuthor: "alice" });
    expect(node.route).toEqual(PROPOSE_APPROVE);
  });

  test("an unknown root author or principal → escalates", () => {
    for (const opts of [{ ...gates, rootAuthor: undefined }, { ...gates, principal: undefined }]) {
      expect(classify(propose(), "acme/widgets", "full", EMPTY_REGISTRY, opts).route).toEqual(PROPOSE_APPROVE);
    }
  });

  test("a node the machine account filed, or an unknown machine account → escalates", () => {
    expect(classify(propose({}, "ivy-agent"), "acme/widgets", "full", EMPTY_REGISTRY, gates).route).toEqual(PROPOSE_APPROVE);
    expect(classify(propose(), "acme/widgets", "full", EMPTY_REGISTRY, { ...gates, botIdentity: undefined }).route).toEqual(PROPOSE_APPROVE);
  });

  test("a GitLab map → escalates", () => {
    const node = classify(propose(), "gitlab:gitlab.example.test/claw/sim", "full", EMPTY_REGISTRY, gates);
    expect(node.route).toEqual(PROPOSE_APPROVE);
  });

  test("walk: none, off the allowlist or on the skip list → escalates", () => {
    expect(classify(propose(), "acme/widgets", "none", EMPTY_REGISTRY, gates).route).toEqual(PROPOSE_APPROVE);
    expect(classify(propose(), "acme/widgets", "full", EMPTY_REGISTRY, { ...gates, allowlist: ["99"] }).route).toEqual(PROPOSE_APPROVE);
    expect(classify(propose(), "acme/widgets", "full", EMPTY_REGISTRY, { ...gates, skip: ["1"] }).route).toEqual(PROPOSE_APPROVE);
  });

  test("unregistered probes → escalates", () => {
    const node = classify(
      propose({ node: { probes: [{ type: "command", run: "bun test", cwd: "/tmp/x" }] } }),
      "acme/widgets", "full", EMPTY_REGISTRY, gates,
    );
    expect(node.route).toEqual(PROPOSE_APPROVE);
  });

  test("propose task/build and approve research keep their routes", () => {
    expect(classify(propose({ node: { kind: "task" } }), "acme/widgets", "research-only", EMPTY_REGISTRY, gates).route).toEqual(PROPOSE_APPROVE);
    expect(classify(propose({ node: { autonomy: "approve" } }), "acme/widgets", "full", EMPTY_REGISTRY, gates).route).toEqual(PROPOSE_APPROVE);
  });
});

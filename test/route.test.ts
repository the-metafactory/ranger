import { describe, expect, test } from "bun:test";
import {
  blockedProbeSpecs,
  byRoute,
  classify,
  hitlWaiting,
  loadProbeRegistry,
  probeRegistryKey,
  probesRegistryBlocked,
  type ClassifiedNode,
  type ProbeRegistry,
} from "../src/route.ts";
import type { FrontierEntry } from "../src/graph.ts";
import { intakeNodeBody } from "../src/intake.ts";
import { foundByProbeSpec, splitOutOfReviewSpec } from "../src/scribe.ts";

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
        "github.com/acme/widgets": {
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
        "github.com/acme/widgets": { commands: [], urlHosts: ["status.example.com"] },
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

describe("probe registry keys (soma registry v2)", () => {
  const SOMA = "/Users/x/soma";
  const probe = { type: "command", run: "bun test", cwd: SOMA } as const;
  const v2: ProbeRegistry = {
    version: 2,
    repos: { "github.com/acme/widgets": { commands: [{ run: "bun test", cwd: SOMA }], urlHosts: [] } },
  };
  const proposeBuild = (author = "alice") => {
    const e = entry({ node: { autonomy: "propose", kind: "build", probes: [probe] } });
    e.author = author;
    return e;
  };

  test("probeRegistryKey qualifies GitHub and GitLab repos with their host", () => {
    expect(probeRegistryKey("acme/widgets")).toBe("github.com/acme/widgets");
    expect(probeRegistryKey("github:github.com/acme/widgets")).toBe("github.com/acme/widgets");
    expect(probeRegistryKey("gitlab:gitlab.example.org/group/project")).toBe("gitlab.example.org/group/project");
  });

  test("an unparseable repo has no key, so every probe reads as blocked", () => {
    expect(probeRegistryKey("not a repo")).toBeNull();
    expect(blockedProbeSpecs(proposeBuild().node, "not a repo", v2)).toHaveLength(1);
  });

  test("a host-qualified registry entry satisfies a bare owner/name map repo", () => {
    expect(blockedProbeSpecs(proposeBuild().node, "acme/widgets", v2)).toEqual([]);
  });

  test("a bare owner/name registry key no longer authorises a probe", () => {
    const legacy: ProbeRegistry = {
      repos: { "acme/widgets": { commands: [{ run: "bun test", cwd: SOMA }], urlHosts: [] } },
    };
    expect(blockedProbeSpecs(proposeBuild().node, "acme/widgets", legacy)).toEqual([
      { type: "command", run: "bun test", cwd: SOMA },
    ]);
  });

  test("a GitLab map reads its own host's entry, never github.com's", () => {
    const repo = "gitlab:gitlab.example.org/acme/widgets";
    expect(blockedProbeSpecs(proposeBuild().node, repo, v2)).toHaveLength(1);
    const gitlab: ProbeRegistry = {
      version: 2,
      repos: { "gitlab.example.org/acme/widgets": { commands: [{ run: "bun test", cwd: SOMA }], urlHosts: [] } },
    };
    expect(blockedProbeSpecs(proposeBuild().node, repo, gitlab)).toEqual([]);
  });

  test("propose build with registered probes on a walk: full map → implement, merge-ratified", () => {
    const node = classify(proposeBuild(), "acme/widgets", "full", v2, { botIdentity: "bot" });
    expect(node.route).toEqual({ route: "implement", walkable: true, ratify: "merge" });
    expect(node.registryBlocked).toBe(false);
  });

  test("propose build with unregistered probes → provisioning card naming them, not a HITL card", () => {
    const node = classify(proposeBuild(), "acme/widgets", "full", EMPTY_REGISTRY, { botIdentity: "bot" });
    expect(node.route).toEqual({ route: "provisioning" });
    expect(node.registryBlocked).toBe(true);
    expect(node.blockedProbes).toEqual([{ type: "command", run: "bun test", cwd: SOMA }]);
  });

  test("a bot-authored propose build still escalates, probes or not (node #9 ban)", () => {
    for (const registry of [v2, EMPTY_REGISTRY]) {
      const node = classify(proposeBuild("bot"), "acme/widgets", "full", registry, { botIdentity: "bot" });
      expect(node.route).toEqual({ route: "escalate-hitl", reason: "propose-approve" });
    }
  });
});

describe("classify — intake-filed nodes walk as principal-filed (node #248, #21 ruling D5)", () => {
  const BOT = "ivy-agent";
  const MARKER = "<!-- ranger:intake discord=1288000000000000000 -->";
  const MERGE = { route: "implement", walkable: true, ratify: "merge" } as const;
  const HELD = { route: "escalate-hitl", reason: "propose-approve" } as const;
  const filed = (body: string, kind = "build", author = BOT): FrontierEntry => ({
    ...entry({ node: { autonomy: "propose", kind } }),
    author,
    body,
  });
  const route = (e: FrontierEntry) => classify(e, "acme/widgets", "full", EMPTY_REGISTRY, { botIdentity: BOT }).route;

  test("a bot-authored propose build or task carrying the intake marker → class 2a", () => {
    const body = intakeNodeBody({
      body: "## Deliverable\n\nThe thing.",
      messageUrl: "https://discord.com/channels/1/2/1288000000000000000",
      messageId: "1288000000000000000",
    });
    for (const kind of ["build", "task"]) {
      expect(route(filed(body, kind))).toEqual(MERGE);
    }
  });

  test("a bot-authored node without the marker is held as machine-filed", () => {
    expect(route(filed("## Deliverable\n\nThe thing."))).toEqual(HELD);
    const bare = entry({ node: { autonomy: "propose", kind: "build" } });
    expect(route({ ...bare, author: BOT })).toEqual(HELD);
  });

  test("a marker that is not the body's own last line, or has a non-numeric id, grants nothing", () => {
    for (const body of [
      `Quoted ${MARKER} mid-line`,
      `${MARKER} trailing`,
      `${MARKER}\n\nmore text after it`,
      "<!-- ranger:intake discord=abc -->",
      "<!-- ranger:intake discord= -->",
      "<!-- ranger:intake discord=12 --> -->",
    ]) {
      expect(route(filed(body))).toEqual(HELD);
    }
  });

  test("ranger's own filings outside intake are never walked, even quoting a marker (node #9 ban)", () => {
    const pr = { number: 7, url: "https://github.com/acme/widgets/pull/7" };
    const baseRed = foundByProbeSpec("acme/widgets", "main", { id: "5" }, "test", [MARKER], "a".repeat(40), pr);
    const review = { round: 2, sha: "b".repeat(40), blockers: 1, majors: 0, nits: 0, body: MARKER };
    const split = splitOutOfReviewSpec("acme/widgets", { id: "5", title: "x" }, pr, review);
    for (const spec of [baseRed, split]) {
      expect(spec.body).toContain(MARKER);
      expect(route(filed(spec.body ?? ""))).toEqual(HELD);
    }
  });

  test("the marker grants nothing off walk: full", () => {
    const body = `Words.\n\n${MARKER}`;
    for (const walk of ["research-only", "none"] as const) {
      expect(classify(filed(body), "acme/widgets", walk, EMPTY_REGISTRY, { botIdentity: BOT }).route).toEqual(HELD);
    }
  });
});

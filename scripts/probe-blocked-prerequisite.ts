#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlockedReport } from "../src/blocked-report.ts";
import { Journal } from "../src/journal.ts";
import { fileBlockedPrerequisite, type ScribeGraph } from "../src/scribe.ts";
import { openDb } from "../src/store/db.ts";
import { seedLegacyRoots } from "../src/store/legacy-roots.ts";

/** A parked cortex desk-adapter node as the operator's report file carried it (2026-11-10). */
const RECORDED_REPORT = `# Node #3358 is blocked

The desk adapter reads a session only through the Myelin export, and no release
carries one yet.

Resume condition: a Myelin release exports the session reader.
`;

/** A report whose resume condition names a node that is already open on the graph. */
const NAMED_OPEN_NODE = `# Node #3360 is blocked

Resume condition: node #3459 closes.
`;

const MAP = { repo: "the-metafactory/cortex", root: 3326 };
const PARKED = { id: "3358", title: "Read a session through the desk adapter", parent: { id: "3326" } };

interface StoreNode {
 parent: string | null;
 blockedBy: string[];
 autonomy: string;
 checkpointId?: string;
 status: string;
 title: string;
 body: string;
}

function fakeGraph(seed: Record<string, Partial<StoreNode>> = {}) {
 const nodes = new Map<string, StoreNode>();
 for (const [id, node] of Object.entries(seed)) {
  nodes.set(id, { parent: null, blockedBy: [], autonomy: "auto", status: "open", title: "", body: "", ...node });
 }
 let next = 4000;
 const graph: ScribeGraph = {
  add: async (parent, spec) => {
   const node = String(next++);
   nodes.set(node, { parent, blockedBy: [...(spec.blockedBy ?? [])], autonomy: spec.autonomy, checkpointId: spec.checkpoint, status: "open", title: spec.title, body: spec.body ?? "" });
   return { node };
  },
  link: async (node, parent, blockedBy) => {
   const found = nodes.get(node);
   if (found === undefined) throw new Error(`no node ${node}`);
   found.parent = parent;
   found.blockedBy = [...new Set([...found.blockedBy, ...blockedBy])];
  },
  node: async (id) => {
   const found = nodes.get(id);
   if (found === undefined) throw new Error(`no node ${id}`);
   return {
    ...(found.parent === null ? {} : { parent: { id: found.parent } }),
    blockedBy: found.blockedBy.map((b) => ({ id: b, status: "open" })),
    status: found.status,
    node: { id, title: found.title, kind: "build", autonomy: found.autonomy, ...(found.checkpointId === undefined ? {} : { checkpointId: found.checkpointId }) },
   };
  },
 };
 return { graph, nodes };
}

function check(label: string, ok: boolean, detail: string): boolean {
 console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : `: ${detail}`}`);
 return ok;
}

export async function probeBlockedPrerequisite(): Promise<number> {
 const dir = mkdtempSync(join(tmpdir(), "ranger-probe-blocked-prerequisite-"));
 const journal = new Journal(join(dir, "journal.sqlite"), openDb(":memory:", (db) => seedLegacyRoots(db, [], {})));
 const results: boolean[] = [];
 try {
  const { graph, nodes } = fakeGraph({
   [PARKED.id]: { parent: "3326", title: PARKED.title },
   "3459": { parent: "3326", title: "Land the session-read export" },
   "3360": { parent: "3326", title: "Another desk node" },
  });
  const park = { map: MAP, node: PARKED, report: parseBlockedReport(RECORDED_REPORT) };
  const seeded = new Set([PARKED.id, "3459", "3360"]);

  const first = await fileBlockedPrerequisite(graph, journal, park);
  const filed = [...nodes.entries()].filter(([id]) => !seeded.has(id));
  results.push(check("one node filed", first.kind === "filed" && filed.length === 1, `outcome ${JSON.stringify(first)}, ${filed.length} filed`));
  const node = filed[0]?.[1];
  results.push(check(
   "titled Prerequisite for #3358 and proposed, not auto",
   node?.title.startsWith("Prerequisite for #3358: ") === true && node.autonomy === "propose",
   `title ${node?.title}, autonomy ${node?.autonomy}`,
  ));
  results.push(check(
   "the body carries the resume condition and the report's evidence",
   node?.body.includes("a Myelin release exports the session reader.") === true &&
    node.body.includes("The desk adapter reads a session only through the Myelin export"),
   "the body is missing the condition or the reason",
  ));
  const parked = nodes.get(PARKED.id);
  results.push(check(
   "one edge: the parked node is blocked by the filed one",
   parked?.blockedBy.length === 1 && parked.blockedBy[0] === filed[0]?.[0],
   `blockedBy ${JSON.stringify(parked?.blockedBy)}`,
  ));

  const replay = await fileBlockedPrerequisite(graph, journal, park);
  const after = [...nodes.keys()].filter((id) => !seeded.has(id));
  results.push(check(
   "a replay files no second node and wires no second edge",
   replay.kind === "filed" && replay.added === false && after.length === 1 && nodes.get(PARKED.id)?.blockedBy.length === 1,
   `outcome ${JSON.stringify(replay)}, ${after.length} filed, blockedBy ${JSON.stringify(nodes.get(PARKED.id)?.blockedBy)}`,
  ));

  const named = await fileBlockedPrerequisite(graph, journal, {
   map: MAP,
   node: { id: "3360", title: "Another desk node", parent: { id: "3326" } },
   report: parseBlockedReport(NAMED_OPEN_NODE),
  });
  results.push(check(
   "a resume condition naming an open node links that node instead of filing one",
   named.kind === "linked" && named.node === "3459" && nodes.get("3360")?.blockedBy.includes("3459") === true && nodes.size === 4,
   `outcome ${JSON.stringify(named)}, nodes ${[...nodes.keys()].join(",")}`,
  ));
 } finally {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
 }
 console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
 return results.every(Boolean) ? 0 : 1;
}

if (import.meta.main) {
 try {
  process.exitCode = await probeBlockedPrerequisite();
 } catch (error) {
  console.error(`FAIL: the probe could not complete: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
 }
}

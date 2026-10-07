import type { RangerMapConfig } from "./config.ts";
import type { Journal, WorkerRow } from "./journal.ts";
import { implementLane, type ImplementLane } from "./lanes.ts";
import { recordImplementStart } from "./maps.ts";
import { infrastructureProbeHead } from "./outcomes.ts";
import type { OwnedCheck } from "./lock.ts";
import { pidAlive } from "./exec.ts";

const budgetKey = (row: Pick<WorkerRow, "repo" | "nodeId">, head: string) =>
 `probe-requeue:${row.repo}#${row.nodeId}@${head}`;

function attempts(journal: Journal, row: WorkerRow, head: string): number {
 const keys = head.length === 40 ? [budgetKey(row, head), budgetKey(row, head.slice(0, 8))] : [budgetKey(row, head)];
 // A legacy park names only eight digits. Its retry still counts after the
 // next failure records the full head; malformed state cannot reset a budget.
 return Math.max(0, ...keys.map((key) => {
  const value = journal.getHealth(key);
  return value === null ? 0 : /^\d+$/.test(value) ? Number(value) : Infinity;
 }));
}

/** Only authorized full maps; oldest parks first across every map in a lane. */
export function probeRequeueCandidates(journal: Journal, maps: readonly RangerMapConfig[], limit: number): WorkerRow[] {
 if (journal.isPaused() || limit === 0) return [];
 return journal.listWorkers().filter((row) => {
  const map = maps.find((map) => map.repo === row.repo && map.root === row.root);
  if (map === undefined || map.walk !== "full" || map.commands.probe === undefined ||
   map.skip.includes(row.nodeId) || (map.nodes !== undefined && !map.nodes.includes(row.nodeId)) ||
   journal.hasVeto(row.nodeId) || row.status !== "parked" || row.lane !== "implement" ||
   row.phase !== "review" || row.prNumber === null) return false;
  const head = infrastructureProbeHead(row.outcome ?? "");
  return head !== null && attempts(journal, row, head) < limit;
 }).sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? "") ||
  a.repo.localeCompare(b.repo) || a.nodeId.localeCompare(b.nodeId));
}

export interface ProbeRequeueResult {
 resumed: string[];
 pending: string[];
 errors: string[];
 /** Reserved for this whole tick, including when a child fails to spawn. */
 lanes: ImplementLane[];
}

/** Run under the claim lease, before merge-desk send-backs or fresh claims. */
export async function requeueProbes(args: {
 journal: Journal;
 maps: readonly RangerMapConfig[];
 limit: number;
 owned: OwnedCheck;
 spawn: (nodeId: string, repo: string, root: number) => Promise<number | null>;
}): Promise<ProbeRequeueResult> {
 const { journal, maps, limit, owned, spawn } = args;
 const result: ProbeRequeueResult = { resumed: [], pending: [], errors: [], lanes: [] };
 const attempted = new Set<ImplementLane>();
 for (const candidate of probeRequeueCandidates(journal, maps, limit)) {
  owned();
  // A pause, veto or newer occupant may arrive while the preceding child starts.
  const row = probeRequeueCandidates(journal, maps, limit).find((row) => row.repo === candidate.repo && row.nodeId === candidate.nodeId);
  if (row === undefined) continue;
  const map = maps.find((map) => map.repo === row.repo && map.root === row.root) as RangerMapConfig;
  const lane = implementLane(map);
  const key = `${row.repo}#${row.nodeId}`;
  if (!result.lanes.includes(lane)) result.lanes.push(lane);
  if (attempted.has(lane) || journal.laneHolder(lane, undefined, (row) => row.pid === null || pidAlive(row.pid)) !== null) {
   result.pending.push(key);
   continue;
  }
  attempted.add(lane);
  const head = infrastructureProbeHead(row.outcome as string) as string;
  const used = attempts(journal, row, head);
  // Reserve before spawning: the child must see a claimed row, and another
  // scheduler must see the lane occupied. The retry count also survives a crash.
  journal.updateWorker(row.nodeId, row.repo, { status: "claimed", pid: null, workerPgid: null, finishedAt: null });
  journal.setHealth(budgetKey(row, head), String(used + 1));
  let pid: number | null = null;
  try {
   pid = await spawn(row.nodeId, row.repo, row.root);
  } catch (error) {
   result.errors.push(`${key}: ${String(error)}`);
  }
  owned();
  const current = journal.getWorker(row.nodeId, row.repo);
  if (pid === null) {
   // Roll back only our reservation, never a child or operator's newer occupant.
   if (current?.generation === row.generation && current.status === "claimed" && current.pid === null) {
    journal.updateWorker(row.nodeId, row.repo, { status: "parked", pid: row.pid, finishedAt: row.finishedAt });
    journal.setHealth(budgetKey(row, head), String(used));
   }
   result.pending.push(key);
   result.errors.push(`${key}: probe requeue did not spawn; priority retained for the next tick`);
   continue;
  }
  // A fast child may already have completed; do not overwrite its status or PID.
  if (current?.generation === row.generation && current.status === "claimed" && current.pid === null) {
   journal.updateWorker(row.nodeId, row.repo, { pid });
  }
  recordImplementStart(journal, map);
  journal.recordEvent("sweep", { nodeId: row.nodeId, repo: row.repo,
   detail: `automatic probe requeue ${used + 1}/${limit} at ${head}; priority over queued work; run-node pid ${pid}` });
  result.resumed.push(key);
 }
 return result;
}

/** Implement capacity follows machine resources, independently of worker substrate. */
export const IMPLEMENT_LANES = ["visual", "headless"] as const;
export type ImplementLane = (typeof IMPLEMENT_LANES)[number];

export interface LaneMap {
 repo: string;
 root: number;
 lane?: ImplementLane;
 commands: { probe?: string };
}

/** A probe tier uses the screen/GPU by default; a map may explicitly override it. */
export function implementLane(map: Pick<LaneMap, "lane" | "commands">): ImplementLane {
 return map.lane ?? (map.commands.probe === undefined ? "headless" : "visual");
}

/** Resolve legacy rows from current config, without persisting a resource lane. */
export function workerLane(
 row: { repo: string; root?: number },
 maps: readonly LaneMap[],
): ImplementLane | null {
 const matches = maps.filter((m) => m.repo === row.repo && (row.root === undefined || m.root === row.root));
 const lanes = new Set(matches.map(implementLane));
 // An absent/ambiguous map cannot safely be assigned machine capacity.
 return lanes.size === 1 ? [...lanes][0] : null;
}

export function holdsImplementLane(row: { lane: string | null; status: string }): boolean {
 return row.lane === "implement" && (row.status === "claimed" || row.status === "running");
}

/**
 * Which frontier nodes one tick takes (design §3 class 8, the #23 ruling).
 * Pure, and free of any graph-write import, so the walk (`walk.ts`) and the
 * dashboard (`serve.ts`, #37) read the same selection rather than two copies.
 */
import type { ClassifiedNode } from "./route.ts";

/** Research-lane candidates: routed research AND walkable on this map's walk mode. */
export function researchCandidates(
 frontier: ClassifiedNode[],
): ClassifiedNode[] {
 return frontier.filter(
  (n) => n.route.route === "research" && n.route.walkable,
 );
}

/**
 * Implement-lane candidates (design §3 class 8 + the #23 ruling): routed
 * implement AND walkable. The global implement lane is serial, so the caller claims
 * at most one, and none while another implement worker holds that lane.
 */
export function implementCandidates(
 frontier: ClassifiedNode[],
): ClassifiedNode[] {
 return frontier.filter(
  (n) => n.route.route === "implement" && n.route.walkable,
 );
}

/**
 * The candidates one tick takes from a classified frontier: every walkable
 * research node, and at most one implement node while no implement worker
 * holds the implement lane. `planTick` below is the
 * one caller the walk and the dashboard share.
 */
export function selectCandidates(
 frontier: ClassifiedNode[],
 laneBusy: boolean,
): { research: ClassifiedNode[]; implement: ClassifiedNode[] } {
 return {
  research: researchCandidates(frontier),
  implement: laneBusy ? [] : implementCandidates(frontier).slice(0, 1),
 };
}

/** Every node ranger may take on its own: walkable implement or research, in frontier order. */
export function walkableCandidates(frontier: ClassifiedNode[]): ClassifiedNode[] {
 return frontier.filter(
  (n) =>
   (n.route.route === "implement" || n.route.route === "research") &&
   n.route.walkable,
 );
}

export interface TickPlan {
 /** What one tick tries, in order: the implement node first, then research. */
 selected: ClassifiedNode[];
 /** The implement node in `selected`, if any (walk records each claim's lane from it). */
 implement: ClassifiedNode[];
 /** The selected nodes the veto cache stops; the tick skips them, never reaching past one. */
 vetoed: ClassifiedNode[];
 /** `selected` less `vetoed`: what the tick claims, cap permitting. */
 take: ClassifiedNode[];
 /**
  * While another worker holds the implement lane: the implement node the
  * tick takes once it frees — the first walkable one, unless vetoed, in
  * which case none (the tick takes one and then drops a vetoed one).
  */
 waiting: ClassifiedNode | null;
}

/**
 * One tick's plan for a classified frontier — the candidate order and the
 * veto rule. `walk` iterates `selected` and skips `vetoed`; `ranger serve`
 * (#37) names `take[0]` or `waiting` as the next job. The map gates (walk
 * mode, dead-man pause, spawn cap) are checked by each caller before this.
 */
export function planTick(
 frontier: ClassifiedNode[],
 opts: { laneBusy: boolean; vetoed: (nodeId: string) => boolean },
): TickPlan {
 const { implement, research } = selectCandidates(frontier, opts.laneBusy);
 const selected = [...implement, ...research];
 // One veto read per node: in walk the predicate is a journal query.
 const vetoed = selected.filter((n) => opts.vetoed(n.id));
 const head = opts.laneBusy ? implementCandidates(frontier)[0] : undefined;
 return {
  selected,
  implement,
  vetoed,
  take: selected.filter((n) => !vetoed.includes(n)),
  waiting: head !== undefined && !opts.vetoed(head.id) ? head : null,
 };
}

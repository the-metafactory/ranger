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
 * implement AND walkable. The lane is serial — review concurrency is 1 per
 * machine (design §8) — so the caller claims at most one, and none while
 * another implement worker is in its build/review phases.
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
 * holds the lane (the lane is serial — design §8). `ranger serve` (#37)
 * reads its "next" from this same function, so the dashboard cannot name a
 * node the tick would not take.
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

import { GRAPH_CALL_TIMEOUT_MS } from "./graph.ts";

/**
 * The time bounds the dashboard's Build now button and `ranger build-now`
 * (node #58) share. A module of its own: serve imports no graph write, and
 * build-now.ts imports the walk.
 */

/** The dashboard's bound on one build-now run (serve.ts `runVerb`): SIGTERM, then SIGKILL. */
export const BUILD_NOW_TIMEOUT_MS = 300_000;

/**
 * How long after the dashboard spawned the verb it may still start its
 * announce or graph claim (`claimNode`'s `claimBy`, passed as --claim-by).
 * The claim is bounded (GRAPH_CALL_TIMEOUT_MS) and only local writes and a
 * detached spawn follow it, so a claim started by then ends about
 * GRAPH_CALL_TIMEOUT_MS before the dashboard's kill (less the moments
 * between the deadline's reading and runVerb's timer), however long the
 * token wrapper, the login, lock and frontier reads before it took: the kill
 * never lands between a graph claim and its journal row. Run from the CLI,
 * the verb counts it from its own process start.
 */
export const BUILD_NOW_CLAIM_START_BY_MS = BUILD_NOW_TIMEOUT_MS - 2 * GRAPH_CALL_TIMEOUT_MS;

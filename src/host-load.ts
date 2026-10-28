import { availableParallelism, loadavg } from "node:os";
import type { ImplementLane } from "./lanes.ts";

/** The host's 1-minute load and its core count. */
export interface HostLoadReading {
 load: number;
 cores: number;
}

export type HostLoad = () => HostLoadReading;

/**
 * A busy reading a park carries: `killed` when the retry was killed with no
 * failing test, not failed; `startedAt` when the retry started on a quiet
 * host, failed, and the host read busy as it ended (node #430), the load it started at.
 */
export type BusyReading = HostLoadReading & { killed?: boolean; startedAt?: HostLoadReading };

/**
 * The host's real load, except under test (RANGER_UNDER_TEST=1, node #66),
 * where it reads quiet: a test that wants load injects its own reader, and no
 * test's outcome may depend on what else the machine running it is doing.
 */
export const realHostLoad: HostLoad = () =>
 process.env.RANGER_UNDER_TEST === "1" ? { load: 0, cores: 1 } : { load: loadavg()[0], cores: availableParallelism() };

/**
 * The busy load a gate reads for the implement lane it gates (node #312):
 * `workers.laneBusyLoad[lane]`, else `workers.busyLoad`; undefined leaves
 * `busyAt` at the core count. The gate reads CPU load, so a lane's value is
 * the load its own suites are known to pass at: with one threshold, the
 * headless queue waited six hours on load the visual lane's probes made
 * (2026-10-15), while a soma supervisor run passed in 15 min at load 20-24.
 */
export const busyLoadFor = (
 workers: { busyLoad?: number; laneBusyLoad?: Partial<Record<ImplementLane, number>> } | undefined,
 lane: ImplementLane,
): number | undefined => workers?.laneBusyLoad?.[lane] ?? workers?.busyLoad;

/** The 1-minute load at which the host counts as busy: `busyLoadFor` the lane, else the core count. */
export const busyAt = (host: { cores: number }, busyLoad?: number): number => busyLoad ?? host.cores;

/**
 * The one definition of a quiet host: the 1-minute load below `busyAt`. Every
 * gate that admits or retries work reads it (2026-10-14: 72 full soma suites
 * in a day at load 45-55 on 10 cores ran past the 20-minute test timeout and
 * parked soma #802 and #853 with no failing test).
 */
export const isQuiet = (host: HostLoadReading, busyLoad?: number) => host.load < busyAt(host, busyLoad);

/** A reading as every wait reason gives it: "load X on N cores", and ", busy at B" when `busyLoad` is set. */
export const describeLoad = (host: HostLoadReading, busyLoad?: number) =>
 `load ${host.load.toFixed(1)} on ${host.cores} cores${busyLoad === undefined ? "" : `, busy at ${busyLoad}`}`;

/** Why the host is too busy to start more work, or null when it is quiet. */
export function hostBusy(read: HostLoad = realHostLoad, busyLoad?: number): string | null {
 const host = read();
 return isQuiet(host, busyLoad) ? null : `the host is busy (${describeLoad(host, busyLoad)})`;
}

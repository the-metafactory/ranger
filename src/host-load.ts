import { availableParallelism, loadavg } from "node:os";

/** The host's 1-minute load and its core count. */
export interface HostLoadReading {
 load: number;
 cores: number;
}

export type HostLoad = () => HostLoadReading;

/**
 * The host's real load, except under test (RANGER_UNDER_TEST=1, node #66),
 * where it reads quiet: a test that wants load injects its own reader, and no
 * test's outcome may depend on what else the machine running it is doing.
 */
export const realHostLoad: HostLoad = () =>
 process.env.RANGER_UNDER_TEST === "1" ? { load: 0, cores: 1 } : { load: loadavg()[0], cores: availableParallelism() };

/** The 1-minute load at which the host counts as busy: `workers.busyLoad`, else the core count. */
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

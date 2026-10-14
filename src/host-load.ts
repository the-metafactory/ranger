import { availableParallelism, loadavg } from "node:os";

/** The host's 1-minute load and its core count; a quiet host has load below the cores. */
export interface HostLoadReading {
 load: number;
 cores: number;
}

export type HostLoad = () => HostLoadReading;

export const realHostLoad: HostLoad = () => ({ load: loadavg()[0], cores: availableParallelism() });

/** The one definition of a quiet host (`awaitQuietHost`): the 1-minute load below the core count. */
export const isQuiet = (host: HostLoadReading) => host.load < host.cores;

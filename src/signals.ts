/** A failure that parks a node instead of counting toward the dead-man. */
export class ParkSignal extends Error {
 override readonly name = "ParkSignal";
}

/**
 * The supervisor's tests failed, and their one busy-host retry ran on a busy
 * host too and failed (node #297): the host's failure, not the branch's. The
 * run ends without a worker session, its row `failed` with this message, and
 * a resume is queued that starts once the host is quiet. A ParkSignal, so
 * every path that lets a park through lets this through as well.
 */
export class HostLoadPark extends ParkSignal {
 constructor(message: string, readonly host: { load: number; cores: number }) {
  super(message);
 }
}

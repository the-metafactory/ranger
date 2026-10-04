/** A failure that parks a node instead of counting toward the dead-man. */
export class ParkSignal extends Error {
 override readonly name = "ParkSignal";
}

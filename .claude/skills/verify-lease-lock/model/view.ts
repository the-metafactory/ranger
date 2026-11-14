type Rec = Record<string, unknown>;
type Vars = { pc: Rec; lock: Rec; marker: Rec; dead: unknown[]; lapsed: Rec };

const phase: Record<string, string> = {
  try: "trying to create the lock",
  tryWrite: "created the lock, writing it",
  chkLock: "lock exists, reading its lease",
  mkMarker: "taking the reclaim marker",
  mkMarkerWrite: "created the marker, writing it",
  chkMarker: "marker exists, reading it",
  rmMarker: "removing a stale marker",
  revalidate: "re-reading the lock under the marker",
  rmLock: "about to unlink the stale lock",
  mkLock: "re-creating the lock",
  mkLockWrite: "re-created the lock, writing it",
  dropMarkerAcq: "acquired, dropping the marker",
  dropMarkerBusy: "backing off, dropping the marker",
  dropMarkerErr: "EEXIST on re-create, dropping the marker",
  holding: "HOLDS the lock",
  hbWrite: "HOLDS, renewing the lease",
  relRead: "releasing: reading the lock",
  relRm: "releasing: unlinking the lock",
  done: "released",
  failed: "acquire threw",
};

function file(f: Rec, what: string): string {
  if (f.ex !== true) return `no ${what}`;
  if (f.own === "None") return `${what} empty (being written)`;
  const age = what === "lock" ? (f.fresh === true ? "lease valid" : "lease expired") : f.old === true ? "old" : "fresh";
  return `${what} of ${String(f.own)}, ${age}`;
}

function who(v: Vars, p: string): string {
  if (v.dead.includes(p)) return "crashed";
  const words = phase[String(v.pc[p])] ?? String(v.pc[p]);
  return v.lapsed[p] === true ? `${words} (stalled past its lease)` : words;
}

export const title = "src/lock.ts lease lock: contending processes, one lock file";

export const state = (v: Vars) => ({
  ...Object.fromEntries(Object.keys(v.pc).sort().map((p) => [p, who(v, p)])),
  Files: `${file(v.lock, "lock")}; ${file(v.marker, "marker")}`,
});

export const step = (action: string, from: Vars, to: Vars): string => {
  if (action === "LeaseExpires") return `the lock's lease expires [its owner stalled or died]`;
  if (action === "MarkerAges") return "the marker grows older than 60 s";
  const p = Object.keys(to.pc).find((k) => to.pc[k] !== from.pc[k] || to.dead.includes(k) !== from.dead.includes(k)) ?? "?";
  return `${p}: ${action}`;
};

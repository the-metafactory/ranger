import { withClaimLock } from "./claim-lock.ts";
import type { Journal } from "./journal.ts";

export type DrainTarget = { scope: "lane"; lane: "visual" } | { scope: "map"; key: string };

export async function changeDrain(journal: Journal, target: DrainTarget, drained: boolean) {
 return withClaimLock(journal, (owned) => {
  owned();
  const was = target.scope === "lane" ? journal.isVisualLaneDrained() : journal.isMapDrained(target.key);
  if (target.scope === "lane") journal.setVisualLaneDrained(drained);
  else journal.setMapDrained(target.key, drained);
  const what = target.scope === "lane" ? "visual lane" : target.key;
  journal.recordEvent("drain", { detail: `${what} ${drained ? "drained" : "drain lifted"} by operator (was ${was ? "drained" : "open"})` });
  return Promise.resolve({ ...target, drained, was });
 });
}

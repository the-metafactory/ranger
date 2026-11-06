import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { Journal } from "../src/journal.ts";
import { escalateMaps, LAST_ESCALATE_MAP } from "../src/escalate.ts";
import { mapKey, mapOrder } from "../src/maps.ts";

for (const [m, n] of [[29, 16], [6, 2], [5, 1], [4, 4]]) test(`${m} maps receive service within ceil(M/N) passes at budget ${n}`, async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-fairness-"));
 const file = join(dir, "ranger.yaml");
 const path = join(dir, "journal.sqlite");
 writeFileSync(file, stringify({ maps: Array.from({ length: m }, (_, i) => ({ repo: `acme/map-${i}`, root: 1 })), state: { journalPath: path } }));
 const config = loadConfig(file).config;
 let journal = new Journal(path);
 const served: string[] = [];
 try {
  for (let pass = 0; pass < Math.ceil(m / n); pass++) {
   let clock = 0;
   const result = await escalateMaps(config, journal, { clock: () => clock, passMs: n, step: async map => {
    served.push(mapKey(map)); clock++;
    return { repo: map.repo, kind: "cards", ok: true, posted: [], edited: [], deferred: [], keptOpen: [], closed: [], cardErrors: [], cards: [] };
   } });
   expect(result.maps.map(map => map.repo)).toEqual(config.maps.map(map => map.repo));
   expect(result.maps.filter(map => map.budgetDeferred !== undefined)).toHaveLength(m - n);
   expect(mapOrder(config.maps, journal.getHealth(LAST_ESCALATE_MAP))[0]).toEqual(config.maps[served.length % m]);
   journal.close(); journal = new Journal(path);
  }
  expect(new Set(served).size).toBe(m);
  expect(mapOrder(config.maps, "removed#1")).toEqual(config.maps);
 } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the real pre-map deadline gate never advances past an unserved map", async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-fairness-boundary-"));
 const file = join(dir, "ranger.yaml");
 writeFileSync(file, stringify({ maps: [{ repo: "acme/first", root: 1 }, { repo: "acme/next", root: 1 }], state: { journalPath: join(dir, "journal.sqlite") } }));
 const config = loadConfig(file).config;
 const journal = new Journal(config.state.journalPath);
 let reads = 0;
 try {
  const result = await escalateMaps(config, journal, { clock: () => reads++ < 2 ? 0 : 1, passMs: 1 });
  expect(result.maps.every(map => map.budgetDeferred !== undefined && map.ok)).toBe(true);
  expect(journal.getHealth(LAST_ESCALATE_MAP)).toBeNull();
  const served: string[] = [];
  await escalateMaps(config, journal, { clock: () => 0, step: async map => {
   served.push(mapKey(map));
   return { repo: map.repo, kind: "cards", ok: true, posted: [], edited: [], deferred: [], keptOpen: [], closed: [], cardErrors: [], cards: [] };
  } });
  expect(served[0]).toBe("acme/first#1");
 } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

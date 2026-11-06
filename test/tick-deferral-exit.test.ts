import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { runTick } from "../src/cli.ts";
import type { WalkResult } from "../src/walk.ts";

for (const failed of [false, true]) test(`tick distinguishes escalation deferrals from failures (failed=${failed})`, async () => {
 const dir = mkdtempSync(join(tmpdir(), "ranger-deferred-"));
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, stringify({ maps: [{ repo: "acme/widgets", root: 1 }], state: { journalPath: join(dir, "journal.sqlite") }, bus: { principal: "jc" } }));
 const payloads: unknown[] = [];
 try {
  const result = await runTick(path, {
   escalateMaps: async () => ({ generatedAt: new Date().toISOString(), maps: [{ repo: "acme/widgets", kind: "cards", ok: !failed,
    ...(failed ? { error: "actual forge failure" } : { budgetDeferred: "pass deadline reached before this map" }), posted: [], edited: [], deferred: [], keptOpen: [], closed: [], cardErrors: [], cards: [] }] }),
   walk: async () => ({ maps: [], intake: { threads: [] } } as unknown as WalkResult),
   ledger: { env: {}, publisher: async event => { payloads.push(event.input.payload); } },
  });
  expect(result.exitCode).toBe(failed ? 2 : 0);
  expect(JSON.parse(result.report).escalate.maps[0].budgetDeferred).toBe(failed ? undefined : "pass deadline reached before this map");
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ outcome: failed ? "failed" : "succeeded", state: { subject: "ranger:escalation", value: JSON.stringify({ deferred: failed ? 0 : 1, failed: failed ? 1 : 0 }) } });
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRunFinishedEvent } from "@the-metafactory/myelin";
import { loadConfig } from "../src/config.ts";
import { emitJobRunFinished, emitNodeRunFinished, emitTickRunFinished } from "../src/run-ledger.ts";

const dirs: string[] = [];
const STARTED = "2026-10-22T10:00:00.000Z";
const ENDED = "2026-10-22T10:00:01.000Z";

afterEach(() => {
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(stack: string) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-run-ledger-source-"));
 dirs.push(dir);
 const path = join(dir, "ranger.yaml");
 writeFileSync(path, `maps:\n  - repo: acme/widgets\n    root: 1\nstate:\n  journalPath: ${join(dir, "state.sqlite")}\nbus:\n  principal: jc\n  stack: ${stack}\n`);
 return loadConfig(path, {}).config;
}

describe("run ledger source grammar", () => {
 for (const stack of ["default", "work"]) {
  test(`tick, card, node and job sources identify stack ${stack}`, async () => {
   const config = fixture(stack);
   const journal = { path: config.state.journalPath, recordEvent: mock(() => {}) };
   const events: ExecutionRunFinishedEvent[] = [];
   const deps = { env: {}, publisher: async (event: ExecutionRunFinishedEvent) => { events.push(event); } };
   await emitTickRunFinished(config, journal, {
    startedAt: STARTED, endedAt: ENDED, exitCode: 0,
    escalation: { generatedAt: ENDED, maps: [{
     repo: "acme/widgets", kind: "cards", ok: true,
     posted: [], edited: [], deferred: [], keptOpen: [], closed: ["10"], cardErrors: [], cards: [],
    }] },
   }, deps);
   await emitNodeRunFinished(config, journal, {
    repo: "acme/widgets", nodeId: "11", generation: 1,
    startedAt: STARTED, endedAt: ENDED, outcome: "succeeded",
   }, deps);
   await emitJobRunFinished(config, journal, {
    runUuid: "11111111-1111-4111-8111-111111111111", name: "scheduled-job",
    startedAt: STARTED, endedAt: ENDED, outcome: "succeeded",
   }, deps);

   expect(journal.recordEvent).not.toHaveBeenCalled();
   expect(events.map(event => event.input.payload.ran.ref)).toEqual([
    "ranger:tick", "acme/widgets#10", "acme/widgets#11", "scheduled-job",
   ]);
   for (const event of events) {
    expect(event.input.source).toBe(`jc.${stack}.ranger`);
    expect(event.subject).toBe(`local.jc.${stack}.execution.run.finished`);
    expect(event.input.source.split(".")[1]).toBe(event.subject.split(".")[2]);
   }
  });
 }
});

// Run by journal-guard.test.ts as `NODE_ENV=production bun test <this file>`
// (node #66): the preload's marker keeps test mode on whatever NODE_ENV says.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expandHome, loadConfig } from "../../../src/config.ts";
import { assertNotLiveJournalUnderTest, liveJournalDir, underTest } from "../../../src/journal-guard.ts";

test("test mode holds under NODE_ENV=production", () => {
 expect(process.env.NODE_ENV).toBe("production");
 expect(underTest()).toBe(true);
 const path = join(mkdtempSync(join(tmpdir(), "ranger-probe-")), "ranger.yaml");
 writeFileSync(path, ["version: 1", "maps:", "  - repo: acme/widgets", "    root: 1"].join("\n"));
 const journal = resolve(expandHome(loadConfig(path).config.state.journalPath));
 expect(journal.startsWith(resolve(liveJournalDir()) + sep)).toBe(false);
 expect(() => assertNotLiveJournalUnderTest(join(liveJournalDir(), "state.sqlite"))).toThrow("under test");
});

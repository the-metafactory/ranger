import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 BLOCKED_REPORT_FILE,
 blockerNoteOnly,
 discardBlockedReport,
 parseBlockedReport,
 readBlockedReport,
} from "../src/blocked-report.ts";
import { assembleImplementPrompt } from "../src/prompt.ts";

const dirs: string[] = [];
afterEach(() => {
 for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
 const d = mkdtempSync(join(tmpdir(), "ranger-blocked-"));
 dirs.push(d);
 return d;
}

describe("parseBlockedReport", () => {
 test("a Resume condition line splits the reason from the condition", () => {
  expect(parseBlockedReport("# Blocked\n\nNo SDK release exports feature().\n\nResume condition: publish one.\n")).toEqual({
   reason: "Blocked No SDK release exports feature().",
   resume: "publish one.",
  });
 });

 test("a Resume condition heading takes the lines up to the next heading", () => {
  const note = "# Node #2557 dependency blocker\n\nStopped.\n\n## Resume condition\n\nPublish a Myelin release\nwith A5b.\n\n## Evidence\n\nls-remote.\n";
  expect(parseBlockedReport(note)).toEqual({ reason: "Node #2557 dependency blocker Stopped.", resume: "Publish a Myelin release with A5b." });
 });

 test("bold labels and dashes are read; no condition leaves it empty", () => {
  expect(parseBlockedReport("Waiting.\n**Resume-condition:** a token.").resume).toBe("a token.");
  expect(parseBlockedReport("Waiting on the SDK.")).toEqual({ reason: "Waiting on the SDK.", resume: "" });
 });

 test("each part is folded to one line and capped", () => {
  const r = parseBlockedReport(`${"x ".repeat(400)}\nResume condition: y`);
  expect(r.reason.length).toBe(300);
  expect(r.reason.endsWith("…")).toBe(true);
  expect(r.reason).not.toContain("\n");
 });
});

describe("readBlockedReport", () => {
 test("reads the report at the worktree root, and discard removes it", () => {
  const d = scratch();
  expect(readBlockedReport(d)).toBeNull();
  writeFileSync(join(d, BLOCKED_REPORT_FILE), "Resume condition: later.\n");
  expect(readBlockedReport(d)).toEqual({ reason: "the worker gave no reason", resume: "later." });
  discardBlockedReport(d);
  expect(existsSync(join(d, BLOCKED_REPORT_FILE))).toBe(false);
 });

 test("a link is no report: worker-written text never pulls in a file outside the worktree", () => {
  const d = scratch();
  const secret = join(scratch(), "secret");
  writeFileSync(secret, "token=abc\n");
  symlinkSync(secret, join(d, BLOCKED_REPORT_FILE));
  expect(readBlockedReport(d)).toBeNull();
 });
});

describe("blockerNoteOnly", () => {
 test("only added markdown files named like a blocker note, or the report, count", () => {
  expect(blockerNoteOnly([{ status: "A", path: "docs/node-2557-dependency-blocker.md" }])).toEqual(["docs/node-2557-dependency-blocker.md"]);
  expect(blockerNoteOnly([{ status: "A", path: "BLOCKED.md" }, { status: "A", path: BLOCKED_REPORT_FILE }])).toEqual(["BLOCKED.md", BLOCKED_REPORT_FILE]);
 });

 test("any other change is work", () => {
  expect(blockerNoteOnly([])).toBeNull();
  expect(blockerNoteOnly([{ status: "M", path: "docs/blocker.md" }])).toBeNull();
  expect(blockerNoteOnly([{ status: "A", path: "docs/node-1-blocker.md" }, { status: "A", path: "src/x.ts" }])).toBeNull();
  expect(blockerNoteOnly([{ status: "A", path: "docs/design.md" }])).toBeNull();
  expect(blockerNoteOnly([{ status: "A", path: "src/blocker.ts" }])).toBeNull();
 });
});

test("the implement prompt tells the worker to report a block, never to commit a note about it", () => {
 const prompt = assembleImplementPrompt({
  repo: "acme/widgets",
  node: { id: "20", title: "t", body: "b", kind: "build", autonomy: "auto", url: "u" },
  map: { title: "m", body: "" },
  branch: "node/20-x",
  worktree: "/w",
  botIdentity: "bot",
  testCommand: "bun test",
 });
 expect(prompt).toContain(`Write \`${BLOCKED_REPORT_FILE}\` at the worktree root, leave it\n  uncommitted, and exit 0.`);
 expect(prompt).toContain("do NOT commit a note, a stub or a partial");
 expect(prompt).toContain("Resume condition: <what must hold before the node can be built>");
});

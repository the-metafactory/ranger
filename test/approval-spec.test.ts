import { expect, test } from "bun:test";
import { approvalVersion, stripApprovalMarker } from "../src/approval-spec.ts";

const node = { title: "Build this", kind: "build", autonomy: "propose" };
const marker = `<!-- ranger:approved by=alice at=2026-10-25T12:00:00Z version=${"a".repeat(64)} -->`;

test("version ignores a trailing approval marker but preserves intake and mid-body markers", () => {
 const body = "Build this.\n";
 expect(approvalVersion(node, `${body}${marker}`)).toBe(approvalVersion(node, body));
 expect(approvalVersion(node, `${body}${marker}\r\n\r\n`)).toBe(approvalVersion(node, body));
 expect(approvalVersion(node, `${body}${marker}\nMore.`)).not.toBe(approvalVersion(node, `${body}More.`));
 expect(approvalVersion(node, `${body}<!-- ranger:intake discord=123 -->`)).not.toBe(approvalVersion(node, body));
 expect(stripApprovalMarker(`${body}${marker}`)).toBe("Build this.");
 expect(stripApprovalMarker(`${body}${marker}\nMore.`)).toBe(`${body}${marker}\nMore.`);
 expect(stripApprovalMarker(`${body}<!-- ranger:approved broken -->`)).toBe("Build this.");
});

test("marker stripping preserves a marker followed by non-whitespace, including after long whitespace runs", () => {
 for (const whitespace of [" ", "\t", " \t".repeat(50_000)]) {
  const trailing = `Build this.\n${marker}${whitespace}`;
  expect(stripApprovalMarker(trailing)).toBe("Build this.");
  const followed = `${trailing}More.`;
  expect(stripApprovalMarker(followed)).toBe(followed);
  expect(approvalVersion(node, followed)).not.toBe(approvalVersion(node, "Build this."));
 }
});

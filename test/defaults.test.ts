import { describe, expect, test } from "bun:test";
import { defaultsFromBody, defaultsFromMessages, defaultsSection } from "../src/defaults.ts";

describe("defaults taken by a worker", () => {
 test("Default: lines in commit messages are read once each, in order", () => {
  const log = "Build the card\n\nDefault: sort by date, because the prototype does\n- Default: 20 rows, because one screen\n\nFix\n\nDefault: sort by date, because the prototype does\nNot a Default: line\n";
  expect(defaultsFromMessages(log)).toEqual(["sort by date, because the prototype does", "20 rows, because one screen"]);
  expect(defaultsFromMessages("no defaults here")).toEqual([]);
 });

 test("the PR body section round-trips into the receipt, and an empty list adds nothing", () => {
  const defaults = ["sort by `date`", "20 rows"];
  const body = ["Implements node 1", ...defaultsSection(defaults), "", "## Other", "- not a default"].join("\n");
  expect(defaultsFromBody(body)).toEqual(["sort by 'date'", "20 rows"]);
  expect(defaultsSection([])).toEqual([]);
  expect(defaultsFromBody("Implements node 1\n- a list item")).toEqual([]);
 });
});

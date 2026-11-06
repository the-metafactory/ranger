import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

const OWNER_FUNCTIONS = [
 "prepareWorktree",
 "syncWorktreeToHead",
 "reconcileRecordedRebase",
 "catchUpWithBase",
 "mergeBaseBeforeTests",
 "mergeBaseAfterRedTests",
 "machineMergeBase",
 "machineMerge",
 "baseMergePass",
];

const WORKTREE_PRIMITIVES = [
 /\bsyncWorktreeToHead\(/,
 /\bcatchUpWithBase\(/,
 /\bmergeBaseBeforeTests\(/,
 /\bmergeBaseAfterRedTests\(/,
 /\bmachineMergeBase\(/,
 /\bmachineMerge\(/,
 /\bbaseMergePass\(/,
 /"--ff-only"/,
 /\[\s*(?:(?:\.\.\.\w+|"-[^"]*"),\s*)*"merge"\s*,/,
];

const CANONICAL_BASE_FAST_FORWARD = '["merge", "--ff-only", `origin/${base}`]';
const SAVED_CHECKPOINT_RECOVERY = '["merge", "--ff-only", target]';

const ALLOWED_CALLS: Record<string, string[]> = {
 "git-ops.ts": [CANONICAL_BASE_FAST_FORWARD],
 "node-progress.ts": [SAVED_CHECKPOINT_RECOVERY],
};

function withoutFunction(source: string, name: string): string {
 const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\b[^\\n]*$`, "gm");
 return source.replace(new RegExp(`${start.source}[\\s\\S]*?^\\}$`, "gm"), "");
}

function violations(file: string, source: string): string[] {
 const owned = file === "implement.ts" ? OWNER_FUNCTIONS.reduce(withoutFunction, source) : source;
 const rest = (ALLOWED_CALLS[file] ?? []).reduce((text, call) => text.replace(call, ""), owned);
 return WORKTREE_PRIMITIVES.filter((primitive) => primitive.test(rest)).map((primitive) => `${file}: ${primitive.source}`);
}

describe("prepareWorktree owns every move of a node worktree to a head or the base (ranger issue #322)", () => {
 test("no source outside the owner calls a fast-forward or base-merge primitive", () => {
  const found = readdirSync(SRC)
   .filter((file) => file.endsWith(".ts"))
   .flatMap((file) => violations(file, readFileSync(join(SRC, file), "utf8")));
  expect(found).toEqual([]);
 });

 test("the guard fails on a caller outside the owner", () => {
  const owner = "async function machineMerge(ctx) {\n return git([\"merge\"]);\n}\n";
  expect(violations("implement.ts", owner)).toEqual([]);
  expect(violations("implement.ts", `${owner}async function rogue(ctx) {\n await machineMerge(ctx);\n}\n`)).toEqual(["implement.ts: \\bmachineMerge\\("]);
  expect(violations("worker.ts", `await safeGit(["reset", "--ff-only"]);\n`)).toEqual([`worker.ts: "--ff-only"`]);
  expect(violations("worker.ts", `await safeGit(["merge", "origin/main"]);\n`)).toHaveLength(1);
  expect(violations("worker.ts", `await safeGit(["--no-replace-objects", "merge", ref]);\n`)).toHaveLength(1);
  expect(violations("worker.ts", `await run(["gh", "pr", "merge", "1"]);\n`)).toEqual([]);
  expect(violations("node-progress.ts", `["merge", "--ff-only", target]\nawait safeGit(["merge", "origin/main"]);\n`)).toHaveLength(1);
  expect(violations("node-progress.ts", `["merge", "--ff-only", target]\n`)).toEqual([]);
 });

 test("the guard names every owner function that still exists", () => {
  const source = readFileSync(join(SRC, "implement.ts"), "utf8");
  for (const name of OWNER_FUNCTIONS) expect(source).toMatch(new RegExp(`^(?:async )?function ${name}\\b`, "m"));
 });
});

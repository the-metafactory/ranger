import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { runCli } from "./support.ts";

test("ranger --version prints the version in package.json", async () => {
 const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ranger-cli-version-")));
 const result = await runCli(["--version"], process.env, cwd);
 expect(result.code).toBe(0);
 expect(result.stdout.trim()).toBe(pkg.version);
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createReviewedProfile, validateReviewedManifest } from "../src/remote-test/profiles.ts";
import { RANGER_OPT_IN_TEST_FILES, RANGER_REPOSITORY } from "../src/remote-test/recipes.ts";
import { digest } from "./fixtures/remote-test-recipe-inputs.ts";

const input = {
 profileId: "ranger-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { repositoryId: RANGER_REPOSITORY, recipe: "ranger-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "typecheck", "lint"], sidecars: [] },
};

test("ranger-v1 runs the map's test, typecheck and lint offline without a sidecar", () => {
 const profile = createReviewedProfile(input);
 expect(validateReviewedManifest(profile)).toEqual(profile);
 const [install, unit, typecheck, lint] = profile.commands;
 expect(install).toContain("--offline");
 expect(unit.slice(0, 4)).toEqual(["bun", "--config=/dev/null", "--no-env-file", "test"]);
 expect(unit).toContain("--preload=./test/preload.ts");
 expect(typecheck.slice(-2)).toEqual(["./node_modules/typescript/bin/tsc", "--noEmit"]);
 expect(lint.slice(-2)).toEqual(["./node_modules/eslint/bin/eslint.js", "."]);
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, checks: ["unit", "integration", "typecheck", "lint"] } })).toThrow();
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, checks: ["unit", "typecheck"] } })).toThrow();
});

test("the test command mirrors package.json and excludes only the named opt-in files", () => {
 const [unit] = createReviewedProfile(input).commands.slice(1);
 const script = JSON.parse(readFileSync("package.json", "utf8")).scripts.test as string;
 for (const flag of ["--timeout=60000"]) expect(script).toContain(flag);
 expect(readFileSync("bunfig.toml", "utf8")).toContain('preload = ["./test/preload.ts"]');
 expect(readFileSync("bunfig.toml", "utf8")).toContain("randomize = true");
 const ignored = unit.flatMap((arg, i) => (unit[i - 1] === "--path-ignore-patterns" ? [arg] : []));
 expect(ignored).toEqual([...RANGER_OPT_IN_TEST_FILES]);
 for (const file of ignored) expect(readFileSync(file, "utf8")).toMatch(/\.skip\b|skipIf\(/);
});

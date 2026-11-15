import { expect, test } from "bun:test";
import { containerProgram, recipePackageRefusal, unresolvedTestRoot } from "../src/remote-test/executor.ts";
import { createReviewedProfile, validateReviewedManifest } from "../src/remote-test/profiles.ts";
import {
 CORTEX_CHECKS, CORTEX_EXCLUDED_TESTS, CORTEX_GATES, CORTEX_REPOSITORY, CORTEX_SKIPPED_TEST_NAME, CORTEX_TEST_NAME_PATTERN,
 CORTEX_TEST_STEPS, ISOLATED_BUN, MYELIN_REPOSITORY, RANGER_REPOSITORY, REVIEWED_RECIPES,
} from "../src/remote-test/recipes.ts";
import { digest } from "./fixtures/remote-test-recipe-inputs.ts";

const input = {
 profileId: "cortex-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { repositoryId: CORTEX_REPOSITORY, recipe: "cortex-v1", cache: "disabled", install: "frozen-offline-copy", checks: [...CORTEX_CHECKS], sidecars: [] },
};

test("cortex-v1 runs every non-localOnly check.ts gate offline without a sidecar", () => {
 const profile = createReviewedProfile(input);
 expect(validateReviewedManifest(profile)).toEqual(profile);
 expect(profile.commands).toHaveLength(CORTEX_CHECKS.length + 1);
 expect(profile.commands[0]).toContain("--offline");
 expect(CORTEX_GATES).toEqual(["lint", "duplication", "unused-exports", "typecheck", "vocab", "sdk", "shippable", "xdg"]);
 for (const gate of CORTEX_GATES) {
  const command = REVIEWED_RECIPES[CORTEX_REPOSITORY]["cortex-v1"].checks[gate];
  expect(command.slice(-2)).toEqual(["scripts/check.ts", gate]);
 }
 expect(profile.reviewed.sidecars).toEqual([]);
 expect(REVIEWED_RECIPES[CORTEX_REPOSITORY]["cortex-v1"].needsNats).toBe(false);
});

test("every cortex check launches Bun with the checkout's own config disabled", () => {
 const checks = REVIEWED_RECIPES[CORTEX_REPOSITORY]["cortex-v1"].checks;
 expect(Object.keys(checks)).toEqual([...CORTEX_CHECKS]);
 for (const argv of Object.values(checks)) expect(argv.slice(argv.indexOf("bun"), argv.indexOf("bun") + 3)).toEqual([...ISOLATED_BUN]);
 for (const recipe of [REVIEWED_RECIPES[MYELIN_REPOSITORY]["myelin-v1"], REVIEWED_RECIPES[RANGER_REPOSITORY]["ranger-v1"]])
  for (const argv of Object.values(recipe.checks)) expect(argv.slice(argv.indexOf("bun"), argv.indexOf("bun") + 3)).toEqual([...ISOLATED_BUN]);
});

test("the test step disables the checkout's bunfig in the suite process and loads cortex's preload itself", () => {
 const checks = REVIEWED_RECIPES[CORTEX_REPOSITORY]["cortex-v1"].checks;
 const [test] = createReviewedProfile(input).commands.filter(command => command.includes("run"));
 expect(test.slice(0, 6)).toEqual([...ISOLATED_BUN, "run", "test", "--config=/dev/null"]);
 expect(test).toContain("--preload=./scripts/test-preload.ts");
 for (const step of CORTEX_TEST_STEPS.slice(0, -1)) expect(checks[step].slice(0, 3)).toEqual([...ISOLATED_BUN]);
});

test("the base-ref ratchets read the submitted commit's parent through their own override", () => {
 const checks = REVIEWED_RECIPES[CORTEX_REPOSITORY]["cortex-v1"].checks;
 expect(checks.lint.slice(0, 2)).toEqual(["env", "LINT_BASE_REF=HEAD^"]);
 expect(checks.sdk.slice(0, 3)).toEqual(["env", "RELEASE_PINS_BASE_REF=HEAD^", "DESK_SDK_BASE_REF=HEAD^"]);
 expect(checks["up-to-date"]).toBeUndefined();
});

test("the test step mirrors scripts/check.ts and names every exclusion", () => {
 const [test] = createReviewedProfile(input).commands.filter(command => command.includes("run"));
 expect(test.slice(3, 6)).toEqual(["run", "test", "--config=/dev/null"]);
 expect(test).toContain("--parallel=2");
 const ignored = test.flatMap((arg, index) => (test[index - 1] === "--path-ignore-patterns" ? [arg] : []));
 expect(ignored).toEqual(CORTEX_EXCLUDED_TESTS.map(({ file }) => file));
 const pattern = test.find(arg => arg.startsWith("--test-name-pattern="))!;
 expect(pattern).toBe(`--test-name-pattern=${CORTEX_TEST_NAME_PATTERN}`);
 expect(CORTEX_TEST_NAME_PATTERN).toBe(`^(?!.*${CORTEX_SKIPPED_TEST_NAME})`);
 for (const { file, reason } of CORTEX_EXCLUDED_TESTS) {
  expect(file).toMatch(/^[a-z][\w./-]*\.test\.ts$/);
  expect(reason.length).toBeGreaterThan(10);
 }
});

test("a recipe refuses check names it does not declare", () => {
 const checks = [...CORTEX_CHECKS];
 for (const changed of [checks.slice(0, -1), [...checks, "webgl"], checks.map(name => name === "test" ? "unit" : name)]) {
  expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, checks: changed } })).toThrow();
 }
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, sidecars: [{ kind: "nats", imageReference: `localhost/nats@${digest}` }] } })).toThrow();
});

test("the recipe pins cortex's package identity, scripts and test roots", () => {
 const recipe = REVIEWED_RECIPES[CORTEX_REPOSITORY]["cortex-v1"];
 expect(recipe.packageName).toBe("@the-metafactory/cortex");
 expect(Object.keys(recipe.scripts).sort()).toEqual(["desk:dts:check", "lint:errors", "sdk:dts:check", "test"]);
 const pkg = { name: recipe.packageName, scripts: recipe.scripts };
 expect(recipePackageRefusal(pkg, recipe)).toBe(false);
 expect(recipePackageRefusal({ ...pkg, name: "@the-metafactory/myelin" }, recipe)).toBe(true);
 expect(recipePackageRefusal({ ...pkg, scripts: { ...recipe.scripts, test: "bun test" } }, recipe)).toBe(true);
 for (const root of ["src/surface/mc/__tests__/server.test.ts", "scripts/__tests__/check-desk-probes.test.ts", "eslint/__tests__/no-comments-rule.test.ts"])
  expect(unresolvedTestRoot(root, recipe)).toBe(false);
 expect(unresolvedTestRoot("test/new.test.ts", recipe)).toBe(true);
});

test("a reviewed profile without a sidecar does not wait for a job-private NATS", () => {
 const profile = createReviewedProfile(input);
 const program = containerProgram(profile.commands, profile.reviewed, profile.lockDigest);
 expect(program).not.toContain("Job-private NATS not ready");
 expect(program).toContain('Bun.version !== "1.3.14"');
 expect(program).toContain("Image dependencies do not match lock");
});

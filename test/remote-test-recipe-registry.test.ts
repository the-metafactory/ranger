import { expect, test } from "bun:test";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";
import { validateProfileManifest, validateRemoteTestJob } from "../src/remote-test/contract.ts";
import { createReviewedProfile, MYELIN_REPOSITORY, validateReviewedManifest } from "../src/remote-test/profiles.ts";
import { jobFor, myelinInput } from "./fixtures/remote-test-recipe-inputs.ts";

test("myelin-v1 keeps its original byte-identical commands and profile digest", () => {
 const profile = createReviewedProfile(myelinInput);
 expect(JSON.stringify(profile.commands)).toBe(JSON.stringify([
  ["bun", "--config=/dev/null", "--no-env-file", "install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/tmp/ranger-install"],
  ["bun", "--config=/dev/null", "--no-env-file", "test", "./src", "./scripts", "./tools", "./tests/package-exports.smoke.test.ts"],
  ["bun", "--config=/dev/null", "--no-env-file", "test", "./tests/integration"],
  ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/typescript/bin/tsc", "--noEmit"],
  ["bun", "--config=/dev/null", "--no-env-file", "./node_modules/eslint/bin/eslint.js", "."],
 ]));
 expect(profile.profileDigest).toBe("sha256:fc530b9f98d498dd97820a47e252fd188f086ccc7e1c547c83845841e6549963");
 expect(validateReviewedManifest(profile)).toEqual(profile);
 expect(validateProfileManifest(profile)).toEqual(profile);
 expect(validateRemoteTestJob(jobFor(profile, MYELIN_REPOSITORY), profile)).toEqual(jobFor(profile, MYELIN_REPOSITORY));
});

test("unknown recipe and repository IDs fail closed", () => {
 const profile = createReviewedProfile(myelinInput);
 for (const field of ["recipe", "repositoryId"]) for (const value of ["unknown-v1", "toString", "__proto__", "constructor"]) {
  const reviewed = { ...profile.reviewed, [field]: value };
  expect(() => createReviewedProfile({ ...profile, reviewed })).toThrow("Unknown reviewed recipe");
  expect(() => validateReviewedManifest({ ...profile, reviewed })).toThrow("Unknown reviewed recipe");
  expect(() => validateProfileManifest({ ...profile, reviewed })).toThrow("Unknown reviewed recipe");
  expect(() => validateRemoteTestJob(jobFor(profile, MYELIN_REPOSITORY), { ...profile, reviewed })).toThrow("Unknown reviewed recipe");
 }
});

test("callers cannot replace code-reviewed policy through extra registry arguments", () => {
 const profile = createReviewedProfile(myelinInput);
 const registry = { [MYELIN_REPOSITORY]: { "myelin-v1": {
  needsNats: true, checks: Object.fromEntries(profile.reviewed.checks.map(check => [check, ["sh", "-c", "arbitrary"]])),
 } } };
 const forged = { ...profile, profileDigest: "sha256:a0bbe8dc7840b3cf5b86fc0a51438ca997bb952015b4d72dd4896cda8913c26c", commands: [profile.commands[0], ...profile.reviewed.checks.map((): [string, ...string[]] => ["sh", "-c", "arbitrary"])] };
 expect(Reflect.apply(createReviewedProfile, undefined, [myelinInput, registry])).toEqual(profile);
 for (const validate of [validateReviewedManifest, validateProfileManifest]) {
  expect(Reflect.apply(validate, undefined, [profile, registry])).toEqual(profile);
  expect(() => Reflect.apply(validate, undefined, [forged, registry])).toThrow("Reviewed profile content/digest mismatch");
 }
 expect(() => Reflect.apply(validateRemoteTestJob, undefined, [jobFor(forged, MYELIN_REPOSITORY), forged, registry])).toThrow("Reviewed profile content/digest mismatch");
});

test("repository registry fixture exercises the public APIs in an isolated process", async () => {
 const result = await runCmd(process.execPath, [join(import.meta.dir, "fixtures", "remote-test-recipe-registry.ts")]);
 expect(result.stderr).toBe("");
 expect(result.code).toBe(0);
 expect(result.stdout).toContain("repository-scoped IDs bind commands and profile identity");
 expect(result.stdout).toContain("each recipe enforces its NATS requirement and uses existing bounded budgets");
});

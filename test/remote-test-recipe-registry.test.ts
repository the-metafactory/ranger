import { expect, test } from "bun:test";
import { validateProfileManifest, validateRemoteTestJob, type ProfileManifest } from "../src/remote-test/contract.ts";
import { createReviewedProfile, MYELIN_REPOSITORY, profileBudgets, REVIEWED_RECIPES, validateReviewedManifest, type ReviewedRecipeRegistry } from "../src/remote-test/profiles.ts";

const digest = `sha256:${"a".repeat(64)}`;
const nats = { kind: "nats", imageReference: `localhost/nats@${digest}` };
const repository = "github:github.com/example/fixture";
const registry: ReviewedRecipeRegistry = {
 ...REVIEWED_RECIPES,
 [repository]: {
  "fixture-v1": { needsNats: false, checks: { unit: ["bun", "--config=/dev/null", "--no-env-file", "test", "./test"] } },
  "fixture-nats-v1": { needsNats: true, checks: { integration: ["bun", "--config=/dev/null", "--no-env-file", "test", "./bus-test"] } },
 },
};
const myelinInput = {
 profileId: "myelin-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"], sidecars: [nats] },
};
const fixtureInput = {
 profileId: "fixture-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { recipe: "fixture-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit"], sidecars: [] },
};
const jobFor = (profile: ProfileManifest, repositoryId: string) => ({
 version: 1 as const, jobId: "11111111-1111-4111-8111-111111111111", correlationId: "22222222-2222-4222-8222-222222222222",
 repositoryId, commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: digest,
 profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest,
 imageDigest: profile.imageDigest, platform: profile.platform, deadline: 2_000_000_000_000, generation: 1,
});

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

test("another repository's reviewed recipe validates and admits only its own repository", () => {
 const profile = createReviewedProfile(fixtureInput, registry);
 expect(profile.commands[1]).toEqual(["bun", "--config=/dev/null", "--no-env-file", "test", "./test"]);
 expect(validateReviewedManifest(profile, registry)).toEqual(profile);
 expect(validateRemoteTestJob(jobFor(profile, repository), profile, registry)).toEqual(jobFor(profile, repository));
 expect(() => validateRemoteTestJob(jobFor(profile, MYELIN_REPOSITORY), profile, registry)).toThrow("Reviewed recipe repository mismatch");
 const myelin = createReviewedProfile(myelinInput);
 expect(() => validateRemoteTestJob(jobFor(myelin, repository), myelin, registry)).toThrow("Reviewed recipe repository mismatch");
 expect(() => validateProfileManifest(profile)).toThrow("Unknown or ambiguous reviewed recipe");
 expect(() => validateRemoteTestJob({ ...jobFor(profile, repository), profileDigest: `sha256:${"b".repeat(64)}` }, profile, registry)).toThrow("Remote-test job does not match operator profile: profileDigest");
});

test("unknown and ambiguous recipe IDs fail closed", () => {
 const profile = createReviewedProfile(myelinInput);
 for (const recipe of ["unknown-v1", "toString", "__proto__", "constructor"]) {
  const reviewed = { ...profile.reviewed, recipe };
  expect(() => createReviewedProfile({ ...profile, reviewed })).toThrow("Unknown or ambiguous reviewed recipe");
  expect(() => validateReviewedManifest({ ...profile, reviewed })).toThrow("Unknown or ambiguous reviewed recipe");
  expect(() => validateProfileManifest({ ...profile, reviewed })).toThrow("Unknown or ambiguous reviewed recipe");
 }
 const ambiguous = { ...registry, "github:github.com/example/other": registry[repository] };
 expect(() => createReviewedProfile(fixtureInput, ambiguous)).toThrow("Unknown or ambiguous reviewed recipe");
});

test("submitters cannot override commands environment limits or required checks", () => {
 const profile = createReviewedProfile(fixtureInput, registry);
 for (const policy of [
  { checks: [] }, { checks: ["unit", "unit"] }, { checks: ["integration"] }, { checks: ["unit", "lint"] },
  { checks: ["screenshots"] }, { commands: [["sh", "-c", "arbitrary"]] }, { env: { SECRET: "value" } },
  { limits: { cpuCores: 8 } }, { runtime: "bun-latest" }, { install: "online" }, { cache: "shared" },
 ]) {
  const reviewed = { ...profile.reviewed, ...policy };
  expect(() => createReviewedProfile({ ...profile, reviewed }, registry)).toThrow();
  expect(() => validateRemoteTestJob(jobFor(profile, repository), { ...profile, reviewed }, registry)).toThrow();
 }
 for (const changed of [
  { ...profile, commands: [["bun", "run", "arbitrary"]] },
  { ...profile, env: { SECRET: "value" } }, { ...profile, limits: { cpuCores: 8 } },
 ]) expect(() => validateRemoteTestJob(jobFor(profile, repository), changed, registry)).toThrow();
});

test("each recipe enforces its NATS requirement and uses existing bounded budgets", () => {
 const withoutNats = createReviewedProfile(fixtureInput, registry);
 const withNatsInput = { ...fixtureInput, reviewed: { ...fixtureInput.reviewed, recipe: "fixture-nats-v1", checks: ["integration"], sidecars: [nats] } };
 const withNats = createReviewedProfile(withNatsInput, registry);
 expect(validateReviewedManifest(withNats, registry)).toEqual(withNats);
 expect(profileBudgets(withoutNats.reviewed)).toEqual({ test: { cpuCores: 2, memoryBytes: 1610612736, pids: 256 } });
 expect(profileBudgets(withNats.reviewed)).toEqual(profileBudgets(createReviewedProfile(myelinInput).reviewed));
 expect(profileBudgets(withNats.reviewed)).toEqual({
  test: { cpuCores: 1.75, memoryBytes: 1342177280, pids: 224 },
  nats: { cpuCores: 0.25, memoryBytes: 268435456, pids: 32 },
 });
 for (const [input, sidecars] of [
  [fixtureInput, [nats]], [withNatsInput, []], [myelinInput, []],
  [withNatsInput, [nats, nats]], [withNatsInput, [{ ...nats, imageReference: "nats:latest" }]],
 ] as const) expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, sidecars } }, registry)).toThrow();
});

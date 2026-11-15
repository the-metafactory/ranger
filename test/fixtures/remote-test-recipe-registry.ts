import { expect, mock } from "bun:test";
import { REVIEWED_RECIPES, type ReviewedRecipeRegistry } from "../../src/remote-test/recipes.ts";
import { digest, nats, myelinInput, jobFor } from "./remote-test-recipe-inputs.ts";

function check(name: string, run: () => void): void {
 run();
 console.log(name);
}

const repository = "github:github.com/example/fixture";
const otherRepository = "github:github.com/example/other";
const fixtureRecipe = { needsNats: false, checks: { unit: ["bun", "--config=/dev/null", "--no-env-file", "test", "./test"] as const } };
const registry: ReviewedRecipeRegistry = {
 ...REVIEWED_RECIPES,
 [repository]: {
  "fixture-v1": fixtureRecipe,
  "fixture-nats-v1": { needsNats: true, checks: { integration: ["bun", "--config=/dev/null", "--no-env-file", "test", "./bus-test"] } },
 },
 [otherRepository]: { "fixture-v1": fixtureRecipe },
};
mock.module(import.meta.resolve("../../src/remote-test/recipes.ts"), () => ({ REVIEWED_RECIPES: registry, MYELIN_REPOSITORY: "github:github.com/the-metafactory/myelin" }));
const { createReviewedProfile, MYELIN_REPOSITORY, profileBudgets, validateReviewedManifest } = await import("../../src/remote-test/profiles.ts");
const { validateProfileManifest, validateRemoteTestJob } = await import("../../src/remote-test/contract.ts");

const fixtureInput = {
 profileId: "fixture-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { repositoryId: repository, recipe: "fixture-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit"], sidecars: [] },
};
check("repository-scoped IDs bind commands and profile identity", () => {
 const profile = createReviewedProfile(fixtureInput);
 const other = createReviewedProfile({ ...fixtureInput, reviewed: { ...fixtureInput.reviewed, repositoryId: otherRepository } });
 expect(profile.commands).toEqual(other.commands);
 expect(profile.profileDigest).not.toBe(other.profileDigest);
 expect(validateProfileManifest(other)).toEqual(other);
 expect(validateReviewedManifest(other)).toEqual(other);
 expect(validateRemoteTestJob(jobFor(other, otherRepository), other)).toEqual(jobFor(other, otherRepository));
 expect(() => validateRemoteTestJob(jobFor(other, repository), other)).toThrow("Reviewed recipe repository mismatch");
 expect(() => validateRemoteTestJob(jobFor(profile, otherRepository), profile)).toThrow("Reviewed recipe repository mismatch");
 const { repositoryId: _repositoryId, ...reviewed } = fixtureInput.reviewed;
 expect(() => createReviewedProfile({ ...fixtureInput, reviewed })).toThrow("Unknown reviewed recipe");
 const forged = { ...profile, reviewed: { ...profile.reviewed, repositoryId: otherRepository } };
 expect(() => validateProfileManifest(forged)).toThrow("Reviewed profile content/digest mismatch");
 expect(() => validateRemoteTestJob(jobFor(profile, otherRepository), forged)).toThrow("Reviewed profile content/digest mismatch");
});

check("another repository's reviewed recipe validates and admits only its own repository", () => {
 const profile = createReviewedProfile(fixtureInput);
 expect(profile.commands[1]).toEqual(["bun", "--config=/dev/null", "--no-env-file", "test", "./test"]);
 expect(validateReviewedManifest(profile)).toEqual(profile);
 expect(validateRemoteTestJob(jobFor(profile, repository), profile)).toEqual(jobFor(profile, repository));
 expect(() => validateRemoteTestJob(jobFor(profile, MYELIN_REPOSITORY), profile)).toThrow("Reviewed recipe repository mismatch");
 const myelin = createReviewedProfile(myelinInput);
 expect(() => validateRemoteTestJob(jobFor(myelin, repository), myelin)).toThrow("Reviewed recipe repository mismatch");
 expect(validateProfileManifest(profile)).toEqual(profile);
 expect(() => validateRemoteTestJob({ ...jobFor(profile, repository), profileDigest: `sha256:${"b".repeat(64)}` }, profile)).toThrow("Remote-test job does not match operator profile: profileDigest");
});

check("submitters cannot override commands environment limits or required checks", () => {
 const profile = createReviewedProfile(fixtureInput);
 for (const policy of [
  { checks: [] }, { checks: ["unit", "unit"] }, { checks: ["integration"] }, { checks: ["unit", "lint"] },
  { checks: ["screenshots"] }, { commands: [["sh", "-c", "arbitrary"]] }, { env: { SECRET: "value" } },
  { limits: { cpuCores: 8 } }, { runtime: "bun-latest" }, { install: "online" }, { cache: "shared" },
 ]) {
  const reviewed = { ...profile.reviewed, ...policy };
  expect(() => createReviewedProfile({ ...profile, reviewed })).toThrow();
  expect(() => validateRemoteTestJob(jobFor(profile, repository), { ...profile, reviewed })).toThrow();
 }
 for (const changed of [
  { ...profile, commands: [["bun", "run", "arbitrary"]] },
  { ...profile, env: { SECRET: "value" } }, { ...profile, limits: { cpuCores: 8 } },
 ]) expect(() => validateRemoteTestJob(jobFor(profile, repository), changed)).toThrow();
});

check("each recipe enforces its NATS requirement and uses existing bounded budgets", () => {
 const withoutNats = createReviewedProfile(fixtureInput);
 const withNatsInput = { ...fixtureInput, reviewed: { ...fixtureInput.reviewed, recipe: "fixture-nats-v1", checks: ["integration"], sidecars: [nats] } };
 const withNats = createReviewedProfile(withNatsInput);
 expect(validateReviewedManifest(withNats)).toEqual(withNats);
 expect(profileBudgets(withoutNats.reviewed)).toEqual({ test: { cpuCores: 2, memoryBytes: 1610612736, pids: 256 } });
 expect(profileBudgets(withNats.reviewed)).toEqual(profileBudgets(createReviewedProfile(myelinInput).reviewed));
 expect(profileBudgets(withNats.reviewed)).toEqual({
  test: { cpuCores: 1.75, memoryBytes: 1342177280, pids: 224 },
  nats: { cpuCores: 0.25, memoryBytes: 268435456, pids: 32 },
 });
 for (const [input, sidecars] of [
  [fixtureInput, [nats]], [withNatsInput, []], [myelinInput, []],
  [withNatsInput, [nats, nats]], [withNatsInput, [{ ...nats, imageReference: "nats:latest" }]],
 ] as const) expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, sidecars } })).toThrow();
});

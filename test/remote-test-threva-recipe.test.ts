import { expect, test } from "bun:test";
import { validateProfileManifest, validateRemoteTestJob } from "../src/remote-test/contract.ts";
import { createReviewedProfile, profileBudgets } from "../src/remote-test/profiles.ts";
import { RANGER_REPOSITORY, THREVA_APP_REPOSITORY } from "../src/remote-test/recipes.ts";
import { digest, jobFor, nats } from "./fixtures/remote-test-recipe-inputs.ts";

const input = {
 profileId: "threva-app-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { repositoryId: THREVA_APP_REPOSITORY, recipe: "threva-app-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["typecheck", "lint", "unit"], sidecars: [] },
};
const bun = ["bun", "--config=/dev/null", "--no-env-file"] as const;

test("threva-app-v1 runs the three checks scripts/check.ts runs, offline and without a sidecar", () => {
 const profile = createReviewedProfile(input);
 expect(profile.commands).toEqual([
  ["bun", "--config=/dev/null", "--no-env-file", "install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--backend=copyfile", "--cache-dir=/tmp/ranger-install"],
  [...bun, "./node_modules/typescript/bin/tsc", "--noEmit"],
  [...bun, "./node_modules/eslint/bin/eslint.js", "."],
  [...bun, "test", "test"],
 ]);
 expect(validateProfileManifest(profile)).toEqual(profile);
 expect(profileBudgets(profile.reviewed)).toEqual({ test: { cpuCores: 2, memoryBytes: 1610612736, pids: 256 } });
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, checks: ["typecheck", "integration", "lint", "unit"] } })).toThrow();
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, checks: ["typecheck", "unit"] } })).toThrow();
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, sidecars: [nats] } })).toThrow();
});

test("the recipe stays bound to its repository and admits only that repository's jobs", () => {
 const profile = createReviewedProfile(input);
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, repositoryId: RANGER_REPOSITORY } })).toThrow("Unknown reviewed recipe");
 expect(() => createReviewedProfile({ ...input, reviewed: { ...input.reviewed, recipe: "myelin-v1" } })).toThrow("Unknown reviewed recipe");
 expect(validateRemoteTestJob(jobFor(profile, THREVA_APP_REPOSITORY), profile)).toEqual(jobFor(profile, THREVA_APP_REPOSITORY));
 expect(() => validateRemoteTestJob(jobFor(profile, RANGER_REPOSITORY), profile)).toThrow("Reviewed recipe repository mismatch");
 const ranger = createReviewedProfile({ ...input, profileId: "ranger-v1", reviewed: { ...input.reviewed, repositoryId: RANGER_REPOSITORY, recipe: "ranger-v1" } });
 expect(() => validateRemoteTestJob(jobFor(ranger, THREVA_APP_REPOSITORY), ranger)).toThrow("Reviewed recipe repository mismatch");
});

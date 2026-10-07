import { expect, test } from "bun:test";
import { createReviewedProfile, validateReviewedManifest, reviewedCommands, profileBudgets } from "../src/remote-test/profiles.ts";
import { validateProfileManifest } from "../src/remote-test/contract.ts";

const digest = `sha256:${"a".repeat(64)}`;
export const reviewedFixture = () => createReviewedProfile({ profileId: "myelin-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"], sidecars: [{ kind: "nats", imageReference: `localhost/nats@${digest}` }] } });

test("reviewed profile binds named commands, sidecar image and cache policy into its digest", () => {
 const profile = reviewedFixture(); expect(validateReviewedManifest(profile)).toEqual(profile);
 expect(profile.commands).toEqual(reviewedCommands(profile.reviewed));
 for (const changed of [ { ...profile, commands: [["bun", "run", "screenshots"]] },
  { ...profile, reviewed: { ...profile.reviewed, cache: "shared" } },
  { ...profile, reviewed: { ...profile.reviewed, sidecars: [{ kind: "redis", imageReference: `localhost/redis@${digest}` }] } },
  { ...profile, reviewed: { ...profile.reviewed, sidecars: [{ kind: "nats", imageReference: `localhost/nats@sha256:${"b".repeat(64)}` }] } },
  { ...profile, platform: "darwin-arm64" },
  { ...profile, reviewed: { ...profile.reviewed, endpoint: "nats://control-plane:4222" } },
 ]) expect(() => validateProfileManifest(changed)).toThrow();
});
test("profile forbids missing or duplicated checks, undeclared services and mutable images", () => {
 const p = reviewedFixture();
 for (const reviewed of [ { ...p.reviewed, checks: ["unit"] }, { ...p.reviewed, checks: [...p.reviewed.checks, "unit"] },
  { ...p.reviewed, sidecars: [] }, { ...p.reviewed, sidecars: [{ kind: "nats", imageReference: "nats:latest" }] },
  { ...p.reviewed, checks: ["unit", "integration", "typecheck", "lint", "webgl"] } ])
  expect(() => createReviewedProfile({ ...p, reviewed })).toThrow();
});
test("separate enforced container budgets sum to the lane ceiling", () => {
 const b = profileBudgets(reviewedFixture().reviewed);
 expect(b.test.cpuCores + b.nats!.cpuCores).toBe(2);
 expect(b.test.memoryBytes + b.nats!.memoryBytes).toBe(1610612736);
 expect(b.test.pids + b.nats!.pids).toBe(256);
});

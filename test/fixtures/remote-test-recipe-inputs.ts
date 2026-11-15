import type { ProfileManifest } from "../../src/remote-test/contract.ts";

export const digest = `sha256:${"a".repeat(64)}`;
export const nats = { kind: "nats", imageReference: `localhost/nats@${digest}` };
export const myelinInput = {
 profileId: "myelin-v1", lockDigest: digest, imageDigest: digest,
 reviewed: { recipe: "myelin-v1", cache: "disabled", install: "frozen-offline-copy", checks: ["unit", "integration", "typecheck", "lint"], sidecars: [nats] },
};
export const jobFor = (profile: ProfileManifest, repositoryId: string) => ({
 version: 1 as const, jobId: "11111111-1111-4111-8111-111111111111", correlationId: "22222222-2222-4222-8222-222222222222",
 repositoryId, commitDigest: "a".repeat(40), treeDigest: "b".repeat(40), bundleDigest: digest,
 profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest,
 imageDigest: profile.imageDigest, platform: profile.platform, deadline: 2_000_000_000_000, generation: 1,
});

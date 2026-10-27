import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEnvelope, type MyelinEnvelope } from "@the-metafactory/myelin";
import { signEnvelope, type Identity } from "@the-metafactory/myelin/identity";
import { runCmd } from "../src/exec.ts";
import { receiveStagedSource } from "../src/remote-test/bus-source.ts";
import type { RemoteTestJob } from "../src/remote-test/contract.ts";
import { validateExecutorConfig } from "../src/remote-test/executor.ts";
import { stageSource } from "../src/remote-test/source.ts";

export const issuer = "did:mf:fixture-ranger";
export const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function busWorkerSource(root: string) {
 const repo = join(root, "repo"), stagingRoot = join(root, "staging"), jobsRoot = join(root, "jobs");
 for (const directory of [repo, stagingRoot, jobsRoot]) await mkdir(directory, { mode: 0o700 });
 const git = async (...args: string[]) => {
  const result = await runCmd("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: repo });
  if (result.code) throw Error(result.stderr);
 };
 await git("init", "--initial-branch=main");
 await writeFile(join(repo, "bun.lock"), "lock\n");
 await git("add", ".");
 await git("commit", "-m", "fixture");
 const staged = await stageSource({ worktree: repo, stagingRoot, jobId: randomUUID() });
 const bytes = await readFile(staged.bundlePath);
 const profile = { version: 1 as const, profileId: "unit", profileDigest: sha("profile"), lockDigest: sha("lock\n"), imageDigest: sha("image"),
  platform: "linux-arm64" as const, commands: [["bun", "test"]] as [string, ...string[]][] };
 const executor = validateExecutorConfig({ executorId: "fixture", jobsRoot, profiles: [{ profile, lockFile: "bun.lock", imageReference: `localhost/runtime@${profile.imageDigest}` }] });
 const job: RemoteTestJob = { jobId: randomUUID(), correlationId: randomUUID(), repositoryId: "github:github.com/example/repo", ...staged.manifest,
  profileId: profile.profileId, profileDigest: profile.profileDigest, lockDigest: profile.lockDigest, imageDigest: profile.imageDigest,
  platform: profile.platform, generation: 2, deadline: Date.now() + 300_000 };
 await receiveStagedSource({ jobsRoot, job, declaredBytes: bytes.length, chunks: (async function* () { yield bytes; })(), policy: executor.artifacts });
 return { jobsRoot, bytes, profile, executor, job };
}

export async function busWorkerRegistry(root: string) {
 const { publicKey, privateKey } = generateKeyPairSync("ed25519"), seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
 const identity: Identity = { id: issuer, network: "example", type: "service", created_at: new Date().toISOString(),
  public_key: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
 const registryFile = join(root, "registry.json");
 await writeFile(registryFile, JSON.stringify({ version: 2, identities: [identity], trusted_hubs: [] }), { mode: 0o600 });
 return { seed, registryFile };
}

export function busWorkerIssuers(job: RemoteTestJob) {
 return [{ issuer, bindings: [{ repositoryId: job.repositoryId, profileId: job.profileId, profileDigest: job.profileDigest }] }];
}

export async function busWorkerRequest(input: { source: string; type: string; job: RemoteTestJob; bundleBytes: number; seed?: Buffer }): Promise<MyelinEnvelope> {
 const { job } = input;
 const envelope = createEnvelope({ source: input.source, type: input.type,
  sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "local-only" },
  correlation_id: job.correlationId, deadline: new Date(job.deadline).toISOString(), distribution_mode: "offer",
  originator: { identity: issuer, attribution: "adapter-resolved" },
  payload: { version: 1, job, source: { bundleDigest: job.bundleDigest, bundleBytes: input.bundleBytes } } });
 return input.seed ? await signEnvelope(envelope, input.seed.toString("base64"), issuer, { role: "origin" }) : envelope;
}

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount, createOperator, createUser, encodeAccount, encodeOperator, encodeUser, fmtCreds } from "@nats-io/jwt";
import { validateEnvelope } from "@the-metafactory/cortex/bus";
import type { MyelinEnvelope } from "@the-metafactory/myelin";
import { loadRegistry, verifyEnvelopeIdentity } from "@the-metafactory/myelin/identity";
import { taskSubjectAndType } from "@the-metafactory/myelin/subjects";
import { AckPolicy, connect, credsAuthenticator, nanos, StorageType, type NatsConnection } from "nats";
import { persistExecution } from "../src/remote-test/artifacts.ts";
import { BUS_LIMITS, validateBusConfig } from "../src/remote-test/bus-contract.ts";
import { startBusWorker, type BusWorker } from "../src/remote-test/bus-worker.ts";
import { openJobLedger } from "../src/remote-test/job-ledger.ts";
import { busWorkerIssuers, busWorkerRegistry, busWorkerRequest, busWorkerSource, issuer } from "./remote-test-bus-worker-support.ts";

const binary = Bun.which("nats-server");
const transportTest = binary ? test : test.skip;
const requestStream = "CI_REQUESTS", resultStream = "CI_RESULTS", durable = "ranger-worker";
const route = taskSubjectAndType("synthetic", "ci-test", "beta");

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 8_000) {
 const deadline = performance.now() + timeoutMs;
 while (performance.now() < deadline) {
  if (await predicate()) return;
  await Bun.sleep(20);
 }
 throw Error(`Timed out waiting for ${description}`);
}

async function server(root: string, domain: string, operator: string, systemAccount: string, accountClaims: Record<string, string>) {
 if (!binary) throw Error("nats-server unavailable");
 const config = join(root, `${domain}.conf`);
 await writeFile(config, JSON.stringify({ server_name: `synthetic-${domain}`, listen: "127.0.0.1:-1", operator, system_account: systemAccount,
  resolver: "MEMORY", resolver_preload: accountClaims, jetstream: { domain, store_dir: join(root, domain), max_memory_store: 16 * 1024 ** 2, max_file_store: 16 * 1024 ** 2 } }));
 const child = spawn(binary, ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
 let logs = "", spawnError: Error | undefined;
 child.stderr.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-32_768); });
 const exited = new Promise<void>(resolve => {
  child.once("exit", () => { resolve(); });
  child.once("error", error => { spawnError = error; resolve(); });
 });
 const stop = async () => {
  if (child.exitCode !== null || child.signalCode !== null || spawnError) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
  try { await exited; } finally { clearTimeout(timer); }
 };
 try {
  await waitFor(() => {
   if (spawnError) throw spawnError;
   if (child.exitCode !== null) throw Error(logs);
   return logs.includes("Server is ready");
  }, `${domain} startup`);
  const port = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(logs)?.[1];
  if (!port) throw Error(logs);
  return { url: `nats://127.0.0.1:${port}`, stop };
 } catch (error) { await stop(); throw error; }
}

async function fixture() {
 const root = await realpath(await mkdtemp(join(tmpdir(), "ranger-worker-transport-")));
 const servers: Awaited<ReturnType<typeof server>>[] = [], connections: NatsConnection[] = [];
 let worker: BusWorker | undefined;
 let release: () => void = () => undefined;
 const stop = async () => {
  release();
  try { await worker?.stop(); } finally {
   try { for (const nc of connections) await nc.close(); }
   finally { try { for (const broker of [...servers].reverse()) await broker.stop(); } finally { await rm(root, { recursive: true, force: true }); } }
  }
 };
 try {
  const operatorKey = createOperator(), account = createAccount(), system = createAccount(), user = createUser(), workerUser = createUser();
  const operator = await encodeOperator("synthetic", operatorKey, { system_account: system.getPublicKey() });
  const claims = await encodeAccount("worker", account, { limits: { conn: 20, subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, leaf: -1,
   mem_storage: 16 * 1024 ** 2, disk_storage: 16 * 1024 ** 2, streams: 4, consumer: 4 } }, { signer: operatorKey });
  const systemClaims = await encodeAccount("system", system, {}, { signer: operatorKey });
  const credentials = fmtCreds(await encodeUser("worker", user, account), user);
  const workerCredentials = fmtCreds(await encodeUser("consumer", workerUser, account, { pub: { deny: [
   "$JS.*.API.STREAM.CREATE.>", "$JS.*.API.STREAM.UPDATE.>", "$JS.*.API.STREAM.DELETE.>",
   "$JS.*.API.CONSUMER.CREATE.>", "$JS.*.API.CONSUMER.DURABLE.CREATE.>", "$JS.*.API.CONSUMER.DELETE.>",
  ] } }), workerUser);
  const credentialsFile = join(root, "worker.creds");
  await writeFile(credentialsFile, workerCredentials, { mode: 0o600 });
  const managers = [];
  for (const domain of ["alpha", "beta"]) {
   const broker = await server(root, domain, operator, system.getPublicKey(), { [account.getPublicKey()]: claims, [system.getPublicKey()]: systemClaims });
   servers.push(broker);
   const nc = await connect({ servers: broker.url, authenticator: credsAuthenticator(credentials), reconnect: false, timeout: 1_000 });
   connections.push(nc);
   const manager = await nc.jetstreamManager({ domain });
   await manager.streams.add({ name: requestStream, subjects: [route.subject], storage: StorageType.Memory, max_msg_size: BUS_LIMITS.requestBytes });
   await manager.streams.add({ name: resultStream, subjects: ["local.synthetic.beta.dispatch.task.>"], storage: StorageType.Memory });
   await manager.consumers.add(requestStream, { durable_name: durable, filter_subject: route.subject, ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(10_000), max_ack_pending: 1, max_deliver: 3 });
   managers.push(manager);
  }
  const { jobsRoot, bytes, executor, job } = await busWorkerSource(root);
  const { seed, registryFile } = await busWorkerRegistry(root);
  const beta = servers[1], alphaManager = managers[0], betaManager = managers[1], alphaConnection = connections[0], betaConnection = connections[1];
  if (!beta || !alphaManager || !betaManager || !alphaConnection || !betaConnection) throw Error("Missing brokers");
  const bus = validateBusConfig({ version: 1, target: { domain: "beta", account: account.getPublicKey() },
   routing: { classification: "local", principal: "synthetic", stack: "beta" },
   streams: { request: { stream: requestStream, durable }, result: { stream: resultStream } }, transport: { servers: [beta.url], credentialsFile },
   ssh: { configFile: join(root, "ssh.json") }, registry: { file: registryFile },
   execution: { maxAckPending: 1, maxConcurrentJobs: 1, ackWaitSeconds: 10, progressIntervalSeconds: 1, maxDeliver: 3 },
   issuers: busWorkerIssuers(job) });
  let executions = 0;
  const begin = async () => {
   worker = await startBusWorker({ bus, executor, signer: { issuer, seed }, outboxRoot: join(root, "outbox"), offerings: [{ capability: "ci-test", scopes: ["local"] }] }, {
    execute: async input => {
     executions++;
     expect(input.job).toEqual(job);
     expect(await readFile(input.bundlePath)).toEqual(bytes);
     const ledger = await openJobLedger(jobsRoot, "fixture");
     try {
      const admitted = ledger.admit(job);
      if (admitted.kind !== "admitted") throw Error("Expected ledger admission");
      ledger.launch(job, admitted.token);
      await new Promise<void>(resolve => { release = resolve; });
      const receipt = await persistExecution(join(jobsRoot, ".artifacts"), { version: 1, identity: job, executorId: "fixture", status: "passed", exitCode: 0, completedAt: Date.now() },
       { startedAt: Date.now() - 100, log: Buffer.from("synthetic\n"), truncated: false, outputState: "captured", resources: { state: "skipped", cpuTimeMicros: null, peakMemoryBytes: null } });
      return ledger.complete(job, admitted.token, receipt);
     } finally { ledger.close(); }
    },
   });
   return worker;
  };
  const publish = async (nc: NatsConnection, signed = true) => {
   const payload = await busWorkerRequest({ source: "synthetic.beta.ranger", type: route.type, job, bundleBytes: bytes.length, seed: signed ? seed : undefined });
   return nc.jetstream({ domain: nc === alphaConnection ? "alpha" : "beta" }).publish(route.subject, Buffer.from(JSON.stringify(payload)));
  };
  return { root, jobsRoot, job, bus, executor, seed, registryFile, begin, publish, alphaConnection, betaConnection, alphaManager, betaManager,
   release: () => { release(); }, executions: () => executions, stop };
 } catch (error) { await stop(); throw error; }
}

transportTest("authenticated operator transport holds one delivery with working progress, durably publishes, and deduplicates", async () => {
 const f = await fixture();
 try {
  await f.publish(f.alphaConnection);
  await f.begin();
  await f.publish(f.betaConnection);
  await waitFor(() => f.executions() === 1, "first execution");
  await f.publish(f.betaConnection);
  await Bun.sleep(11_100);
  const pending = await f.betaManager.consumers.info(requestStream, durable);
  expect(pending.num_ack_pending).toBe(1);
  expect(pending.delivered.consumer_seq).toBe(1);
  expect(pending.num_redelivered).toBe(0);
  expect(f.executions()).toBe(1);
  f.release();
  await waitFor(async () => (await f.betaManager.consumers.info(requestStream, durable)).ack_floor.consumer_seq === 2, "durable acknowledgement and duplicate replay");
  expect(f.executions()).toBe(1);
  expect((await f.betaManager.streams.info(resultStream)).state.messages).toBe(1);
  const stored = await f.betaManager.streams.getMessage(resultStream, { seq: 1 });
  const terminalEnvelope: MyelinEnvelope = JSON.parse(Buffer.from(stored.data).toString("utf8"));
  const terminal = validateEnvelope(terminalEnvelope);
  if (!terminal.ok) throw Error("Durable terminal must be a valid envelope");
  expect(terminal.envelope.type).toBe("dispatch.task.completed");
  expect(terminal.envelope.correlation_id).toBe(f.job.correlationId);
  expect(terminal.envelope.payload.result_summary).toMatch(/^status=passed .* receipt=sha256:[0-9a-f]{64}$/);
  expect((await verifyEnvelopeIdentity(terminalEnvelope, loadRegistry(f.registryFile))).status).toBe("verified");
  expect((await f.alphaManager.streams.info(resultStream)).state.messages).toBe(0);
  expect((await f.alphaManager.consumers.info(requestStream, durable)).delivered.consumer_seq).toBe(0);
 } finally { f.release(); await f.stop(); }
}, 30_000);

transportTest("unsigned delivery terminates without execution or attributed lifecycle", async () => {
 const f = await fixture();
 try {
  await f.begin();
  await f.publish(f.betaConnection, false);
  await waitFor(async () => (await f.betaManager.consumers.info(requestStream, durable)).ack_floor.consumer_seq === 1, "unsigned terminal delivery");
  expect(f.executions()).toBe(0);
  expect((await f.betaManager.streams.info(resultStream)).state.messages).toBe(0);
  const ledger = await openJobLedger(f.jobsRoot, "fixture");
  try { expect(ledger.status(f.job)).toBeNull(); } finally { ledger.close(); }
 } finally { await f.stop(); }
}, 15_000);

transportTest("consumer drift refuses startup without repairing existing resources", async () => {
 const f = await fixture();
 try {
  await f.betaManager.consumers.update(requestStream, durable, { max_ack_pending: 2 });
  await expect(f.begin()).rejects.toThrow("consumer_drift");
  expect((await f.betaManager.consumers.info(requestStream, durable)).config.max_ack_pending).toBe(2);
  expect(f.executions()).toBe(0);
 } finally { await f.stop(); }
}, 15_000);

transportTest("explicit account mismatch refuses transport before consuming existing work", async () => {
 const f = await fixture();
 try {
  await f.publish(f.betaConnection);
  const bus = { ...f.bus, target: { ...f.bus.target, account: createAccount().getPublicKey() } };
  await expect(startBusWorker({ bus, executor: f.executor, signer: { issuer, seed: f.seed }, outboxRoot: join(f.root, "outbox"),
   offerings: [{ capability: "ci-test", scopes: ["local"] }] })).rejects.toThrow("account_binding");
  expect((await f.betaManager.consumers.info(requestStream, durable)).delivered.consumer_seq).toBe(0);
  expect((await f.betaManager.streams.info(resultStream)).state.messages).toBe(0);
 } finally { await f.stop(); }
}, 15_000);

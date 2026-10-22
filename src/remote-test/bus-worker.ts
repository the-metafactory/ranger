import { constants } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMyelinRuntime, type EnvelopeHandlerContext, type MyelinRuntime, type MyelinSubscribePullOpts, type MyelinSubscriber, type Offering } from "@the-metafactory/cortex/bus";
import { taskSubjectAndType } from "@the-metafactory/myelin/subjects";
import { z } from "zod";
import { privateOperatorPath } from "./baseline.ts";
import { admitBusRequest, BusAdmissionRefusal, BusAdmissionUnavailable, BUS_TEST_CAPABILITY, type AdmittedBusRequest, type BusAdmissionContext } from "./bus-admission.ts";
import { BUS_LIMITS, validateBusConfig, type BusConfig } from "./bus-contract.ts";
import { BusOutboxRefusal, openBusOutbox, type BusOutbox, type BusOutboxOptions, type DurablePublisher, type RefusalCode } from "./bus-outbox.ts";
import type { BusSigner } from "./bus-producer.ts";
import { stagedSourceBundle, StagedSourceRefusal } from "./bus-source.ts";
import { executeRemoteTest, validateExecutorConfig, type ExecutorConfig } from "./executor.ts";
import { openJobLedger, ActiveRemoteTestJob, BusyRemoteTestExecutor, InterruptedRemoteTestJob, RemoteTestIdentityConflict, RevokedRemoteTestJob, type JobLedger } from "./job-ledger.ts";
import { restoreSource, SourceError } from "./source.ts";
import { readPrivateJson } from "./ssh-cli.ts";

export type BusWorkerDecision = { kind: "ack" } | { kind: "nak"; delayMs: number } | { kind: "term"; reason: string };
export interface BusWorkerTransport extends DurablePublisher {
 enabled: boolean;
 subscribePull?: (options: MyelinSubscribePullOpts) => Pick<MyelinSubscriber, "ready" | "stop"> | null;
 jetstreamManager?: NonNullable<MyelinRuntime["jetstreamManager"]>;
 stop(): Promise<void>;
}
export interface BusWorkerInput { bus: unknown; executor: unknown; signer: BusSigner; outboxRoot: string; offerings: readonly Offering[] }
export interface BusWorkerInjected {
 connect?: (bus: BusConfig, signer: BusSigner, directory: string) => Promise<BusWorkerTransport>;
 execute?: typeof executeRemoteTest;
 outboxFault?: BusOutboxOptions["fault"];
 removeSource?: (path: string) => Promise<void>;
 diagnostic?: (code: string) => void;
}
export class BusWorkerReadinessRefusal extends Error {
 constructor(readonly code: string) { super(`Bus worker not ready: ${code}`); }
}
const refuse = (code: string): never => { throw new BusWorkerReadinessRefusal(code); };
const CredentialsSchema = z.object({ iss: z.string(), sub: z.string().regex(/^U[A-Z2-7]{55}$/), nats: z.object({ type: z.literal("user"), issuer_account: z.string().optional() }).passthrough() }).passthrough();
const SignerSchema = z.object({ version: z.literal(1), issuer: z.string().regex(/^did:[a-z0-9]+(?::[A-Za-z0-9._-]+)+$/), seed: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict();

export const connectBusWorker = (start: typeof startMyelinRuntime) => async (bus: BusConfig, signer: BusSigner, directory: string): Promise<BusWorkerTransport> => {
 const path = await privateOperatorPath(bus.transport.credentialsFile, true);
 const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 let bytes: Buffer;
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size > 65_536 || info.nlink !== 1) return refuse("credentials");
  bytes = await file.readFile();
 } finally { await file.close(); }
 let account: string, canonical: string;
 try {
  const jwt = /-----BEGIN NATS USER JWT-----\s+([A-Za-z0-9_.-]+)\s+------END NATS USER JWT------/.exec(bytes.toString("utf8"))?.[1];
  if (jwt?.split(".").length !== 3) return refuse("credentials");
  const claims = CredentialsSchema.parse(JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")));
  account = claims.nats.issuer_account ?? claims.iss;
  const seed = /-----BEGIN USER NKEY SEED-----\s+(SU[A-Z2-7]{56})\s+------END USER NKEY SEED------/.exec(bytes.toString("utf8"))?.[1];
  if (!seed) return refuse("credentials");
  canonical = `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\n${seed}\n------END USER NKEY SEED------\n`;
 } catch { return refuse("credentials"); }
 if (!/^A[A-Z2-7]{55}$/.test(account) || account !== bus.target.account) return refuse("account_binding");
 const snapshot = join(directory, "transport.creds");
 await writeFile(snapshot, canonical, { flag: "wx", mode: 0o600 });
 for (const url of bus.transport.servers) {
  const runtime = await start({ agent: { name: "ranger", displayName: "Ranger" }, nats: { url, name: "ranger-ci-test", subjects: [], credsPath: snapshot } } as unknown as Parameters<typeof start>[0],
   { jetstreamDomain: bus.target.domain, signer: { principal: signer.issuer, rawSeedBytes: signer.seed }, signFailureMode: "drop", stack: bus.routing.stack, principal: bus.routing.principal });
  if (runtime.enabled && runtime.publishDurable && runtime.subscribePull && runtime.jetstreamManager) {
   return { enabled: true, publishDurable: runtime.publishDurable.bind(runtime), subscribePull: runtime.subscribePull.bind(runtime), jetstreamManager: runtime.jetstreamManager.bind(runtime), stop: () => runtime.stop() };
  }
  await runtime.stop();
 }
 return refuse("sdk_transport");
};

async function verifyResources(transport: BusWorkerTransport, bus: BusConfig): Promise<void> {
 if (!transport.enabled || !transport.subscribePull || !transport.jetstreamManager || typeof transport.publishDurable !== "function") return refuse("sdk_transport");
 const manager = await transport.jetstreamManager();
 if (!manager) return refuse("sdk_inspection");
 const subject = taskSubjectAndType(bus.routing.principal, BUS_TEST_CAPABILITY, bus.routing.stack).subject;
 const request = await manager.streams.info(bus.streams.request.stream);
 await manager.streams.info(bus.streams.result.stream);
 const consumer = await manager.consumers.info(bus.streams.request.stream, bus.streams.request.durable);
 const parsed = z.object({ durable_name: z.string(), filter_subject: z.string(), filter_subjects: z.array(z.string()).max(0).optional(), deliver_subject: z.never().optional(),
  ack_policy: z.literal("explicit"), max_ack_pending: z.literal(1), ack_wait: z.number(), max_deliver: z.number() }).passthrough().safeParse(consumer.config);
 if (request.config.max_msg_size <= 0 || request.config.max_msg_size > BUS_LIMITS.requestBytes) return refuse("request_size");
 if (!parsed.success) return refuse("consumer_drift");
 const c = parsed.data;
 if (c.durable_name !== bus.streams.request.durable || c.filter_subject !== subject || c.ack_wait !== bus.execution.ackWaitSeconds * 1e9 || c.max_deliver !== bus.execution.maxDeliver) return refuse("consumer_drift");
}

export class BusWorker {
 private stopped = false;
 private active?: { controller: AbortController; done: Promise<BusWorkerDecision> };
 private subscription?: Pick<MyelinSubscriber, "ready" | "stop">;
 private stopping?: Promise<void>;
 constructor(private bus: BusConfig, private executor: ExecutorConfig, private context: BusAdmissionContext, private transport: BusWorkerTransport,
  private ledger: JobLedger, private outbox: BusOutbox, private directory: string, private injected: BusWorkerInjected) {}

 async start(): Promise<void> {
  if (this.stopped || this.subscription) return refuse("already_started");
  const subscription = this.transport.subscribePull?.({
   pattern: taskSubjectAndType(this.bus.routing.principal, BUS_TEST_CAPABILITY, this.bus.routing.stack).subject,
   stream: this.bus.streams.request.stream, durable: this.bus.streams.request.durable, maxMessages: 1, maxConcurrent: 1,
   onEnvelope: (envelope, subject, context) => this.handle({ bytes: Buffer.from(JSON.stringify(envelope)), subject }, context),
   onError: () => { this.diagnostic("delivery_failed"); },
  });
  if (!subscription) return refuse("sdk_subscription");
  this.subscription = subscription;
  await subscription.ready;
 }
 private diagnostic(code: string) { try { this.injected.diagnostic?.(code); } catch { return; } }
 private retry(): BusWorkerDecision { return { kind: "nak", delayMs: Math.max(1000, this.bus.execution.progressIntervalSeconds * 1000) }; }
 private term(reason: string): BusWorkerDecision { this.diagnostic(reason); return { kind: "term", reason }; }
 private async cleanupSource(path: string): Promise<void> {
  try {
   if (this.injected.removeSource) await this.injected.removeSource(path);
   else await rm(path, { recursive: true, force: true });
  } catch (error) { this.stopped = true; throw error; }
 }

 handle(input: { bytes: Uint8Array; subject: string }, delivery: EnvelopeHandlerContext): Promise<BusWorkerDecision> {
  if (this.stopped || this.active) return Promise.resolve(this.retry());
  const controller = new AbortController();
  const done = this.run(input, delivery, controller.signal).finally(() => { this.active = undefined; });
  this.active = { controller, done };
  return done;
 }

 private async deliver(admitted: AdmittedBusRequest, refusal?: RefusalCode): Promise<BusWorkerDecision> {
  const job = admitted.request.job, origin = admitted.provenance;
  if (refusal) await this.outbox.enqueueRefusal({ job, origin, code: refusal });
  else await this.outbox.enqueueTerminal(job);
  await this.outbox.drain(this.transport);
  if (!refusal && !await this.outbox.authorized(job.jobId)) return this.term("terminal_unavailable");
  return this.outbox.ackEligible(job.jobId) ? { kind: "ack" } : this.retry();
 }

 private async run(input: { bytes: Uint8Array; subject: string }, delivery: EnvelopeHandlerContext, signal: AbortSignal): Promise<BusWorkerDecision> {
  const progress = { failed: false }, cancelled = () => signal.aborted;
  const timer = setInterval(() => { try { delivery.working(); } catch { progress.failed = true; } }, this.bus.execution.progressIntervalSeconds * 1000);
  try {
   let admitted: AdmittedBusRequest;
   let refusal: RefusalCode | undefined;
   try { admitted = await admitBusRequest(input, this.context); }
   catch (error) {
    if (error instanceof BusAdmissionUnavailable) return this.retry();
    if (!(error instanceof BusAdmissionRefusal)) return this.retry();
    if (!error.authenticated) return this.term(`admission_${error.stage}_${error.code}`);
    admitted = error.authenticated;
    refusal = error.stage === "expiry" ? "expired" : "profile_rejected";
   }
   const job = admitted.request.job;
   const retained = await this.outbox.retainedRefusal({ job, origin: admitted.provenance });
   if (retained) {
    await this.outbox.drain(this.transport);
    return this.outbox.ackEligible(job.jobId) ? { kind: "ack" } : this.retry();
   }
   const state = this.ledger.status(job);
   if (state?.kind === "revoked") return this.term("revoked");
   if (state?.kind === "active" || state?.kind === "interrupted" && !this.ledger.retryReady(job)) return this.retry();
   if (state?.kind === "terminal") return await this.deliver(admitted);
   if (refusal) return await this.deliver(admitted, refusal);
   if (cancelled()) return this.retry();
   const sources = join(this.directory, "source");
   try {
    let bundlePath: string;
    try {
     const staged = await stagedSourceBundle({ config: this.executor, job });
     if (staged.reference.bundleBytes !== admitted.request.source.bundleBytes) return await this.deliver(admitted, "source_rejected");
     await restoreSource({ bundlePath: staged.bundlePath, jobsRoot: sources, jobId: job.jobId, manifest: { version: 1, commitDigest: job.commitDigest, treeDigest: job.treeDigest, bundleDigest: job.bundleDigest } });
     bundlePath = staged.bundlePath;
    } catch (error) {
     if (error instanceof StagedSourceRefusal && !["stage_busy", "stage_capacity", "interrupted"].includes(error.code) || error instanceof SourceError && error.code !== "source_io") return await this.deliver(admitted, "source_rejected");
     return this.retry();
    }
    if (cancelled()) return this.retry();
    await (this.injected.execute ?? executeRemoteTest)({ job, bundlePath, config: this.executor }, { signal });
    if (progress.failed) return this.retry();
    return await this.deliver(admitted);
   } finally { await this.cleanupSource(join(sources, job.jobId)); }
  } catch (error) {
   if (error instanceof RevokedRemoteTestJob || error instanceof RemoteTestIdentityConflict) return this.term("ledger_refused");
   if (error instanceof BusOutboxRefusal && ["revoked", "conflict", "rowless"].includes(error.code)) return this.term(`outbox_${error.code}`);
   if (!(error instanceof BusyRemoteTestExecutor || error instanceof ActiveRemoteTestJob || error instanceof InterruptedRemoteTestJob)) this.diagnostic("retryable_failure");
   return this.retry();
  } finally { clearInterval(timer); }
 }

 stop(): Promise<void> {
  return this.stopping ??= (async () => {
   this.stopped = true;
   const active = this.active;
   active?.controller.abort();
   await active?.done;
   await this.subscription?.stop();
   await this.transport.stop();
   this.outbox.close();
   this.ledger.close();
   await rm(this.directory, { recursive: true });
  })();
 }
}

export async function startBusWorker(input: BusWorkerInput, injected: BusWorkerInjected = {}): Promise<BusWorker> {
 const bus = validateBusConfig(input.bus), executor = validateExecutorConfig(input.executor);
 if (input.signer.seed.length !== 32 || !/^did:[a-z0-9]+(?::[A-Za-z0-9._-]+)+$/.test(input.signer.issuer)) return refuse("signer");
 const directory = await privateOperatorPath(join(executor.jobsRoot, ".bus-worker"));
 await mkdir(directory, { mode: 0o700 });
 let ledger: JobLedger | undefined, outbox: BusOutbox | undefined, transport: BusWorkerTransport | undefined, worker: BusWorker | undefined;
 try {
  ledger = await openJobLedger(executor.jobsRoot, executor.executorId);
  await writeFile(join(directory, "owner.json"), JSON.stringify({ ledgerId: ledger.id }), { mode: 0o600, flag: "wx" });
  await mkdir(join(directory, "source"), { mode: 0o700 });
  transport = await (injected.connect ?? connectBusWorker(startMyelinRuntime))(bus, input.signer, directory);
  await verifyResources(transport, bus);
  outbox = await openBusOutbox({ bus, root: input.outboxRoot, jobsRoot: executor.jobsRoot, executorId: executor.executorId, fault: injected.outboxFault });
  worker = new BusWorker(bus, executor, { config: bus, profiles: executor.profiles.map(p => p.profile), offerings: structuredClone([...input.offerings]) }, transport, ledger, outbox, directory, injected);
  await worker.start();
  return worker;
 } catch (error) {
  if (worker) await worker.stop();
  else { await transport?.stop(); outbox?.close(); ledger?.close(); await rm(directory, { recursive: true }); }
  if (error instanceof BusWorkerReadinessRefusal) throw error;
  return refuse("resources_or_private_store");
 }
}

export async function runBusWorkerCommand(options: { config: string; executorConfig: string; signer: string; outboxRoot: string }, signal: AbortSignal): Promise<void> {
 const bus: unknown = await readPrivateJson(options.config), executor: unknown = await readPrivateJson(options.executorConfig);
 const key = SignerSchema.parse(await readPrivateJson(options.signer));
 const worker = await startBusWorker({ bus, executor, outboxRoot: options.outboxRoot, signer: { issuer: key.issuer, seed: Buffer.from(key.seed, "base64") }, offerings: [{ capability: BUS_TEST_CAPABILITY, scopes: ["local"] }] },
  { diagnostic: code => { process.stderr.write(`ranger remote-test bus-worker: ${code}\n`); } });
 try {
  process.stdout.write("ranger remote-test bus-worker: ready; local verification authority unchanged\n");
  if (!signal.aborted) await new Promise<void>(resolve => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
 } finally { await worker.stop(); }
}

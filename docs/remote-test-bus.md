# Private ci-test bus contracts

The [settled bus boundary](https://github.com/the-metafactory/ranger/issues/146) hosts a Ranger bus worker beside the private executor, with the private Clawbox stack owning the request queue and result storage. Only configured Ranger issuers acting as themselves may invoke reviewed repository/profile bindings. `src/remote-test/bus-contract.ts` defines the strict shapes; `src/remote-test/bus-admission.ts` authenticates and admits a signed request. The explicit `remote-test bus-worker` command activates consumption. Existing SSH, executor and supervisor configuration parse unchanged; `testBackend.kind` still accepts only `ssh` and `shadow`.

## Request

`validateBusRequest(bytes)` accepts one UTF-8 JSON request of at most 128 KiB. Size is checked before decoding, so an oversized payload is never parsed:

```json
{ "version": 1, "job": <V1 RemoteTestJob>, "source": { "bundleDigest": "sha256:<hex>", "bundleBytes": <positive integer> } }
```

The job is the existing V1 schema with every identity field. `source.bundleDigest` must equal `job.bundleDigest`. `bundleBytes` is a positive safe integer within the existing 64 MiB receiver bundle ceiling. The source reference is a content digest, never a path, URL or command. Unknown fields at any level refuse. Refusals carry a fixed code (`too_large`, `malformed`, `invalid`, `digest_mismatch`) and never echo request content. Bundle bytes, logs and credentials stay off the bus.

## Operator configuration

`validateBusConfig(input)` checks private operator JSON. [`examples/remote-test-bus-config.json`](examples/remote-test-bus-config.json) is an inert skeleton that fails validation until every `REPLACE_*` value is substituted outside Git. Every field except the progress interval is required:

- `target.domain` and `target.account`: the explicit JetStream domain and account. The worker requires the account public key from the operator user JWT; account aliases and other credential formats refuse readiness. The default domain is never inferred.
- `routing`: `classification` is fixed to `local`, plus principal and stack subject tokens. Federated and public routing are unsupported.
- `streams.request.stream`, `streams.request.durable` and `streams.result.stream`: exact names. The request and result streams must differ. Wildcards, dots and whitespace refuse.
- `transport.servers`: fixed `nats://host:port` or `tls://host:port` locators without credentials, paths or queries. `transport.credentialsFile` is a normalized absolute operator path.
- `ssh.configFile`: the existing reviewed SSH JSON that source staging reuses.
- `execution`: `maxAckPending` and `maxConcurrentJobs` are fixed to 1. `ackWaitSeconds` and `maxDeliver` are bounded. An omitted `progressIntervalSeconds` defaults to one third of the verified ack wait; an explicit interval must be positive and shorter than that wait.
- `registry.file`: the private Myelin identity registry.
- `issuers`: at least one concrete issuer DID, each with at least one exact `{repositoryId, profileId, profileDigest}` binding. Missing, empty, duplicate or wildcard entries fail closed.

`authorizeBusProducer(config, {issuer, actor}, job)` finds the operator binding for an origin issuer that the caller has already verified. The actor must be absent or equal to the issuer. Delegated distinct actors refuse with `actor_mismatch`. The job's repository, profile ID and profile digest must match one binding of that issuer exactly, otherwise the call refuses with `unauthorized`. Permissions come only from the operator configuration and are never derived from job fields. The function does no cryptographic verification; consumers use `admitBusRequest` for that boundary.

Keep the substituted configuration, issuer identities, endpoints, credentials and registry in operator-owned locations outside all Git repositories. Activation, credential issuance and gate promotion remain separate operator checkpoints.

## Opt-in worker lifecycle

Run `ranger remote-test bus-worker --config <private-bus-json> --executor-config <private-executor-json> --signer <private-result-signer-json> --outbox-root <private-directory>` only on the reviewed executor host. The signer uses `{version:1, issuer:<DID>, seed:<base64 Ed25519 seed>}`. This command neither provisions resources nor promotes remote results into supervisor or merge gates.

Startup snapshots the checked user JWT and seed into canonical credential blocks in the private worker workspace, then connects through the Cortex runtime with that snapshot and explicit JetStream domain. It reads the existing request/result streams and named durable. Missing resources or drift in filter, explicit acknowledgements, `MaxAckPending=1`, ack wait or delivery limit refuse readiness. The existing request stream must have a positive `max_msg_size` no greater than 128 KiB, bounding envelopes before SDK decoding. The pull requests one message and runs one handler. Worker credentials need read/bind/publish permissions, with provisioning permissions denied.

The public `startBusWorker` / `handle` / `stop` seam composes signed admission, staged digest lookup, the existing source verifier, reviewed executor, JobLedger and terminal outbox. Unauthenticated or unauthorized inputs terminate without job attribution. Authenticated source/profile/expiry refusals use explicit non-receipt outbox evidence. Store, capacity and transport faults yield delayed retry. Current retained terminal receipts replay without execution; interrupted attempts require explicit confirmed recovery before the remaining bounded attempt can run. Request ack requires a durably delivered outbox event. Progress runs during execution and terminal publication.

SIGINT/SIGTERM abort execution through its durable cancellation controls, await cleanup, stop the subscription/runtime and release the private `.bus-worker` workspace. A stale workspace refuses startup. With the previous worker and executor stopped, the existing `remote-test recover` command verifies owned-container absence and removes a workspace only when its owner matches the execution ledger. Restart never manufactures a receipt or performs automatic recovery.

`test/remote-test-bus-worker.test.ts` covers the public lifecycle with real ledger/staged fixtures and fault injection. `test/remote-test-bus-worker-transport.test.ts` uses disposable native authenticated JetStream brokers, denies worker provisioning, holds a delivery beyond ack wait and verifies the signed durable terminal result. It skips when `nats-server` is unavailable. No container runtime is needed for these tests.

## Terminal lifecycle outbox

`src/remote-test/bus-outbox.ts` retains terminal lifecycle events in a private SQLite store (`outbox.sqlite`, mode 0600) under an operator-owned outbox root that must be separate from the executor jobs root. It consumes the published Cortex bus SDK (`@the-metafactory/cortex/bus`): the dispatch lifecycle builders and `publishDurable`. It opens no connection itself; the caller passes a runtime or any object with `publishDurable`. It never admits, completes or executes a job.

The dependency is pinned to Cortex `v6.17.2` (`3a645ff`), which exports the durable publisher error/types and the delivery `working()` context used by the worker.

- `enqueueTerminal(job)` accepts only an authoritative receipt: the job must have a ledger row with a terminal, non-revoked outcome, the retained receipt must exist, and its bytes must equal the ledger receipt. Rowless, revoked, unfinished, absent or conflicting evidence throws `BusOutboxRefusal` and queues nothing. The receipt is then exported to `receipts/<jobId>.json` through the existing atomic exporter, and one event is queued in a single transaction. Repeating the call after a crash returns the same event.
- `passed` maps to `dispatch.task.completed`; `test_failed`, `infra_failed` and `rejected` map to `dispatch.task.failed`; `timed_out` and `cancelled` map to `dispatch.task.aborted`. The summary carries the status, correlation id, the `ci-test` capability and an opaque `sha256` of the exported receipt. It carries no log, source, path or credential.
- `drain(publisher)` reads pending events in bounded rowid batches (indexed by state). It re-verifies each event against the retained receipt and current ledger immediately before its publish call, so a success that was revoked or superseded before that check is withheld and never published. A revocation that lands after the check, while the publish call is in flight, cannot be undone: the event is already on the wire. A withheld refusal is replaced by the job's terminal event if the job was admitted and finished afterwards. It then calls `publishDurable` with the configured result stream. The envelope is stored once, so a retry sends the same event id (the JetStream `Nats-Msg-Id`) and payload, and the runtime signs it again. An event is marked delivered only when the PubAck names the configured stream and domain. A timeout, a publisher error, a mismatched acknowledgement or a crash before the local commit leaves the event pending, stops the drain and reports no request-ack eligibility (`ackEligible(jobId)` stays false). A crash after the PubAck replays the same event; the job is not run again.
- `enqueueRefusal({ job, origin, code })` retains a separate provenance record for a structurally valid job that an authorized issuer sent and that was refused before admission, and queues a `rejected` failed lifecycle. It requires the issuer binding from `authorizeBusProducer`, refuses a job that already has a ledger row or receipt, and writes neither. Exact receipt lookup for that job stays empty.
- A lifecycle message is never read back as evidence. Delivery state never changes the ledger or promotes a remote result to gate authority.

## Signed admission

`admitBusRequest({bytes, subject}, {config, profiles, offerings, summary?})` is the consumer boundary. `bytes` is a UTF-8 JSON Myelin envelope whose `payload` is exactly the strict request above. The entire encoded envelope must fit the 128 KiB request ceiling. Configuration, profile manifests and Cortex offerings come from the operator, independently of the envelope.

The published Myelin `taskSubjectAndType(principal, "ci-test", stack)` builds the exact subject and type. Admission requires that local subject, matching local classification, and a source in the same principal/stack. Only absent/offer distribution without a target assistant is supported. `correlation_id` must equal the signed payload's `job.correlationId`; Myelin excludes the envelope correlation annotation from signature coverage. An optional envelope deadline must equal the job deadline. Job correlation, generation and every other identity field are retained from the signed payload, never inferred from mutable extensions or economics.

Myelin validates the envelope schema and verifies every signature in the complete chain against `config.registry.file`, using its existing five-minute freshness window without an override. Unsupported envelope spec versions above 3 refuse. The first stamp must be an Ed25519 signature by the configured issuer itself; a hub attestation of that identity is insufficient. Later valid transit stamps do not change the origin authorized by Ranger. `originator` must be absent or name that issuer with `adapter-resolved` attribution; delegated and federated attribution refuse.

Reuse the operator context across requests to reuse its loaded registry. Each authentication performs an asynchronous file metadata check; a changed path, file identity, size, modification time or change time reloads through Myelin's public loader. A metadata or reload failure discards that context's cache and refuses authentication without using an older registry. Cryptographic verification and signature freshness checks still run on every request.

The origin's explicit permission entry binds repository, profile ID and profile digest. The selected operator profile additionally binds lock, runtime image and platform through `validateRemoteTestJob`. The public `admitOfferedDispatch` evaluator from the pinned Cortex commit receives capability `ci-test`, the operator offerings, local arrival scope and enforced signing posture. Its local admission never substitutes for signature verification or Ranger permission. Agent `trust[]` supplies no capability permission. Expired jobs refuse before admission returns.

Success returns a detached, frozen `request` and frozen `provenance`: origin issuer/actor, envelope ID, SHA-256 of the exact received envelope bytes, subject, source, authentication time and each verified stamp's identity/method/time. No registry keys or configuration are returned. Failures throw `BusAdmissionRefusal` with fixed `stage`/`code` and a fixed message. The optional summary callback receives at most one frozen `{stage, code}` per refusal; callback failure preserves the refusal. There is no payload, error-detail or configuration logging. No source restoration, execution-ledger access or executor launch occurs in this API; consumers perform those only after acceptance, with their existing generation fencing and source verification.

Operator configuration validation and profile/offering snapshot failures report `config/invalid` before envelope parsing. Sender validation failures retain their envelope, alignment or request stage.

`test/remote-test-bus-admission.test.ts` exercises this API with ephemeral real signatures, the actual SDK evaluator, a synthetic private registry, provenance mutation checks and refusal fixtures. Live bus hosting and activation remain separate work.

## SDK dependency coupling

The accepted public bus export is part of the full Cortex package pinned to Cortex commit `937676b` (see the outbox section above). Installing it also installs Cortex's application dependencies, including React, React DOM, XYFlow, Hono, Chokidar, NATS and libsodium. Ranger imports the public `@the-metafactory/cortex/bus` boundary; it does not maintain a copied admission evaluator or a private deep import.

Cortex `937676b` and Ranger both pin Myelin v0.12.0. Treat those pins as a reviewed pair: before upgrading either, check the candidate Cortex package's Myelin pin, keep Ranger's direct Myelin dependency aligned, and rerun the signed admission fixtures and public-import typecheck. A lightweight upstream bus package would remove the application dependency cost; changing Cortex packaging is outside this node.

## Exact-SHA check reporter

`ranger remote-test report-checks` (`src/remote-test/check-reporter.ts`) runs Ranger-side and turns each terminal receipt in the outbox into one GitHub check run named `clawbox/<profile id>` on the receipt's own commit. It is the only holder of the dedicated checks-only GitHub App key (`checks:write`, `metadata:read`). The executor and test containers never hold a GitHub credential. The check is additive and never required.

- Conclusions: `passed` is the only `success`. `test_failed` is `failure`; `infra_failed` and `rejected` are `neutral`; `timed_out` and `cancelled` keep their own GitHub conclusions. The summary carries the outcome, the receipt digest, the profile and the commit, tree, lock and image identities. It carries no log, path or executor identity.
- Superseded head: the machine account (not the App) lists the open pull requests that contain the commit. If there are some and none is headed at the commit, the check on the old commit concludes `neutral`. Nothing is written on the new head.
- Fail closed: the stored job must validate, the exported receipt bytes must hash to the digest the outbox recorded, and every identity field of the receipt must equal the submitted job. An unreadable, unauthenticated, withheld, mismatched or missing receipt writes no check and is recorded as a refusal in the reporter's own private `check-reporter.sqlite` under `checkReporter.stateRoot`.
- Replay: a receipt is acknowledged only after its check run is written and recorded. A GitHub, token or storage failure writes no acknowledgement, the command exits non-zero, and the next run replays the receipt. Delivering a receipt again (`--job <id>`) finds the check run by repository, commit and check name and updates it.
- Configuration: the App id, key file, installation ids per owner, outbox paths and state root live only in the operator-local `checkReporter` block of `ranger.yaml` (see `ranger.example.yaml`). Without the block the command exits non-zero. The key file must be operator-owned with no group or world access.

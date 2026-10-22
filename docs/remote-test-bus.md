# Private ci-test bus contracts

The [settled bus boundary](https://github.com/the-metafactory/ranger/issues/146) hosts a Ranger bus worker beside the private executor, with the private Clawbox stack owning the request queue and result storage. Only configured Ranger issuers acting as themselves may invoke reviewed repository/profile bindings. This build adds only the strict shapes in `src/remote-test/bus-contract.ts`. It has no NATS connection, source upload, executor launch, signature verification or SDK policy, and no Ranger command loads it. Existing SSH, executor and supervisor configuration parse unchanged; `testBackend.kind` still accepts only `ssh` and `shadow`.

## Request

`validateBusRequest(bytes)` accepts one UTF-8 JSON request of at most 128 KiB. Size is checked before decoding, so an oversized payload is never parsed:

```json
{ "version": 1, "job": <V1 RemoteTestJob>, "source": { "bundleDigest": "sha256:<hex>", "bundleBytes": <positive integer> } }
```

The job is the existing V1 schema with every identity field. `source.bundleDigest` must equal `job.bundleDigest`. `bundleBytes` is a positive safe integer within the existing 64 MiB receiver bundle ceiling. The source reference is a content digest, never a path, URL or command. Unknown fields at any level refuse. Refusals carry a fixed code (`too_large`, `malformed`, `invalid`, `digest_mismatch`) and never echo request content. Bundle bytes, logs and credentials stay off the bus.

## Operator configuration

`validateBusConfig(input)` checks private operator JSON. [`examples/remote-test-bus-config.json`](examples/remote-test-bus-config.json) is an inert skeleton that fails validation until every `REPLACE_*` value is substituted outside Git. Every field is required and nothing has a default:

- `target.domain` and `target.account`: the explicit JetStream domain and account. The default domain is never inferred.
- `routing`: `classification` is fixed to `local`, plus principal and stack subject tokens. Federated and public routing are unsupported.
- `streams.request.stream`, `streams.request.durable` and `streams.result.stream`: exact names. The request and result streams must differ. Wildcards, dots and whitespace refuse.
- `transport.servers`: fixed `nats://host:port` or `tls://host:port` locators without credentials, paths or queries. `transport.credentialsFile` is a normalized absolute operator path.
- `ssh.configFile`: the existing reviewed SSH JSON that source staging reuses.
- `execution`: `maxAckPending` and `maxConcurrentJobs` are fixed to 1. `ackWaitSeconds`, `progressIntervalSeconds` (less than the ack wait) and `maxDeliver` are bounded.
- `registry.file`: the private Myelin identity registry.
- `issuers`: at least one concrete issuer DID, each with at least one exact `{repositoryId, profileId, profileDigest}` binding. Missing, empty, duplicate or wildcard entries fail closed.

`authorizeBusProducer(config, {issuer, actor}, job)` finds the operator binding for an origin issuer that the caller has already verified. The actor must be absent or equal to the issuer. Delegated distinct actors refuse with `actor_mismatch`. The job's repository, profile ID and profile digest must match one binding of that issuer exactly, otherwise the call refuses with `unauthorized`. Permissions come only from the operator configuration and are never derived from job fields. The function does no cryptographic verification; Myelin signature verification and the Cortex capability gate belong to the later admission build.

Keep the substituted configuration, issuer identities, endpoints, credentials and registry in operator-owned locations outside all Git repositories. Activation, credential issuance and gate promotion remain separate operator checkpoints.

## Terminal lifecycle outbox

`src/remote-test/bus-outbox.ts` retains terminal lifecycle events in a private SQLite store (`outbox.sqlite`, mode 0600) under an operator-owned outbox root that must be separate from the executor jobs root. It consumes the published Cortex bus SDK (`@the-metafactory/cortex/bus`): the dispatch lifecycle builders and `publishDurable`. It opens no connection itself; the caller passes a runtime or any object with `publishDurable`. It never admits, completes or executes a job.

The dependency is pinned to Cortex commit `937676b`, which is the accepted `v6.17.1` plus the public export of `MyelinDurablePublishError` and the durable option/ack types (cortex#2711). No release contains that export yet; move the pin to the next release tag when one exists.

- `enqueueTerminal(job)` accepts only an authoritative receipt: the job must have a ledger row with a terminal, non-revoked outcome, the retained receipt must exist, and its bytes must equal the ledger receipt. Rowless, revoked, unfinished, absent or conflicting evidence throws `BusOutboxRefusal` and queues nothing. The receipt is then exported to `receipts/<jobId>.json` through the existing atomic exporter, and one event is queued in a single transaction. Repeating the call after a crash returns the same event.
- `passed` maps to `dispatch.task.completed`; `test_failed`, `infra_failed` and `rejected` map to `dispatch.task.failed`; `timed_out` and `cancelled` map to `dispatch.task.aborted`. The summary carries the status, correlation id, the `ci-test` capability and an opaque `sha256` of the exported receipt. It carries no log, source, path or credential.
- `drain(publisher)` reads pending events in bounded rowid batches (indexed by state). It re-verifies each event against the retained receipt and current ledger immediately before its publish call, so a success that was revoked or superseded before that check is withheld and never published. A revocation that lands after the check, while the publish call is in flight, cannot be undone: the event is already on the wire. A withheld refusal is replaced by the job's terminal event if the job was admitted and finished afterwards. It then calls `publishDurable` with the configured result stream. The envelope is stored once, so a retry sends the same event id (the JetStream `Nats-Msg-Id`) and payload, and the runtime signs it again. An event is marked delivered only when the PubAck names the configured stream and domain. A timeout, a publisher error, a mismatched acknowledgement or a crash before the local commit leaves the event pending, stops the drain and reports no request-ack eligibility (`ackEligible(jobId)` stays false). A crash after the PubAck replays the same event; the job is not run again.
- `enqueueRefusal({ job, origin, code })` retains a separate provenance record for a structurally valid job that an authorized issuer sent and that was refused before admission, and queues a `rejected` failed lifecycle. It requires the issuer binding from `authorizeBusProducer`, refuses a job that already has a ledger row or receipt, and writes neither. Exact receipt lookup for that job stays empty.
- A lifecycle message is never read back as evidence. Delivery state never changes the ledger or promotes a remote result to gate authority.

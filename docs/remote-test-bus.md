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

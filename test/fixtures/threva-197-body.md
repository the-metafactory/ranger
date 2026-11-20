## Deliverable

Nothing ships. This node exists to test ranger's VSA claim gate (program criterion ISC-9): it is a build node created after `VSA.md` was added to this repo, and it cites no criterion from it on purpose. Ranger must refuse to claim it and journal the refusal. It is closed as not planned once the refusal is recorded.

## Acceptance criteria

- Given ranger's walk reaches this node, when it tries to claim it, then the claim is refused by the VSA gate and a `refused` event is journaled.

## Out of scope

- Any change to the repository. A worker that is somehow started on this node stops and changes nothing.

<!-- soma:work-graph-node
{
  "autonomy": "auto",
  "kind": "build",
  "checkpointId": "isc9-gate-refusal-probe",
  "probes": [
    {
      "type": "artifact-exists",
      "path": "VSA.md",
      "atRef": "main"
    }
  ],
  "completion": {
    "receiptCommentId": "7028265902",
    "checkpointId": "isc9-gate-refusal-probe",
    "autonomy": "auto",
    "closer": "ivy-agent",
    "closedAt": "2026-11-20T02:16:44.277Z",
    "gatedNodeHash": "2ff0da276cd153fe4ffbb95a1ede20cb320e0d4f18c07f7effcd44b6ea4afb39",
    "autoProbeKeys": [
      "{\"type\":\"artifact-exists\",\"path\":\"VSA.md\",\"atRef\":\"main\"}"
    ]
  }
}
-->

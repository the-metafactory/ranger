# Supervisor test backend

Maps without `testBackend` keep their existing local install, tests, clean-tree
checks, adoption and busy-host retry. An operator may explicitly select SSH for
eligible non-graphical Linux ARM64 tests by adding this map configuration:

```yaml
testBackend:
  kind: ssh
  configFile: /absolute/operator-private/ssh.json
  stateRoot: /absolute/operator-private/supervisor-tests
  profileId: reviewed-profile-v1
  lockFile: bun.lock
  deadlineSeconds: 660
```

These are placeholder paths. Private endpoints, executable paths, identities,
credentials and actual profile manifests live in the operator-local SSH JSON
described in [SSH submission and receipt lookup](remote-test-ssh.md). The state
root must already exist, be owned by the operator, have mode 0700 and be outside
Git. SSH configuration and state paths are never added to the coding worker's
environment or prompt. The existing worker's credential allow-list and temporary
journal remain unchanged.

The selected reviewed profile replaces the map's eligible install/test commands;
the operator must approve that profile's coverage of `commands.test`. Ranger does
not translate shell text into remote argv. `commands.test` remains required as
the map's declared verification intent. The lock file must match the reviewed
profile's SHA-256 before SSH. Unsupported platforms, missing profiles and changed
locks fail closed. Changes to a committed lock require a separately approved
updated profile, never an automatic digest or command rewrite.

The supervisor submits the clean committed HEAD, including unpushed work, with
its exact tree/bundle identity, current worker generation and stable map/node
correlation UUID. The saved private job precedes transport. A directory keyed by
source/profile/generation identifies each attempt. An existing attempt can only
query status; transport uncertainty, busy/interrupted/absent work, revoked or
stale receipts and storage failures neither resubmit nor run local fallback.
An incomplete attempt directory without a saved job refuses recovery; inspect
it privately rather than guessing whether a submission happened.

Supervisor tests, adoption and fix/base-merge passes share the backend seam.
SSH opt-in suppresses their local install/test/busy-host retry calls. Remote
adoption certifies the committed source directly and needs no local cleanup or
reinstall. The worker is told to leave the map's install/test commands to the
supervisor. An unsuccessful remote adoption stops before spawning another coding
session. Local execution retains its existing adoption and retry behavior.

The graphical `commands.probe` tier, capture/view commands and merge-base probe
comparison retain their separate local authority and dependency installs. SSH
opt-in does not certify those checks or move coding/review sessions. Opting a map
into remote tests may leave its worktree without installed dependencies; the
operator must provide the local dependencies its separate graphical tier needs.
No graphical result is inferred from an ARM64 receipt.

Only a validated terminal receipt pointer and status reach the internal journal;
raw remote output, endpoint configuration and credentials do not. Before push,
Ranger rechecks the current generation, unchanged HEAD/clean source/index,
persisted receipt attribution and freshness, Git trust and closing-keyword rules.
It pushes the tested commit explicitly. Review, CI and all existing merge gates
remain independent. The first live opt-in and promotion require the separate
provisioning/pilot operator checkpoint; this code does not switch any live map.

The private state directory retains exact jobs and receipt pointers for operator
lookup after a crash. It is not a public artifact store. Keep evidence during an
uncertain attempt; clean completed local attempt directories only through an
operator's retention procedure. Tests use temporary Git repositories, injected
SSH transport and injected supervisor backends; they do not provision a host or
establish live resource enforcement.

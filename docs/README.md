# Ranger documentation

These pages describe how ranger behaves and how to operate it. [The ranger design document](../design/ranger-design.md) records why it is built this way.

## Operate ranger

- [Configuration](configuration.md): how ranger finds `ranger.yaml`, what each section is for, the credentials it names, the tick run ledger, and journal migrations.
- [Scout](scout.md): the read-only digest, its token check, and its route classes.
- [The walk](walk.md): what a tick claims, the research and implement lanes, and how proposals are ratified or vetoed.
- [Lanes and the resume queue](lanes.md): the visual and headless lanes, drains, host load, queued resumes, and probe requeues.
- [Observation intake](intake.md): how the principal's Discord mentions become graph nodes.
- [Scheduled jobs](jobs.md): skills that ranger runs on a lane, outside the graph.
- [The dashboard](serve.md): `ranger serve`, the verbs it runs, and its launchd job.
- [Repairing a journal migrated by foreign code](journal-repair.md): the runbook for a journal that a branch's code migrated.

## GitLab maps

- [GitLab read gate](gitlab-read-gate.md): the qualified read-token prefixes that GitLab maps require.
- [GitLab forge reads](gitlab-port-reads.md): `GitLabReadPort` and its read methods.
- [GitLab forge writes](gitlab-port-writes.md): `GitLabPort` and its write methods.
- [GitLab lanes](gitlab-lanes.md): how the walk, implement, and research lanes run a `gitlab:` map.
- [GitLab squash merge and rebase](gitlab-merge.md): how ranger rebases and squash-merges on a project with `rebase_merge`.

## Remote test execution

The local test backend is the default. These pages cover the operator-only `remote-test` tooling.

- [Private capacity baseline](remote-test-baseline.md): `remote-test baseline`.
- [Reviewed Bun profiles](remote-test-profiles.md): building a reviewed profile manifest.
- [One-shot remote-test execution](remote-test-executor.md): `remote-test execute`.
- [SSH submission and receipt lookup](remote-test-ssh.md): `remote-test run`.
- [Supervisor test backend](remote-test-supervisor.md): selecting SSH for a map's tests with `testBackend`.
- [Remote-test shadow reporting](remote-test-shadow.md): `testBackend.kind: shadow`.
- [Accepted private shadow pilot](remote-test-pilot.md): the pilot decision and its evidence.
- [Private ci-test bus runbook and contracts](remote-test-bus.md): the bus worker, the check reporter, and the PR head submitter.

## Records

- [Live validation, 2026-08-17](live-validation-2026-08-17.md): evidence for the walker and escalation desk increments.
- [crisis-simulator's map root on GÉANT](crisis-simulator-map-root.md): the record for node #98.

# Run a Studio thinking job

Configure `ivy-think` in `ranger.yaml`. The Studio read URL must belong to the same configured directory. Ranger reads current area policies from Cortex before thinking and before writing. Unknown areas stay local; an unavailable or mismatched Studio defers the run.

```yaml
jobs:
  - name: ivy-think
    skill: ivy-think
    lane: headless
    wallClockMin: 10
    cwd: ~/work/threads
    substrates: [codex, pi]
    requireResult: true
    studio:
      dir: ~/work/threads
      url: http://127.0.0.1:8767/api/desk/studio
      localProvider: local-model
      localEndpoint: http://127.0.0.1:11434/v1
      dailyRuns:
        local: 5
        cloud: 5
```

Set `substrates.pi.provider` and `substrates.pi.model` to the local provider and model. The provider's `baseUrl` in Pi's `models.json` must match `studio.localEndpoint`. Configure this endpoint only for a model deployment you trust to satisfy local policy. Ranger never substitutes Claude or Codex for a local run.

Enqueue one thread through the existing job supervisor:

```sh
ranger job enqueue ivy-think --param thread=example --param trigger="New material"
ranger job enqueue ivy-think --param thread=example --param trigger="Think now" --param mode=red-team
ranger job list
```

Modes are `think`, `grill`, `other-side`, `red-team`, `first-principles`, and `persona:<name>`. Supplying `mode` represents a person's explicit request. The overseer must omit it for automatic work. A requested mode bypasses the once-per-thread limit, but it still consumes the policy budget.

Daily limits use UTC dates and count started attempts, including failed attempts. A run that cannot start remains queued with a reason. Ranger's next tick reevaluates it; a spent daily budget becomes available on the next UTC date. `ranger job list` shows the parameters, effective policy, substrate, and any deferral reason.

Models receive the thread's question, stand, existing notes, responses, and Material entries as data. They do not fetch linked documents. Pi runs without tools, extensions, MCP, skills, or context discovery. Claude runs with tools and MCP disabled. Codex ignores user config, rules, and project documents. Its shell, execution, plugin, browsing, delegation, and image tools are disabled; it also uses a read-only sandbox. Studio sessions discard inherited Codex sandbox-control variables. Ranger validates the model's JSON and writes the note itself. A proposed stand stays a proposal, and the model can propose at most three ideas.

Every write takes the same `studio-write.lock` directory inside the repository's git directory as Cortex. Its `owner.json` records the process and time. A held lock refuses a concurrent write. Ranger rechecks the live policies, HEAD, dirty tree, and complete thread text after the model returns. The final content comparison and file write are synchronous, after all asynchronous preparation and git lookups. Detected changes are preserved and fail the run with a diagnostic in the job log; enqueue a new run after resolving the change. External editors must honor the mutex for full serialization: a separate process that ignores it can still race individual filesystem calls.

After an interrupted process, inspect `owner.json` and verify its process has stopped before removing a stale lock manually. Neither Ranger nor Cortex removes another process's lock automatically. Each successful append creates a git commit with a `Studio-Think-Run` trailer and returns its commit reference in the run record.

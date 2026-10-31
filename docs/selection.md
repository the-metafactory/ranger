# Parser substrate selection

`ranger select-substrate --config <path>` reads one version 1 JSON request from stdin and writes one JSON result to stdout. Diagnostics go to stderr. The input must end within five seconds and contain at most 16,384 bytes.

The operator opts providers into this command through `ranger.yaml`:

```yaml
selection:
  substrates: [claude, codex, pi]
```

An absent `selection` block or an empty list enables no providers. This list declares the configured providers for the selection interface. Worker and job routing do not read it. Existing `substrates` settings supply quota thresholds, freshness limits, and provider models. Selection does not check provider executable availability, credentials, or parser support. The caller declares parser capability and owns dispatch failures.

The request has four required fields. Unknown fields, unknown provider names, and unsupported versions are rejected:

```json
{"version":1,"permitted":["claude","codex","pi"],"attempted":[],"parserCapable":["claude","codex"]}
```

`permitted` contains the providers allowed for this request, including any area restrictions. `attempted` contains providers already tried within the same request. `parserCapable` contains providers whose caller-owned adapter can enforce the parser contract, including disabled tools. Each list contains at most three entries. All three restrictions apply to every provider, including Pi.

Ranger intersects these lists with `selection.substrates` before refreshing quota. It refreshes missing or stale readings only for remaining Claude and Codex candidates, using its existing quota readers. Claude refresh runs the existing Haiku quota probe; Codex refresh starts `codex app-server` to read rate limits. These readers have existing timeouts of 60 and 30 seconds respectively and run concurrently. Failed refresh leaves the missing or stale reading ineligible. Pi has no quota reader.

The existing policy selects the eligible strong provider with the most headroom, applying its freshness, caps, and time-decaying reserves. Pi is selected only if no strong provider qualifies and Pi survives every restriction. Selection creates no worker, dispatches no job, and makes no parser request. Quota readings can be persisted in the configured journal.

A successful selection has this shape:

```json
{"version":1,"kind":"selected","substrate":"codex","reason":"most-headroom","candidates":[{"substrate":"claude","reason":"capped"},{"substrate":"codex","reason":"eligible"},{"substrate":"pi","reason":"parser-incapable"}]}
```

The selected reason is `most-headroom` or `pi-fallback`. Every valid selection result includes a candidate entry for each provider. Candidate reasons are `not-configured`, `not-permitted`, `already-attempted`, `parser-incapable`, `missing-reading`, `stale-reading`, `capped`, `quota-ineligible`, or `eligible`. `quota-ineligible` includes missing quota windows and exhausted reserve headroom, as judged by Ranger's policy.

No eligible candidate returns `{"version":1,"kind":"unavailable","reason":"no-eligible-substrate","candidates":[...]}`. Missing or invalid configuration, or an unusable journal, returns `integration-unavailable` with an empty candidate list. Both are valid results with exit code 0. An invalid request returns `invalid-request` with an empty candidate list and exit code 2. Invalid command-line options use Commander's normal nonzero exit and stderr diagnostic.

The caller invokes the selected provider, validates its output, and preserves its confirmation gates. After a dispatch quota failure, the caller adds that provider to `attempted` before reselection. The selector does not retry or execute the request.

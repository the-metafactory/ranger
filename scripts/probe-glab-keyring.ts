#!/usr/bin/env bun
import { glabConfigEnv } from "../src/glab-config-dir.ts";
import { runCmd } from "../src/exec.ts";
import { parseGlabResponse } from "../src/glab-transport.ts";

/** Operator-only probe: run under the principal's Mac login, never in CI. */
export async function probeGlabKeyring(host: string, runner: typeof runCmd = runCmd): Promise<number> {
  const gated = glabConfigEnv(host, "");
  try {
    const result = await runner("glab", ["api", "user", "--hostname", host, "--include"], {
      env: gated.env, timeoutMs: 15_000,
    });
    const { status } = parseGlabResponse(result);
    // A few glab error paths omit included headers, but report the HTTP
    // code in stderr. Accept only glab's explicit HTTP 401 marker.
    const unauthorized = status === 401 || (status === 0 && /\(401\)|\bHTTP 401\b/.test(result.stderr));
    if (result.code !== 0 && unauthorized) {
      console.log(`PASS ${host}: empty config token returned HTTP 401; no keyring fallback`);
      return 0;
    }
    console.error(`FAIL ${host}: expected HTTP 401, got HTTP ${status || "unknown"}, exit ${result.code}; stop and escalate node #122`);
    return 1;
  } finally {
    gated.cleanup();
  }
}

if (import.meta.main) {
  const host = process.argv[2];
  if (!host || process.argv.length !== 3 || process.env.CI) {
    console.error("Usage (principal's Mac only, outside CI): bun scripts/probe-glab-keyring.ts <host>");
    process.exitCode = 1;
  } else {
    try { process.exitCode = await probeGlabKeyring(host); }
    catch { console.error("FAIL: keyring probe could not complete; stop and escalate node #122"); process.exitCode = 1; }
  }
}

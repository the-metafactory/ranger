import type { RunResult } from "./exec.ts";

/** glab --include prints the HTTP status, headers, then a JSON body. */
export function parseGlabResponse(result: RunResult): { status: number; body: unknown; headers: Record<string, string> } {
  const match = /^HTTP\/\S+\s+(\d{3})[^\r\n]*\r?\n/.exec(result.stdout);
  const status = match === null ? 0 : Number(match[1]);
  const boundary = result.stdout.search(/\r?\n\r?\n/);
  const headers: Record<string, string> = Object.create(null);
  let body: unknown;
  if (boundary >= 0) {
    for (const line of result.stdout.slice(0, boundary).split(/\r?\n/).slice(1)) {
      const separator = line.indexOf(":");
      if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    try { body = JSON.parse(result.stdout.slice(boundary).trim()); } catch { /* caller fails closed */ }
  }
  return { status, body, headers };
}

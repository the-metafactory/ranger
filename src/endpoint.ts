import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RangerConfig } from "./config.ts";
import type { SubstrateName } from "./store/schema.ts";
import { OperationFailure } from "./operation-outcome.ts";

export type EndpointProbe = (url: string) => Promise<boolean>;
export type EndpointLookup = (config: RangerConfig, substrate: SubstrateName, explicit?: string) => string | null;
export const probeEndpoint: EndpointProbe = async url => {
 try {
  const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2_000), redirect: "manual" });
  await response.body?.cancel();
  return true;
 } catch { return false; }
};

export function modelEndpoint(config: RangerConfig, substrate: SubstrateName, explicit?: string, metadata?: unknown): string | null {
 if (explicit !== undefined) return explicit;
 const declared = config.substrates[substrate].reachable;
 if (declared !== undefined) return declared;
 if (substrate !== "pi") return null;
 try {
  const model: unknown = metadata ?? JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"));
  const base = (model as { providers?: Record<string, { baseUrl?: unknown }> }).providers?.[config.substrates.pi.provider]?.baseUrl;
  if (typeof base !== "string") throw new Error("provider endpoint missing");
  const url = new URL(base.endsWith("/") ? `${base}models` : `${base}/models`);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid provider protocol");
  return url.toString();
 } catch {
  throw new OperationFailure({ kind: "unknown", operation: "model-endpoint", target: config.substrates.pi.provider,
   evidence: `Pi provider ${config.substrates.pi.provider} has no unambiguous endpoint mapping`, action: "configure substrates.pi.reachable or the selected provider baseUrl before resuming" });
 }
}

export function cachedProbe(probe: EndpointProbe = probeEndpoint): EndpointProbe {
 const pending = new Map<string, Promise<boolean>>();
 return url => {
  let result = pending.get(url);
  if (result === undefined) { result = Promise.resolve().then(() => probe(url)).catch(() => false); pending.set(url, result); }
  return result;
 };
}

export async function requireEndpoint(config: RangerConfig, substrate: SubstrateName, explicit?: string,
 probe: EndpointProbe = probeEndpoint, lookup: EndpointLookup = modelEndpoint): Promise<void> {
 const endpoint = lookup(config, substrate, explicit);
 if (endpoint === null || await probe(endpoint)) return;
 endpointUnavailable(endpoint, substrate);
}

function endpointUnavailable(endpoint: string, substrate: string): never {
 const target = new URL(endpoint).origin;
 throw new OperationFailure({ kind: "dependency", operation: "model-endpoint", target,
  evidence: `model endpoint unreachable for ${substrate} (${target})`, action: "restore endpoint connectivity, then retry" });
}

export async function requireReachable(endpoint: string | undefined, probe: EndpointProbe = probeEndpoint): Promise<void> {
 if (endpoint === undefined || await probe(endpoint)) return;
 endpointUnavailable(endpoint, "declared worker dependency");
}

export async function firstReachableSubstrate(config: RangerConfig, candidates: readonly SubstrateName[], explicit: string | undefined,
 probe: EndpointProbe = probeEndpoint, lookup: EndpointLookup = modelEndpoint): Promise<SubstrateName> {
 let last: unknown = new OperationFailure({ kind: "unknown", operation: "model-endpoint", evidence: "no eligible endpoint", action: "configure an eligible endpoint" });
 for (const substrate of candidates) {
  try { await requireEndpoint(config, substrate, explicit, probe, lookup); return substrate; }
  catch (error) { last = error; }
 }
 throw last;
}

import { z } from "zod";
import type { RangerConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import { SUBSTRATE_NAMES, type SubstrateName } from "./store/schema.ts";
import { eligibleStrong, isCappedAt, isFresh, STRONG_SUBSTRATES, type SelectionInput } from "./substrate-policy.ts";
import { ensureFreshReading, type SubstrateReaders } from "./substrate.ts";

const Substrates = z.array(z.enum(SUBSTRATE_NAMES)).max(SUBSTRATE_NAMES.length);

export const SelectionRequestSchema = z.object({
 version: z.literal(1),
 permitted: Substrates,
 attempted: Substrates,
 parserCapable: Substrates,
}).strict();

export type SelectionRequest = z.infer<typeof SelectionRequestSchema>;

interface Candidate {
 substrate: SubstrateName;
 reason: "not-configured" | "not-permitted" | "already-attempted" | "parser-incapable" |
  "missing-reading" | "stale-reading" | "capped" | "quota-ineligible" | "eligible";
}

export type SelectionResult = { version: 1; candidates: Candidate[] } & (
 | { kind: "selected"; substrate: SubstrateName; reason: "most-headroom" | "pi-fallback" }
 | { kind: "unavailable"; reason: "no-eligible-substrate" | "invalid-request" | "integration-unavailable" }
);

function restriction(name: SubstrateName, configured: SubstrateName[], request: SelectionRequest): Candidate["reason"] | null {
 if (!configured.includes(name)) return "not-configured";
 if (!request.permitted.includes(name)) return "not-permitted";
 if (request.attempted.includes(name)) return "already-attempted";
 if (!request.parserCapable.includes(name)) return "parser-incapable";
 return null;
}

function decide(request: SelectionRequest, configured: SubstrateName[], input: SelectionInput): SelectionResult {
 const permitted = SUBSTRATE_NAMES.filter(name => restriction(name, configured, request) === null);
 const eligible = eligibleStrong({ ...input, readings: input.readings.filter(reading => permitted.includes(reading.substrate)) });
 const candidates = SUBSTRATE_NAMES.map((substrate): Candidate => {
  const restricted = restriction(substrate, configured, request);
  if (restricted !== null) return { substrate, reason: restricted };
  if (substrate === "pi" || eligible.some(candidate => candidate.name === substrate)) return { substrate, reason: "eligible" };
  const reading = input.readings.find(reading => reading.substrate === substrate);
  if (reading === undefined) return { substrate, reason: "missing-reading" };
  if (!isFresh(reading, input.config, input.now)) return { substrate, reason: "stale-reading" };
  if (isCappedAt(reading, input.now)) return { substrate, reason: "capped" };
  return { substrate, reason: "quota-ineligible" };
 });
 const selected = eligible.at(0);
 if (selected !== undefined) return { version: 1, kind: "selected", substrate: selected.name, reason: "most-headroom", candidates };
 if (permitted.includes("pi")) return { version: 1, kind: "selected", substrate: "pi", reason: "pi-fallback", candidates };
 return { version: 1, kind: "unavailable", reason: "no-eligible-substrate", candidates };
}

export async function selectParserSubstrate(
 request: SelectionRequest,
 config: RangerConfig,
 journal: Journal,
 readers?: SubstrateReaders,
): Promise<SelectionResult> {
 const configured = config.selection?.substrates ?? [];
 await Promise.all(STRONG_SUBSTRATES
  .filter(name => restriction(name, configured, request) === null)
  .map(name => ensureFreshReading(name, journal, config.substrates, new Date(), readers)));
 return decide(request, configured, { readings: journal.listSubstrateReadings(), now: new Date(), config: config.substrates });
}

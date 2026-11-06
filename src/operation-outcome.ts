import { z } from "zod";
import type { RunResult } from "./exec.ts";

export type OutcomeKind = "success" | "code" | "infrastructure" | "dependency" | "human" | "unknown";
export interface OperationOutcome {
 kind: OutcomeKind;
 operation: string;
 target?: string;
 evidence: string;
 action: string;
}

const failureSchema = z.object({ kind: z.enum(["code", "infrastructure", "dependency", "human", "unknown"]), operation: z.string(), target: z.string().optional(), evidence: z.string(), action: z.string() });

export class OperationFailure extends Error {
 readonly outcome: OperationOutcome;
 constructor(outcome: unknown) {
  const parsed = failureSchema.safeParse(outcome);
  const safe: OperationOutcome = parsed.success ? parsed.data : { kind: "unknown", operation: "operation-result", evidence: "malformed or non-failure operation outcome", action: "inspect the malformed result before resuming" };
  super(safe.evidence);
  this.outcome = safe;
  this.name = "OperationFailure";
 }
}

export function processOutcome(result: Pick<RunResult, "code" | "timedOut">, operation: string, target?: string): OperationOutcome {
 const kind = result.timedOut ? "infrastructure" : result.code === 0 ? "success" : result.code < 0 ? "unknown" : "code";
 return { kind, operation, target, evidence: result.timedOut ? `${operation} timed out` : `${operation} exited ${result.code}`,
  action: kind === "code" ? "repair the failing code and resume" : "inspect the operation evidence and resume" };
}

export function failureOutcome(error: unknown, operation = "supervisor"): OperationOutcome {
 if (error instanceof OperationFailure) return error.outcome;
 return { kind: "unknown", operation, evidence: error instanceof Error ? error.message : String(error), action: "inspect the unknown result before resuming" };
}

export function workerOutcome(result: RunResult, operation: string, source: "model" | "command"): OperationOutcome {
 if (source === "model" && result.outcome !== undefined && result.code !== 0) return new OperationFailure(result.outcome).outcome;
 const basic = processOutcome(result, operation);
 return source === "model" && basic.kind === "code" ? { ...basic, kind: "unknown", action: "inspect the model transport or protocol failure before resuming" } : basic;
}

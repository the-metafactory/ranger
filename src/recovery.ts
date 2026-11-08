import { z } from "zod";
import type { Journal } from "./journal.ts";
import type { OperationOutcome } from "./operation-outcome.ts";

const pendingSchema = z.object({ operation: z.string(), target: z.string(), kind: z.enum(["infrastructure", "dependency", "human", "unknown"]), evidence: z.string(), action: z.string() });
const recoverySchema = z.object({
 pending: z.array(pendingSchema),
 key: z.string(), scope: z.string(), operation: z.string(), target: z.string(),
 kind: z.enum(["infrastructure", "dependency", "human", "unknown"]),
 attempts: z.number().int().nonnegative(), limit: z.number().int().positive(),
 status: z.enum(["waiting", "reserved", "exhausted", "complete"]),
 nextEligibleAt: z.string().nullable(), evidence: z.string(), action: z.string(),
});
export type RecoveryState = z.infer<typeof recoverySchema>;
export type RecoveryOwner = { nodeId: string; repo: string; generation: number } | { jobRunId: number; status: "queued" | "running" | "succeeded" | "failed"; pid: number | null };
export const RECOVERY_LIMIT = 3;
export const RECOVERY_BACKOFF_MS = [60_000, 300_000, 900_000];
export const nodeRecoveryScope = (repo: string, nodeId: string) => `node:${repo}#${nodeId}`;
export const jobRecoveryScope = (runId: number) => `job:${runId}`;
const pointer = (scope: string) => `recovery-active:${scope}`;
const stateKey = (scope: string) => `recovery:${JSON.stringify([scope, "episode", ""])}`;

export function activeRecovery(journal: Journal, scope: string): RecoveryState | null {
 const key = journal.getHealth(pointer(scope));
 if (key === null) return null;
 const raw = journal.getHealth(key);
 if (raw === null) throw new Error(`recovery state missing for ${scope}; operator intervention required`);
 try { return recoverySchema.parse(JSON.parse(raw)); }
 catch {
  const pending = [{ kind: "unknown" as const, operation: "recovery-journal", target: "", evidence: "persisted recovery state is malformed", action: "inspect the journal and explicitly reset recovery after intervention" }];
  return { ...pending[0], pending, key, scope, attempts: 0, limit: RECOVERY_LIMIT, status: "exhausted", nextEligibleAt: null };
 }
}

export function recoveryReason(state: RecoveryState): string {
 return `${state.kind} recovery ${state.attempts}/${state.limit}${state.status === "exhausted" ? " exhausted" : state.nextEligibleAt === null ? "" : `; next retry ${state.nextEligibleAt}`}; ${state.action}; evidence: ${state.evidence}`;
}

export function recoveryHold(journal: Journal, scope: string, now = new Date()): string | null {
 const state = activeRecovery(journal, scope);
 if (state === null || state.status === "complete") return null;
 if (state.status === "exhausted" || state.kind === "human" || state.kind === "unknown" ||
  (state.nextEligibleAt !== null && Date.parse(state.nextEligibleAt) > now.getTime())) return recoveryReason(state);
 return null;
}

function nextEligibleAt(now: Date, attemptsSpent: number): string {
 const backoff = RECOVERY_BACKOFF_MS[Math.min(Math.max(0, attemptsSpent - 1), RECOVERY_BACKOFF_MS.length - 1)];
 return new Date(now.getTime() + backoff).toISOString();
}

export function recordRecovery(journal: Journal, scope: string, outcome: OperationOutcome, options: { now?: Date; owner?: RecoveryOwner; attemptLimit?: number } = {}): RecoveryState {
 const { now = new Date(), owner, attemptLimit = RECOVERY_LIMIT } = options;
 if (outcome.kind === "success" || outcome.kind === "code") throw new Error("only non-code recovery outcomes can be scheduled");
 const key = stateKey(scope);
 return journal.recoveryTransaction(owner, () => {
  const raw = journal.getHealth(key);
  const previous = raw === null ? null : recoverySchema.parse(JSON.parse(raw));
  const attempts = previous?.status === "reserved" ? previous.attempts : (previous?.status === "complete" ? 0 : previous?.attempts ?? 0) + 1;
  const limit = Math.min(attemptLimit, previous?.status === "complete" ? attemptLimit : previous?.limit ?? attemptLimit);
  const exhausted = attempts >= limit || outcome.kind === "human" || outcome.kind === "unknown";
  const pending = (previous?.status === "complete" ? [] : previous?.pending ?? []).filter(item => item.operation !== outcome.operation || item.target !== (outcome.target ?? ""));
  pending.push({ operation: outcome.operation, target: outcome.target ?? "", kind: outcome.kind as RecoveryState["kind"], evidence: outcome.evidence.slice(0, 2000), action: outcome.action });
  const state: RecoveryState = { pending, key, scope, operation: outcome.operation, target: outcome.target ?? "", kind: outcome.kind as RecoveryState["kind"],
   attempts, limit, status: exhausted ? "exhausted" : "waiting",
   nextEligibleAt: exhausted ? null : nextEligibleAt(now, attempts),
   evidence: outcome.evidence.slice(0, 2000), action: exhausted ? `${outcome.action}; explicitly reset recovery after intervention` : outcome.action };
  journal.setHealth(key, JSON.stringify(state));
  journal.setHealth(pointer(scope), key);
  return state;
 });
}

export function reserveRecovery(journal: Journal, scope: string, options: { now?: Date; owner?: RecoveryOwner } = {}): boolean {
 const { now = new Date(), owner } = options;
 return journal.recoveryTransaction(owner, () => {
  const state = activeRecovery(journal, scope);
  if (state === null || state.status === "complete") return true;
  if (recoveryHold(journal, scope, now) !== null) return false;
  if (state.attempts >= state.limit) {
   journal.setHealth(state.key, JSON.stringify({ ...state, status: "exhausted", nextEligibleAt: null,
    evidence: `${state.evidence}; interrupted recovery exhausted its reserved attempts` }));
   return false;
  }
  const next = { ...state, attempts: state.attempts + 1, status: "reserved" as const,
   nextEligibleAt: nextEligibleAt(now, state.attempts + 1) };
  journal.setHealth(state.key, JSON.stringify(next));
  return true;
 });
}

/** Give back a start's reserved attempt: the run ended on a wait, so it spent no retry. */
export function refundRecoveryReservation(journal: Journal, scope: string, options: { owner?: RecoveryOwner } = {}): void {
 journal.recoveryTransaction(options.owner, () => {
  const state = activeRecovery(journal, scope);
  if (state?.status !== "reserved") return;
  journal.setHealth(state.key, JSON.stringify({ ...state, attempts: Math.max(0, state.attempts - 1), status: "waiting", nextEligibleAt: null }));
 });
}

export function completeRecovery(journal: Journal, scope: string, options: { operation?: string; target?: string; owner?: RecoveryOwner } = {}): void {
 const { operation, target, owner } = options;
 journal.recoveryTransaction(owner, () => {
  const state = activeRecovery(journal, scope);
  if (state === null) return;
  const pending = operation === undefined ? [] : state.pending.filter(item => item.operation !== operation || item.target !== (target ?? ""));
  if (pending.length === state.pending.length && operation !== undefined) return;
  const remaining = pending.at(-1);
  journal.setHealth(state.key, JSON.stringify(remaining === undefined ? { ...state, pending, status: "complete", attempts: 0, nextEligibleAt: null } : { ...state, ...remaining, pending }));
 });
}

export function completeRecoveryChecks(journal: Journal, scope: string, checks: readonly { operation: string; target: string }[], owner?: RecoveryOwner): void {
 journal.recoveryTransaction(owner, () => {
  for (const check of checks) completeRecovery(journal, scope, { ...check, owner });
 });
}

export function resetRecovery(journal: Journal, scope: string, options: { owner?: RecoveryOwner } = {}): void {
 const { owner } = options;
 journal.recoveryTransaction(owner, () => {
  const state = activeRecovery(journal, scope);
  if (state !== null) journal.setHealth(state.key, JSON.stringify({ ...state, pending: [], attempts: 0, status: "complete", nextEligibleAt: null }));
 });
}

export function recoverablePending(journal: Journal, scope: string): boolean {
 const state = activeRecovery(journal, scope);
 return state !== null && state.status !== "complete" && state.status !== "exhausted" &&
  (state.kind === "infrastructure" || state.kind === "dependency");
}

export function activeRecoveryReason(journal: Journal, scope: string): string {
 const state = activeRecovery(journal, scope);
 return state === null ? "recovery state changed; inspect it before resuming" : recoveryReason(state);
}

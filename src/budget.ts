import type { RangerConfig } from "./config.ts";
import { runCmd } from "./exec.ts";
import { RateLimitError } from "./graph.ts";
import type { Journal } from "./journal.ts";
import { gatedEnv, isGitLabReadToken, type ResolvedToken } from "./token-gate.ts";

/**
 * The GitHub budget gate in front of every GraphQL-costing graph read.
 *
 * Ranger's read-only PATs belong to the principal, so its reads draw on the
 * same limits as the principal's own `gh`, their Claude sessions and sage.
 * Two limits matter, and only one is visible ahead of time:
 *
 * - **The hourly allowance.** `GET /rate_limit` reports it and costs nothing.
 *   Below `budget.graphqlFloor` the token gets a `floor` cooldown until the
 *   window resets, leaving the rest to the principal. REST is a separate
 *   bucket, so a `floor` cooldown still lets the frontier cache check its
 *   sentinel and serve an unchanged map.
 * - **Secondary limits** (bursts, concurrency). `/rate_limit` cannot predict
 *   them: on 2026-10-03 `gh` was refused for over half an hour while
 *   `/rate_limit` showed 0/5000 core and 8/5000 GraphQL used. So a refusal
 *   sets a `throttled` cooldown, under which the token makes NO GitHub call
 *   at all — GitHub warns that requests sent while limited can extend the
 *   limit. Consecutive throttles double it (10, 20, 40… capped at an hour)
 *   so it spans the 15-minute tick; a successful read resets it.
 *
 * Both are persisted in the journal (`health` keys `ratelimit:<token source>`),
 * so the next map in the same pass, the next lane and the next tick all see
 * them. A deferral is not an error: the read is served by a later tick.
 */

export class BudgetDeferral extends Error {
  override readonly name = "BudgetDeferral";
}

export interface GraphqlBudget {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface BudgetPolicy {
  /** Defer graph reads while fewer GraphQL points than this remain. */
  floor: number;
  /** First cooldown after a throttle; doubles per consecutive throttle. */
  cooldownMs: number;
}

/** The longest a throttled cooldown backs off to. */
export const MAX_THROTTLE_MS = 60 * 60_000;

export function budgetPolicy(config: RangerConfig): BudgetPolicy {
  return {
    floor: config.budget.graphqlFloor,
    cooldownMs: config.budget.rateLimitCooldownMin * 60_000,
  };
}

export type CooldownKind = "floor" | "throttled";

export interface Cooldown {
  kind: CooldownKind;
  until: Date;
  reason: string;
  /** Consecutive throttles — the backoff exponent. Reset by a good read. */
  strikes: number;
}

const COOLDOWN_KEY = (source: string) => `ratelimit:${source}`;

function readCooldownRecord(journal: Journal, source: string): Cooldown | null {
  const raw = journal.getHealth(COOLDOWN_KEY(source));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      kind?: CooldownKind;
      until?: string;
      reason?: string;
      strikes?: number;
    };
    const until = new Date(parsed.until ?? "");
    if (Number.isNaN(until.getTime())) return null;
    return {
      kind: parsed.kind ?? "throttled",
      until,
      reason: parsed.reason ?? "",
      strikes: parsed.strikes ?? 0,
    };
  } catch {
    return null;
  }
}

function writeCooldown(journal: Journal, source: string, c: Cooldown): void {
  journal.setHealth(
    COOLDOWN_KEY(source),
    JSON.stringify({ ...c, until: c.until.toISOString() }),
  );
}

/** The active cooldown on a token, or null once it has passed. */
export function activeCooldown(
  journal: Journal,
  source: string,
  now: Date,
): Cooldown | null {
  const record = readCooldownRecord(journal, source);
  return record !== null && record.until > now ? record : null;
}

function deferral(source: string, c: Cooldown): BudgetDeferral {
  return new BudgetDeferral(
    `graph reads on ${source} deferred until ${c.until.toISOString()} (${c.reason})`,
  );
}

/**
 * Throw a BudgetDeferral when the token is `throttled` — before ANY GitHub
 * call, the frontier cache's REST sentinel included.
 */
export function assertNotThrottled(
  journal: Journal,
  token: ResolvedToken,
  now: Date,
): void {
  const cooling = activeCooldown(journal, token.source, now);
  if (cooling?.kind === "throttled") throw deferral(token.source, cooling);
}

/**
 * The token's GraphQL allowance, from `GET /rate_limit` (free: it does not
 * count against any limit). Null when it cannot be read — the gate then
 * fails OPEN: the read it guards fails on its own if GitHub is refusing, and
 * that refusal sets the cooldown. Failing closed would let a flaky
 * `/rate_limit` stop the walk on a healthy allowance.
 */
export async function readGraphqlBudget(
  token: string,
): Promise<GraphqlBudget | null> {
  const gated = gatedEnv(token);
  try {
    const result = await runCmd(
      "gh",
      ["api", "rate_limit", "--jq", ".resources.graphql"],
      { env: gated.env, timeoutMs: 15_000 },
    );
    if (result.code !== 0) return null;
    const raw = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const { limit, remaining, reset } = raw;
    if (
      typeof limit !== "number" ||
      typeof remaining !== "number" ||
      typeof reset !== "number"
    ) {
      return null;
    }
    return { limit, remaining, resetAt: new Date(reset * 1000) };
  } catch {
    return null;
  } finally {
    gated.cleanup();
  }
}

/**
 * Throw a BudgetDeferral when this token may not spend GraphQL now: any
 * cooldown is active, or the hourly allowance is under the floor (which sets
 * a `floor` cooldown until the window resets). Returns what `/rate_limit`
 * said, so a refusal moments later need not ask again.
 */
export async function assertGraphBudget(
  journal: Journal,
  token: ResolvedToken,
  policy: BudgetPolicy,
  now: Date,
): Promise<GraphqlBudget | null> {
  const cooling = activeCooldown(journal, token.source, now);
  if (cooling !== null) throw deferral(token.source, cooling);
  const budget = await readGraphqlBudget(token.token);
  if (budget === null || budget.remaining >= policy.floor) return budget;
  const floor: Cooldown = {
    kind: "floor",
    until: budget.resetAt,
    reason: `GraphQL allowance ${budget.remaining}/${budget.limit} under the floor of ${policy.floor}`,
    strikes: readCooldownRecord(journal, token.source)?.strikes ?? 0,
  };
  writeCooldown(journal, token.source, floor);
  throw deferral(token.source, floor);
}

/**
 * Run one GraphQL-costing read under the gate. A RateLimitError from the read
 * sets a `throttled` cooldown that doubles per consecutive throttle, and
 * becomes a BudgetDeferral, so callers handle every kind of "not now" the
 * same way. A successful read clears the strikes.
 */
export async function budgetedRead<T>(
  journal: Journal,
  token: ResolvedToken,
  policy: BudgetPolicy,
  now: Date,
  read: () => Promise<T>,
): Promise<T> {
  // GitLab reads use REST and must never send their credential to GitHub's
  // budget endpoint. The GitLab read boundary still enforces its grant.
  if (isGitLabReadToken(token)) return read();
  const budget = await assertGraphBudget(journal, token, policy, now);
  let value: T;
  try {
    value = await read();
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    // The gate just read the allowance above the floor, so a refusal now is
    // a secondary limit — unless that read showed the allowance spent.
    const spent = budget !== null && budget.remaining === 0;
    const strikes = (readCooldownRecord(journal, token.source)?.strikes ?? 0) + 1;
    const backoff = Math.min(
      policy.cooldownMs * 2 ** (strikes - 1),
      MAX_THROTTLE_MS,
    );
    const throttled: Cooldown = {
      kind: "throttled",
      until: spent ? budget.resetAt : new Date(now.getTime() + backoff),
      reason: spent
        ? "GraphQL allowance spent"
        : `GitHub secondary rate limit, throttle ${strikes} in a row`,
      strikes,
    };
    writeCooldown(journal, token.source, throttled);
    throw new BudgetDeferral(
      `graph reads on ${token.source} deferred until ${throttled.until.toISOString()} (${throttled.reason}): ${error.message}`,
    );
  }
  if ((readCooldownRecord(journal, token.source)?.strikes ?? 0) > 0) {
    writeCooldown(journal, token.source, {
      kind: "throttled",
      until: new Date(0),
      reason: "cleared by a successful read",
      strikes: 0,
    });
  }
  return value;
}

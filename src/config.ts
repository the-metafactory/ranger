import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * ranger.yaml — per-run ranger configuration.
 *
 * Scout (node #12) reads the maps registry + read-only token mapping. The
 * walker (node #13) adds the walk-mode registry, the write credential mapping,
 * the bot identity, the principal-refusal gate, and the journal/worker budget.
 * Schema is provisional pending the walk-mode node (#6) and this node (#13).
 */

/** Three-tier walk mode (node #9, closed): machine-readable build authority. */
export const WALK_MODES = ["none", "research-only", "full"] as const;
export type WalkMode = (typeof WALK_MODES)[number];

const WalkModeSchema = z.enum(WALK_MODES).default("none");

/**
 * Per-map Discord escalation surface (design §5, node #7 closed): one channel
 * per run, decided individually per walk — never a global #ranger.
 * `tokenEnv` is an env var name holding the bot token (never inline);
 * `channelId` is the snowflake of the configured channel.
 */
const DiscordSchema = z.object({
 /** Env var name holding the Discord bot token (never inline). */
 tokenEnv: z.string().min(1),
 /** Discord channel snowflake for this run's escalation surface. */
 channelId: z.string().regex(/^\d+$/, "channelId must be a Discord snowflake"),
});

/** `owner/name`: the one pattern config validation and `ranger serve`'s launch check share. */
export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

const MapSchema = z.object({
 /** `owner/name` — the repo whose issues hold the work graph. */
 repo: z.string().regex(REPO_PATTERN, "repo must be owner/name"),
 /** Root node id of the orienteer map (the `orienteer:map` issue). */
 root: z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform(Number),
 /** Walk mode (node #9): what ranger may autonomously do on this map. */
 walk: WalkModeSchema,
 /** Optional per-run Discord escalation surface (node #7). */
 discord: DiscordSchema.optional(),
 /**
  * Canonical checkout dir for this repo (design §4: probes run where the
  * registry says — the canonical checkout, not the worktree). Defaults to
  * `<state.canonicalRoot>/<repo>`.
  */
 canonical: z.string().optional(),
 /**
  * Implement-lane commands (design §4, #23). The supervisor runs them in the
  * worktree under the worker's env (no machine credential): they execute
  * worker-written code. `test` is required before a `walk: full` map's
  * implement node can be claimed.
  */
 commands: z
  .object({
   /** Dependency install, run once per worktree before the worker (e.g. `bun install`). */
   install: z.string().min(1).optional(),
   /** The repo's test command; must exit 0 before ranger pushes (e.g. `bun test tests/`). */
   test: z.string().min(1).optional(),
   /**
    * A slower verification tier (e.g. browser probes) run once on the final,
    * sage-clean head before the PR is marked ready. A passing run is recorded
    * on the PR and gates the merge card. `{node}` is replaced with the
    * numeric node id — the only substitution, so no tracker text reaches it.
    */
   probe: z.string().min(1).optional(),
   /** Wall clock for one probe run, minutes. */
   probeTimeoutMin: z.number().int().positive().default(30),
  })
  .default({}),
 /**
  * Optional node allowlist: when set, the walker claims only these node ids
  * on this map. A first live run uses it to walk one acceptance node without
  * the rest of the `auto` frontier coming along.
  */
 nodes: z
  .array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]))
  .transform((ids) => ids.map(String))
  .optional(),
 /**
  * Node ids the walker never takes on this map, even when they route as
  * walkable — the inverse of `nodes`, for a map walked in full except a few
  * nodes that need the principal (e.g. work judged by ear, or a probe that
  * needs re-charting).
  */
 skip: z
  .array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]))
  .transform((ids) => ids.map(String))
  .default([]),
 /**
  * Ranger squash-merges a gate-passed PR itself (principal, 2026-10-03),
  * except for nodes labelled `ranger:needs-eye`, which keep the one-tap
  * merge card. Off by default: the merge card is the default authority.
  */
 autoMerge: z.boolean().default(false),
 /** The branch PRs target and probes resolve `atRef` against. */
 base: z.string().min(1).default("main"),
 /**
  * The principal's own checkout of this repo (#37). `ranger serve` opens an
  * interactive grilling session there. A path inside `state.canonicalRoot`
  * or this map's `canonical` — the machine account's clones — is refused by
  * `servedMaps` and the dashboard says why. Unset means no session.
  */
 localCheckout: z.string().optional(),
});

/**
 * A map `ranger serve` shows and nothing else reads (#37): no walk, no scout
 * report, no escalation cards. For a root ranger cannot walk yet — seelite
 * #460 until two maps on one repo are supported (#38).
 */
const ServeMapSchema = z.object({
 repo: z.string().regex(REPO_PATTERN, "repo must be owner/name"),
 root: z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform(Number),
 localCheckout: z.string().optional(),
});

/** `ranger serve` (#37): the local dashboard. */
const ServeSchema = z.object({
 /** Bound on 127.0.0.1 only. */
 port: z.number().int().min(1024).max(65535).default(7311),
 /**
  * Seconds between the dashboard's own GitHub reads — serve-only maps and
  * in-flight titles, one at a time. Registered maps come from the tick's
  * cache and cost nothing here. The PATs are the principal's (`budget.ts`).
  */
 refreshSec: z.number().int().min(300).default(900),
 extraMaps: z.array(ServeMapSchema).default([]),
});

const AuthSchema = z.object({
 /**
  * Repo-prefix → env var name holding a read-only fine-grained PAT.
  * Prefixes match longest-first against `map.repo`. Tokens are NEVER inlined
  * here — only the env var name that holds them. (Node #8 token gate.)
  */
 readOnlyTokens: z.record(z.string(), z.string()).default({}),
 /** Fallback env var name for repos not matched by any prefix. */
 defaultTokenEnv: z.string().optional(),
 /**
  * Repo-prefix → env var name holding the machine-account WRITE credential
  * (classic `repo`-scoped PAT — node #11). Longest-prefix match, same shape as
  * readOnlyTokens. Graph-mutating ticks refuse to run without one.
  */
 writeTokens: z.record(z.string(), z.string()).default({}),
 /** Fallback env var name for the write credential. */
 defaultWriteTokenEnv: z.string().optional(),
});

/**
 * The machine account (design §2). `identity` is the login ranger labels
 * claims/closes with (`soma graph ... --identity <login>`); it defaults to the
 * login resolved from the write token. Graph-mutating ticks refuse when the
 * resolved identity equals the principal's login.
 */
const BotSchema = z.object({
 /** Machine-account login (e.g. `ivy-agent`). Optional — resolved from token. */
 identity: z.string().optional(),
});

const PrincipalSchema = z.object({
 /** The principal's login — the identity autonomous graph-mutation may never run under. */
 login: z.string().default("jcfischer"),
 /** Discord user id for the aged-card @-mention; absent → no pings. */
 discordId: z.string().optional(),
});

const StateSchema = z.object({
 /** SQLite journal path (design §8). */
 journalPath: z.string().default("~/.config/ranger/state.sqlite"),
 /** Root under which each walked repo's canonical checkout lives. */
 canonicalRoot: z.string().default("~/work/ranger-repos"),
});

const WorkersSchema = z.object({
 /** Daily worker-spawn cap — the global spend bound (design §7). */
 spawnCapPerDay: z.number().int().positive().default(10),
 /** Hard wall-clock kill per worker, minutes (design §4 NodeBudget). */
 wallClockMin: z.number().int().positive().default(90),
 /** Respawn attempts before a crashed worker is parked (design §7). */
 maxAttempts: z.number().int().positive().default(2),
 /** Consecutive worker failures that trip the dead-man switch (design §7). */
 deadmanThreshold: z.number().int().positive().default(3),
 /**
  * Sage reviews per implement-lane PR before ranger parks and escalates
  * (design §4: "cap 2 round-trips then park + escalate" — a third round
  * signals a decision is needed, not another patch).
  */
 reviewRounds: z.number().int().positive().default(2),
});

const PiSubstrateSchema = z.object({
 provider: z.string().min(1).default("spark"),
 model: z.string().min(1).default("longctx-think"),
});

/**
 * Substrate selection (node #45): which of Claude, Codex and Pi runs an
 * implement session, fix pass or sage review, by remaining 5h/7d quota.
 */
const SubstratesSchema = z.object({
 /** 5-hour window: eligible when used% < this (default 70). */
 fiveHourMaxUsedPct: z.number().min(0).max(100).default(70),
 /** 7-day window: eligible when used% < this (default 80). */
 sevenDayMaxUsedPct: z.number().min(0).max(100).default(80),
 /** Claude probe reading max age, minutes (default 15). */
 claudeProbeMaxAgeMin: z.number().int().positive().default(15),
 /** Codex reading max age, minutes (default 5). */
 codexReadMaxAgeMin: z.number().int().positive().default(5),
 /** Pi substrate configuration. */
 pi: PiSubstrateSchema.default({}),
});

/**
 * The GitHub budget (src/budget.ts). Ranger's read-only PATs draw on the
 * principal's own GraphQL allowance, so ranger yields well before it is spent.
 */
const BudgetSchema = z.object({
 /** Defer graph reads while fewer GraphQL points than this remain this hour. */
 graphqlFloor: z.number().int().nonnegative().default(1000),
 /** Pause graph reads this long after a secondary (burst) rate-limit refusal, minutes. */
 rateLimitCooldownMin: z.number().int().positive().default(10),
 /**
  * Oldest a cached frontier may be before it is re-read regardless of the
  * repo's issue activity, minutes (src/frontier-cache.ts).
  */
 frontierMaxAgeMin: z.number().int().positive().default(60),
});

const RangerConfigSchema = z.object({
 version: z.literal(1).default(1),
 maps: z.array(MapSchema).min(1, "at least one map must be registered"),
 auth: AuthSchema.default({}),
 bot: BotSchema.default({}),
 principal: PrincipalSchema.default({}),
 state: StateSchema.default({}),
 workers: WorkersSchema.default({}),
 budget: BudgetSchema.default({}),
 substrates: SubstratesSchema.default({}),
 serve: ServeSchema.optional(),
});

export type RangerMapConfig = z.infer<typeof MapSchema>;
export type RangerAuthConfig = z.infer<typeof AuthSchema>;
export type RangerBotConfig = z.infer<typeof BotSchema>;
export type RangerConfig = z.infer<typeof RangerConfigSchema>;
export type RangerServeConfig = z.infer<typeof ServeSchema>;

/** The `serve` block with its defaults filled, present or not. */
export function serveConfig(config: RangerConfig): RangerServeConfig {
 return config.serve ?? ServeSchema.parse({});
}

export interface LoadedConfig {
 config: RangerConfig;
 path: string;
}

/** Find the config path: explicit flag, else ./ranger.yaml, else default location. */
export function defaultConfigPath(cwd: string): string {
 return resolve(cwd, "ranger.yaml");
}

/** Expand a leading `~` (journal path, canonical root). */
export function expandHome(path: string): string {
 if (path === "~") return homedir();
 if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
 return path;
}

export function loadConfig(path: string): LoadedConfig {
 let raw: string;
 try {
  raw = readFileSync(path, "utf8");
 } catch (error) {
  throw new ConfigError(
   `cannot read config at ${path}: ${(error as Error).message}`,
  );
 }
 let doc: unknown;
 try {
  doc = parse(raw);
 } catch (error) {
  throw new ConfigError(
   `cannot parse YAML at ${path}: ${(error as Error).message}`,
  );
 }
 const parsed = RangerConfigSchema.safeParse(doc ?? {});
 if (!parsed.success) {
  throw new ConfigError(
   `invalid config at ${path}: ${formatZodError(parsed.error)}`,
  );
 }
 return { config: parsed.data, path };
}

function formatZodError(error: z.ZodError): string {
 return error.issues
  .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
  .join("; ");
}

export class ConfigError extends Error {
 override readonly name = "ConfigError";
}

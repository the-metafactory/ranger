import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { IMPLEMENT_LANES } from "./lanes.ts";
import { defaultJournalPath, journalPathOverride } from "./journal-guard.ts";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parseForgeRef, repoIdentity, validReadTokenPrefix } from "./forge-ref.ts";
export { REPO_PATTERN } from "./forge-ref.ts";

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

/** Keep bare GitHub arguments and qualified GitLab strings alongside their typed identity. */
const ValidRepoString = z.string().superRefine((repo, ctx) => {
 try {
  parseForgeRef(repo);
 }
 catch (error) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
 }
});
const RepoSchema = ValidRepoString.transform(repo => {
 const forgeRef = parseForgeRef(repo);
 return { repo: repoIdentity(forgeRef), forgeRef };
});

const MapSchema = z.object({
 /** Bare GitHub or forge-qualified ref — the repo whose issues hold the work graph. */
 repo: RepoSchema,
 /** Root node id of the orienteer map (the `orienteer:map` issue). */
 root: z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform(Number),
 /** Walk mode (node #9): what ranger may autonomously do on this map. */
 walk: WalkModeSchema,
 /** Machine-resource lane; defaults to visual with commands.probe, headless otherwise. */
 lane: z.enum(IMPLEMENT_LANES).optional(),
 /** Explicit operator opt-in; private paths are never sent to a coding worker. */
 testBackend: z.object({
  kind: z.enum(["ssh", "shadow"]),
  configFile: z.string().min(1).refine(isAbsolute),
  stateRoot: z.string().min(1).refine(isAbsolute),
  profileId: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  lockFile: z.string().max(255).regex(/^[a-zA-Z0-9_.-]+$/).refine(p => p !== "." && p !== ".."),
  deadlineSeconds: z.number().int().min(1).max(900).default(660),
  reportRoot: z.string().min(1).refine(isAbsolute).optional(),
 }).strict().refine(s => s.kind !== "shadow" || s.reportRoot !== undefined, { message: "Shadow requires a private reportRoot" }).optional(),
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
   /**
    * Optional retry for a failed probe run: only the probes that failed run
    * again, instead of the whole suite (2026-10-04: a load-induced crash in one
    * probe cost a 25-minute rerun). `{failed}` becomes the comma-separated
    * probe files from the run's `FAILED: a · b` line, each checked against a
    * plain file-name pattern; `{node}` as in `probe`. Without it, or when the
    * first run names no failures (a timeout or a crash of the runner), the
    * retry is the whole `probe` command.
    */
   probeRetry: z.string().min(1).optional(),
   /** Needs-eye evidence only: {label}, {out}, {origin}; never a merge gate. */
   views: z.string().min(1).optional(),
   /** Start a dev server for captures; {port} is a ranger-selected free port. */
   viewsServe: z.string().min(1).optional(),
   /** Compare captured runs; {out}, {a}, {b}. */
   viewsDiff: z.string().min(1).optional(),
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
}).transform(({ repo, ...map }) => ({ ...map, ...repo }));

/**
 * A map `ranger serve` shows and nothing else reads (#37): no walk, no scout
 * report, no escalation cards. Roots that ranger walks belong in `maps`, not here.
 */
const ServeMapSchema = z.object({
 repo: RepoSchema,
 root: z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform(Number),
 localCheckout: z.string().optional(),
}).transform(({ repo, ...map }) => ({ ...map, ...repo }));

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
  * Repo-prefix → env var name holding a read-only PAT. Bare keys match only
  * GitHub. GitLab requires gitlab:host/path prefixes, matched longest-first.
  * Tokens are NEVER inlined
  * here — only the env var name that holds them. (Node #8 token gate.)
  */
 readOnlyTokens: z.record(z.string().refine(validReadTokenPrefix, "expected a bare GitHub prefix or forge:host/path prefix"), z.string().min(1)).default({}),
 /** GitHub fallback only; GitLab always requires an explicit qualified mapping. */
 defaultTokenEnv: z.string().optional(),
 /**
  * Repo-prefix → env var name holding the machine-account WRITE credential
  * (classic `repo`-scoped PAT — node #11). Longest-prefix match, same shape as
  * readOnlyTokens. Graph-mutating ticks refuse to run without one.
  */
 writeTokens: z.record(z.string().refine(validReadTokenPrefix, "expected a bare GitHub prefix or forge:host/path prefix"), z.string().min(1)).default({}),
 /** GitHub fallback only; GitLab requires a qualified mapping. */
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
 /** Scalar means GitHub; host maps are forge:host → login. Missing host policy refuses writes. */
 login: z.union([
  z.string().min(1),
  z.record(z.string().refine(key => {
   try {
    const ref = parseForgeRef(`${key}/group/project`);
    return key === `${ref.forge}:${ref.host}`;
   } catch { return false; }
  }, "expected forge:host"), z.string().min(1)),
 ]).default("jcfischer"),
 /** Discord user id for the aged-card @-mention; absent → no pings. */
 discordId: z.string().optional(),
});

const StateSchema = z.object({
 /** Migration-only: original roots for ambiguous or deregistered legacy repos; remove after cutover. */
 legacyMapRoots: z.record(ValidRepoString.transform(repo => repoIdentity(parseForgeRef(repo))),
  z.number().int().positive()).default({}),
 /**
  * SQLite journal path (design §8): the live ~/.config/ranger/state.sqlite,
  * except under test, where an unset path is a fresh temp file (node #66).
  * RANGER_JOURNAL_PATH overrides it (see loadConfig).
  */
 journalPath: z.string().default(() => defaultJournalPath()),
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
 /** Automatic infrastructure-probe requeues per node/head; zero disables them. */
 probeRequeues: z.number().int().nonnegative().default(2),
 /** Consecutive worker failures that trip the dead-man switch (design §7). */
 deadmanThreshold: z.number().int().positive().default(3),
 /**
  * Sage reviews per implement-lane PR before ranger parks and escalates
  * (design §4: "cap 2 round-trips then park + escalate" — a third round
  * signals a decision is needed, not another patch).
  */
 reviewRounds: z.number().int().positive().default(2),
 /**
  * CPU priority for everything ranger runs except the browser probes: worker
  * sessions, install and test commands, sage reviews (`nice -n`; 0 = none).
  * The probes are timing-sensitive and keep normal priority (2026-10-05: load
  * reached 118 on 10 cores while tests, sessions and reviews shared the host
  * with a probe run, and the probes timed out and failed).
  */
 niceness: z.number().int().min(0).max(19).default(10),
});

const PiSubstrateSchema = z.object({
 provider: z.string().min(1).default("spark"),
 model: z.string().min(1).default("longctx-think"),
});

/** Plain model names only: nothing shell- or TOML-like reaches the argv. */
const MODEL_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * The model ranger's Codex sessions run (node #60): pinned here rather than
 * inherited from the principal's own ~/.codex/config.toml.
 */
const CodexSubstrateSchema = z.object({
 model: z.string().regex(MODEL_NAME, "a plain model name ([A-Za-z0-9._-])").default("gpt-6.1-sol"),
 reasoningEffort: z.enum(["low", "medium", "high"]).default("high"),
});

/**
 * Substrate selection (node #45): which of Claude, Codex and Pi runs an
 * implement session, fix pass or sage review, by remaining 5h/7d quota.
 */
const SubstratesSchema = z.object({
 /** 5-hour reserve at window start: eligible below this, rising toward 100% at reset (default 70). */
 fiveHourMaxUsedPct: z.number().min(0).max(100).default(70),
 /** 7-day reserve at window start: eligible below this, rising toward 100% at reset (default 80). */
 sevenDayMaxUsedPct: z.number().min(0).max(100).default(80),
 /** Claude probe reading max age, minutes (default 15). */
 claudeProbeMaxAgeMin: z.number().int().positive().default(15),
 /** Codex reading max age, minutes (default 5). */
 codexReadMaxAgeMin: z.number().int().positive().default(5),
 /** Codex substrate configuration: the model and reasoning effort a worker runs. */
 codex: CodexSubstrateSchema.default({}),
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

/** The legacy scalar names GitHub only; no cross-host principal fallback. */
export function principalLoginForRepo(config: RangerConfig, repo: string): string | undefined {
 const ref = parseForgeRef(repo);
 const login = config.principal.login;
 return typeof login === "string"
  ? (ref.forge === "github" ? login : undefined)
  : login?.[`${ref.forge}:${ref.host}`];
}
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

/**
 * Load and validate ranger.yaml. `RANGER_JOURNAL_PATH` in `env` overrides
 * `state.journalPath` (node #66): the supervisor sets it for worker sessions,
 * so branch code they run opens a per-session temp journal, never the live
 * one. The live processes never set it, and ranger's wrapper unsets it.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
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
 const override = journalPathOverride(env);
 if (override !== undefined) parsed.data.state.journalPath = override;
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

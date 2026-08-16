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

const MapSchema = z.object({
 /** `owner/name` — the repo whose issues hold the work graph. */
 repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
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
});

const RangerConfigSchema = z.object({
 version: z.literal(1).default(1),
 maps: z.array(MapSchema).min(1, "at least one map must be registered"),
 auth: AuthSchema.default({}),
 bot: BotSchema.default({}),
 principal: PrincipalSchema.default({}),
 state: StateSchema.default({}),
 workers: WorkersSchema.default({}),
});

export type RangerMapConfig = z.infer<typeof MapSchema>;
export type RangerAuthConfig = z.infer<typeof AuthSchema>;
export type RangerBotConfig = z.infer<typeof BotSchema>;
export type RangerConfig = z.infer<typeof RangerConfigSchema>;

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

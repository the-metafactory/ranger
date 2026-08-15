import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * ranger.yaml — per-run ranger configuration.
 *
 * Schema is provisional: the full walk-mode schema is an open orienteer node on
 * the ranger map (#6, "Walk-mode opt-in and charting guidance"). Scout only
 * needs the pieces it reads — the maps registry and the read-only token
 * mapping — and those are kept deliberately minimal and backwards-compatible
 * with the design doc's mentions (`ranger.yaml` per-run config, `walk: full`
 * opt-in, per-repo credential mapping in §2).
 */

const WalkModeSchema = z.enum(["none", "full"]).default("none");

const MapSchema = z.object({
 /** `owner/name` — the repo whose issues hold the work graph. */
 repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be owner/name"),
 /** Root node id of the orienteer map (the `orienteer:map` issue). */
 root: z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
  .transform(Number),
 /**
  * Walk mode for the future walker (node #6 owns the full schema). Scout only
  * reads it to classify `auto`+task frontier nodes into the implement lane vs
  * not-walkable.
  */
 walk: WalkModeSchema,
});

const AuthSchema = z.object({
 /**
  * Repo-prefix → env var name holding a read-only fine-grained PAT.
  * Prefixes match longest-first against `map.repo` (e.g. `the-metafactory/*`
  * covers every metafactory repo; `jcfischer/*` covers personal repos).
  * Tokens are NEVER inlined here — only the env var name that holds them.
  * This is the node #8 token gate: explicit read-only credential, no gh
  * keyring fallback.
  */
 readOnlyTokens: z.record(z.string(), z.string()).default({}),
 /** Fallback env var name for repos not matched by any prefix. */
 defaultTokenEnv: z.string().optional(),
});

const RangerConfigSchema = z.object({
 version: z.literal(1).default(1),
 maps: z.array(MapSchema).min(1, "at least one map must be registered"),
 auth: AuthSchema.default({}),
});

export type RangerMapConfig = z.infer<typeof MapSchema>;
export type RangerAuthConfig = z.infer<typeof AuthSchema>;
export type RangerConfig = z.infer<typeof RangerConfigSchema>;

export interface LoadedConfig {
 config: RangerConfig;
 path: string;
}

/** Find the config path: explicit flag, else ./ranger.yaml, else default location. */
export function defaultConfigPath(cwd: string): string {
 return resolve(cwd, "ranger.yaml");
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

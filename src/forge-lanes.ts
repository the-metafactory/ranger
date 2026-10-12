import * as github from "./github.ts";
import type { RangerConfig } from "./config.ts";
import type { ForgePort } from "./forge.ts";
import { parseForgeRef, qualifiedRepo } from "./forge-ref.ts";
import { gitlabForgePort } from "./gitlab.ts";
import { resolveWriteToken, WriteGateError } from "./identity.ts";
import { assertReadOnlyToken, GateError, resolveReadOnlyToken, type ResolvedToken } from "./token-gate.ts";

/**
 * What a lane takes from its map's `ForgeRef.forge` (ranger issue #97 ruling
 * Q8): the forge port, the read gate its graph reads run under, and whether
 * the forge's credentials are there at all. The write gate
 * (`assertWriteIdentity`) and the git transport (`gitCredential`) already
 * follow the repo they are given. Nothing here branches on a repo name.
 *
 * A GitHub map takes exactly today's path: the `github.ts` module as its
 * port, and graph reads under the machine write token.
 */

/** A read gate in `assertReadOnlyToken`'s shape; tests inject a fake one. */
export type ReadGate = (config: RangerConfig, repo: string) => Promise<{ token: ResolvedToken }>;

/**
 * The map's forge port. GitLab's is made per call, so its read gate runs
 * fresh: a lane makes one per run or pass, never a long-lived one.
 */
export function lanePort(config: RangerConfig, repo: string): ForgePort {
 return parseForgeRef(repo).forge === "gitlab" ? gitlabForgePort(config) : github;
}

/**
 * The credential a lane's graph reads run under. GitHub's stay under the
 * machine write token, as today. GitLab's go through the read gate (node
 * #122): soma's GitLab backend reads only under a checked `read_api` grant.
 */
export async function graphReadToken(
 config: RangerConfig,
 repo: string,
 writeToken: string,
 gate: ReadGate = assertReadOnlyToken,
): Promise<ResolvedToken> {
 if (parseForgeRef(repo).forge === "github") return { token: writeToken, source: "write-token" };
 return (await gate(config, repo)).token;
}

/**
 * Why a lane must not start on this map, or null when it may. A GitLab map
 * needs both of its credentials (the read-only PAT and the project bot's
 * write token) before anything is claimed or spawned; the check reads only
 * config and env, so it refuses before any forge or graph call. GitHub maps
 * keep their own gates and never refuse here.
 */
export function laneCredentialRefusal(
 config: RangerConfig,
 repo: string,
 env: NodeJS.ProcessEnv = process.env,
): string | null {
 const ref = parseForgeRef(repo);
 if (ref.forge === "github") return null;
 try {
  resolveReadOnlyToken(config, repo, env);
  resolveWriteToken(config, repo, env);
  return null;
 } catch (error) {
  if (!(error instanceof GateError) && !(error instanceof WriteGateError)) throw error;
  return `no GitLab credentials for ${qualifiedRepo(ref)}: ${error.message}`;
 }
}

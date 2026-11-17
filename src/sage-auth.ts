import type { RangerConfig } from "./config.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { createInstallationToken, mintAppJwt, type FetchFn } from "./github.ts";
import { readGitHubAppKey } from "./github-app-key.ts";
import { READ_ONLY_TOKEN_SOURCE, SAGE_APP_SOURCE_PREFIX } from "./github-usage.ts";
import { GateError, matchTokenEnv, resolveReadOnlyToken, type ResolvedToken } from "./token-gate.ts";

export function sageAppInstallation(config: Pick<RangerConfig, "auth">, repo: string) {
 const ref = parseForgeRef(repo);
 const app = config.auth.sageApp;
 if (ref.forge !== "github" || app === undefined) return undefined;
 const [owner, repository] = ref.path.split("/");
 const id = Object.entries(app.installations).find(([login]) => login.toLowerCase() === owner.toLowerCase())?.[1];
 if (id === undefined) return undefined;
 return { app, id, repository, source: `${SAGE_APP_SOURCE_PREFIX}${app.appId}:${id}` };
}

export function reviewTokenSource(config: Pick<RangerConfig, "auth">, repo: string): string {
 return sageAppInstallation(config, repo)?.source ?? matchTokenEnv(config.auth, repo) ?? READ_ONLY_TOKEN_SOURCE;
}

const READ_PERMISSIONS = { contents: "read", pull_requests: "read", issues: "read", checks: "read", metadata: "read" } as const;

export async function resolveSageReviewToken(config: RangerConfig, repo: string, fallback?: string, fetch?: FetchFn): Promise<ResolvedToken> {
 const installation = sageAppInstallation(config, repo);
 if (installation === undefined) {
  return fallback === undefined ? resolveReadOnlyToken(config, repo) : { token: fallback, source: reviewTokenSource(config, repo) };
 }
 const { app, id, repository, source } = installation;
 const pem = await readGitHubAppKey(app.privateKeyFile).catch(() => {
  throw new GateError("Cannot read auth.sageApp.privateKeyFile as an operator-owned private GitHub App key");
 });
 const minted = await createInstallationToken(mintAppJwt(app.appId, pem), id, {
  fetch,
  scope: { repositories: [repository], permissions: READ_PERMISSIONS },
 });
 if (minted.expiresAtMs <= Date.now()) throw new GateError(`GitHub returned an expired installation token for ${source}`);
 return { token: minted.token, source };
}

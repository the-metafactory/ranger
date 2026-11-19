import type { RangerConfig } from "./config.ts";
import { parseForgeRef } from "./forge-ref.ts";
import { createInstallationToken, mintAppJwt, readAppInstallation, type FetchFn } from "./github.ts";
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
 return { app, id, owner, repository, source: `${SAGE_APP_SOURCE_PREFIX}${app.appId}:${id}` };
}

export function reviewTokenSource(config: Pick<RangerConfig, "auth">, repo: string): string {
 return sageAppInstallation(config, repo)?.source ?? matchTokenEnv(config.auth, repo) ?? READ_ONLY_TOKEN_SOURCE;
}

const READ_PERMISSIONS = { contents: "read", pull_requests: "read", issues: "read", checks: "read", metadata: "read" } as const;

async function assertInstallationIsThisAppOnItsOwnerReadOnly(jwt: string, app: { appId: number }, owner: string, id: number, source: string, fetch?: FetchFn): Promise<void> {
 const installation = await readAppInstallation(jwt, id, fetch === undefined ? {} : { fetch });
 if (installation.appId !== app.appId) {
  throw new GateError(`${source} is installation ${id} of GitHub App ${installation.appId}, not App ${app.appId} — fix auth.sageApp.installations`);
 }
 if (installation.account.toLowerCase() !== owner.toLowerCase()) {
  throw new GateError(`${source}: installation ${id} belongs to ${installation.account}, not ${owner} — refusing to mint a token for another account's repository`);
 }
 if (installation.writePermissions.length > 0) {
  throw new GateError(`${source}: the App installation grants write access (${installation.writePermissions.join(", ")}); grant read access only`);
 }
}

/**
 * The token one Sage review runs under: the App's installation token when the map's owner has
 * one configured, the configured read-only PAT otherwise.
 *
 * `auth.sageApp.installations` holds a bare installation id per owner, so the id is checked
 * against the App's own view of it before a token is minted: it must be this App's
 * installation, sit on the reviewed repository's owner, and grant nothing above read. The App
 * may reach all of the owner's repositories: the minted token is scoped to the reviewed one. A mistyped id then refuses instead of minting a
 * token for another account's same-named repository, and an App installed or granted more
 * broadly than Sage needs never becomes Sage's credential. The key file behind that check is
 * readable by every process of this account, as the `checkReporter` App key is; the reach
 * checks are what bound a key that leaks.
 */
export async function resolveSageReviewToken(config: RangerConfig, repo: string, fallback?: string, fetch?: FetchFn): Promise<ResolvedToken> {
 const installation = sageAppInstallation(config, repo);
 if (installation === undefined) {
  return fallback === undefined ? resolveReadOnlyToken(config, repo) : { token: fallback, source: reviewTokenSource(config, repo) };
 }
 const { app, id, owner, repository, source } = installation;
 const pem = await readGitHubAppKey(app.privateKeyFile).catch(() => {
  throw new GateError("Cannot read auth.sageApp.privateKeyFile as an operator-owned private GitHub App key");
 });
 const jwt = mintAppJwt(app.appId, pem);
 await assertInstallationIsThisAppOnItsOwnerReadOnly(jwt, app, owner, id, source, fetch);
 const minted = await createInstallationToken(jwt, id, {
  fetch,
  scope: { repositories: [repository], permissions: READ_PERMISSIONS },
 });
 if (minted.expiresAtMs <= Date.now()) throw new GateError(`GitHub returned an expired installation token for ${source}`);
 return { token: minted.token, source };
}

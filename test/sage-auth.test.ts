import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeCooldown, recordThrottle, reviewCooldownScope } from "../src/budget.ts";
import { loadConfig } from "../src/config.ts";
import { runCmd } from "../src/exec.ts";
import { resolveSageReviewToken } from "../src/sage-auth.ts";
import { runNode } from "../src/worker.ts";
import { restoreEnv, rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const SOURCE = "sage-app:10:20";
const INSTALLATION_TOKEN = "fixture-installation-credential";
const INSTALLATION_URL = "https://api.github.com/app/installations/20";
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const acmeInstallationReadOnly = (overrides: Record<string, unknown> = {}) => ({
 id: 20,
 app_id: 10,
 account: { login: "Acme", type: "Organization" },
 repository_selection: "selected",
 permissions: { contents: "read", pull_requests: "read", issues: "read", checks: "read", metadata: "read" },
 ...overrides,
});

function recordingAppApi(seen: string[], body: Record<string, unknown> = acmeInstallationReadOnly(), mint: () => Response = () => Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() })) {
 return async (url: string, init: RequestInit): Promise<Response> => {
  seen.push(`${init.method ?? "GET"} ${url}`);
  if (url === INSTALLATION_URL) return Response.json(body);
  if (url === `${INSTALLATION_URL}/access_tokens`) return mint();
  throw new Error(`unexpected App request ${url}`);
 };
}

function configWithAcmeSageApp(keyMode = 0o600) {
 const dir = mkdtempSync(join(tmpdir(), "ranger-sage-auth-"));
 const keyPath = join(dir, "sage.pem");
 writeFileSync(keyPath, RSA.privateKey, { mode: 0o600 });
 chmodSync(keyPath, keyMode);
 const configPath = join(dir, "ranger.yaml");
 writeFileSync(
  configPath,
  `version: 1\nmaps:\n  - repo: acme/widgets\n    root: 1\nauth:\n  sageApp:\n    appId: 10\n    privateKeyFile: ${keyPath}\n    installations:\n      Acme: 20\n      Other: 30\n`,
 );
 return { config: loadConfig(configPath, {}).config, dir };
}

test("an exhausted principal's budget and absent PAT do not stop a repo-scoped Sage review", async () => {
 const r = await rig({ blockers: [1, 0] });
 try {
  const path = join(r.dir, "sage.pem");
  writeFileSync(path, RSA.privateKey, { mode: 0o600 });
  const auth = r.ctx.config.auth;
  auth.sageApp = { appId: 10, privateKeyFile: path, installations: { Acme: 20, Other: 30 } };
  auth.readOnlyTokens = { "acme/*": "RANGER_RO_TEST" };
  delete process.env.RANGER_RO_TEST;
  delete r.ctx.readOnlyToken;
  const now = new Date();
  recordThrottle(r.journal, "RANGER_RO_TEST", { cooldownMs: 60_000 }, now, { reason: () => "core allowance 0 remaining" });
  r.ctx.now = () => now;
  let mints = 0;
  r.ctx.sageAppFetch = async (url, init) => {
   if (url === INSTALLATION_URL) {
    expect(init.method).toBe("GET");
    return Response.json(acmeInstallationReadOnly());
   }
   mints += 1;
   expect(url).toBe(`${INSTALLATION_URL}/access_tokens`);
   expect(init.method).toBe("POST");
   expect(new Headers(init.headers).get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
   if (typeof init.body !== "string") throw new Error("expected a JSON installation scope");
   expect(JSON.parse(init.body)).toEqual({
    repositories: ["widgets"],
    permissions: { contents: "read", pull_requests: "read", issues: "read", checks: "read", metadata: "read" },
   });
   return Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date(now.getTime() + 3_600_000).toISOString() });
  };
  const reviewer = r.ctx.reviewer;
  if (reviewer === undefined) throw new Error("test requires a scripted reviewer");
  r.ctx.reviewer = async (repo, pull, token, opts) => {
   expect(token).toBe(INSTALLATION_TOKEN);
   expect(opts.tokenSource).toBe(SOURCE);
   return reviewer(repo, pull, token, opts);
  };
  let workers = 0;
  const command = r.ctx.workerCommand;
  if (!Array.isArray(command)) throw new Error("test requires a worker command");
  r.ctx.worker = async (prompt, opts) => {
   workers += 1;
   expect(opts.env?.GH_TOKEN).toBeUndefined();
   expect(opts.env?.GITHUB_TOKEN).toBeUndefined();
   expect(Object.values(opts.env ?? {})).not.toContain(INSTALLATION_TOKEN);
   return runCmd(command[0], [...command.slice(1), prompt], opts);
  };
  expect(await runNode("20", r.ctx)).toMatchObject({ status: "awaiting-merge" });
  expect(workers).toBe(2);
  expect(mints).toBe(2);
  expect(activeCooldown(r.journal, "RANGER_RO_TEST", now)?.kind).toBe("throttled");
  expect(reviewCooldownScope(r.ctx.config, REPO)).toBe(SOURCE);
  expect(reviewCooldownScope(r.ctx.config, "other/widgets")).toBe("sage-app:10:30");
  expect(activeCooldown(r.journal, SOURCE, now)).toBeNull();
  expect(JSON.stringify(r.journal.listEvents(REPO, 100, "20"))).not.toContain(INSTALLATION_TOKEN);
 } finally {
  r.journal.close();
  rmSync(r.dir, { recursive: true, force: true });
  restoreEnv();
 }
}, 120_000);

test("Sage keeps the configured PAT on maps without an App installation", async () => {
 const r = await rig({});
 try {
  r.ctx.config.auth.readOnlyTokens = { "acme/*": "RANGER_RO_TEST", "gitlab:gitlab.example.org/team/": "RANGER_RO_GITLAB" };
  process.env.RANGER_RO_TEST = "fixture-pat";
  expect(await resolveSageReviewToken(r.ctx.config, REPO)).toEqual({ token: "fixture-pat", source: "RANGER_RO_TEST" });
  r.ctx.config.auth.sageApp = { appId: 10, privateKeyFile: "/nonexistent/key.pem", installations: { team: 20 } };
  expect(await resolveSageReviewToken(r.ctx.config, REPO)).toEqual({ token: "fixture-pat", source: "RANGER_RO_TEST" });
  expect(await resolveSageReviewToken(r.ctx.config, "gitlab:gitlab.example.org/team/widgets", "gitlab-test")).toEqual({ token: "gitlab-test", source: "RANGER_RO_GITLAB" });
 } finally {
  r.journal.close();
  rmSync(r.dir, { recursive: true, force: true });
  restoreEnv();
 }
});

test("a readable installation of this App mints one repository- and read-scoped token", async () => {
 const { config, dir } = configWithAcmeSageApp();
 const seen: string[] = [];
 try {
  expect(await resolveSageReviewToken(config, REPO, "test-pat", recordingAppApi(seen))).toEqual({ token: INSTALLATION_TOKEN, source: SOURCE });
  expect(seen).toEqual([`GET ${INSTALLATION_URL}`, `POST ${INSTALLATION_URL}/access_tokens`]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("an installation on another account is refused before any token is minted", async () => {
 const { config, dir } = configWithAcmeSageApp();
 const seen: string[] = [];
 try {
  const fetch = recordingAppApi(seen, acmeInstallationReadOnly({ account: { login: "Other" } }));
  await expect(resolveSageReviewToken(config, REPO, "test-pat", fetch)).rejects.toThrow("belongs to Other, not acme");
  expect(seen).toEqual([`GET ${INSTALLATION_URL}`]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("an installation of a different App is refused by its app id", async () => {
 const { config, dir } = configWithAcmeSageApp();
 const seen: string[] = [];
 try {
  const fetch = recordingAppApi(seen, acmeInstallationReadOnly({ app_id: 11 }));
  await expect(resolveSageReviewToken(config, REPO, "test-pat", fetch)).rejects.toThrow("installation 20 of GitHub App 11, not App 10");
  expect(seen).toEqual([`GET ${INSTALLATION_URL}`]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("an App installed on all repositories is refused, so its key cannot mint beyond the mapped ones", async () => {
 const { config, dir } = configWithAcmeSageApp();
 const seen: string[] = [];
 try {
  const fetch = recordingAppApi(seen, acmeInstallationReadOnly({ repository_selection: "all" }));
  await expect(resolveSageReviewToken(config, REPO, "test-pat", fetch)).rejects.toThrow("installed on all repositories (all)");
  expect(seen).toEqual([`GET ${INSTALLATION_URL}`]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("an installation that grants write access is refused", async () => {
 const { config, dir } = configWithAcmeSageApp();
 const seen: string[] = [];
 try {
  const fetch = recordingAppApi(seen, acmeInstallationReadOnly({ permissions: { contents: "read", pull_requests: "write" } }));
  await expect(resolveSageReviewToken(config, REPO, "test-pat", fetch)).rejects.toThrow("grants write access (pull_requests)");
  expect(seen).toEqual([`GET ${INSTALLATION_URL}`]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("a refused token request fails the review without a credential", async () => {
 const { config, dir } = configWithAcmeSageApp();
 try {
  const refused = () => Response.json({ message: "Installation access refused" }, { status: 403 });
  await expect(resolveSageReviewToken(config, REPO, "test-pat", recordingAppApi([], acmeInstallationReadOnly(), refused))).rejects.toThrow("HTTP 403");
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("a key file readable by others is refused without a request", async () => {
 const { config, dir } = configWithAcmeSageApp(0o644);
 const seen: string[] = [];
 try {
  await expect(resolveSageReviewToken(config, REPO, "test-pat", recordingAppApi(seen))).rejects.toThrow("operator-owned private");
  expect(seen).toEqual([]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

test("a key file with a second hard link is refused without a request", async () => {
 const { config, dir } = configWithAcmeSageApp();
 const seen: string[] = [];
 try {
  linkSync(join(dir, "sage.pem"), join(dir, "sage-copy.pem"));
  await expect(resolveSageReviewToken(config, REPO, "test-pat", recordingAppApi(seen))).rejects.toThrow("operator-owned private");
  expect(seen).toEqual([]);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
});

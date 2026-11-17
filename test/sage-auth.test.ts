import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeCooldown, recordThrottle, reviewCooldownScope } from "../src/budget.ts";
import { runCmd } from "../src/exec.ts";
import { resolveSageReviewToken } from "../src/sage-auth.ts";
import { runNode } from "../src/worker.ts";
import { restoreEnv, rig } from "./implement-rig.ts";

const REPO = "acme/widgets";
const SOURCE = "sage-app:10:20";
const INSTALLATION_TOKEN = "fixture-installation-credential";
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

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
   mints += 1;
   expect(url).toBe("https://api.github.com/app/installations/20/access_tokens");
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

  const refused = async () => Response.json({ message: "Installation access refused" }, { status: 403 });
  await expect(resolveSageReviewToken(r.ctx.config, REPO, "test-pat", refused)).rejects.toThrow("HTTP 403");
  chmodSync(path, 0o644);
  await expect(resolveSageReviewToken(r.ctx.config, REPO, "test-pat", r.ctx.sageAppFetch)).rejects.toThrow("operator-owned private");
  expect(mints).toBe(2);
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

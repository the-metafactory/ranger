import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmd } from "../src/exec.ts";

const fixturesBin = join(import.meta.dir, "fixtures", "bin");
const dataDir = join(import.meta.dir, "fixtures", "data");
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const bun = process.execPath;

function writeConfig(repoTokens: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ranger-e2e-"));
  const config = [
    "version: 1",
    "maps:",
    "  - repo: acme/widgets",
    "    root: 1",
    "    walk: full",
    "  - repo: acme/gadgets",
    "    root: 5",
    "    walk: none",
    "auth:",
    "  readOnlyTokens:",
    ...Object.entries(repoTokens).map(
      ([prefix, env]) => `    "${prefix}": ${env}`,
    ),
  ].join("\n");
  const path = join(dir, "ranger.yaml");
  writeFileSync(path, config);
  return path;
}

interface RunScoutOptions {
  config: string;
  json?: boolean;
  tokenEnv?: Record<string, string>;
  scopes?: string;
}

async function runScout(opts: RunScoutOptions) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixturesBin}:${process.env.PATH ?? ""}`,
    FAKE_SOMA_DIR: dataDir,
    GH_SCOPES: opts.scopes ?? "",
    ...opts.tokenEnv,
  };
  const args = [cliPath, "scout", "-c", opts.config];
  if (opts.json) args.push("--json");
  return runCmd(bun, args, { env, cwd: join(import.meta.dir, "..") });
}

describe("ranger scout — end-to-end against fake soma/gh", () => {
  test("reports frontier by route class, HITL waiting, claims, receipt-less closes (fine-grained token)", async () => {
    const config = writeConfig({ "acme/*": "RANGER_RO_TEST" });
    const result = await runScout({
      config,
      tokenEnv: { RANGER_RO_TEST: "github_pat_readonly" },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("identity: scout-test (fine-grained)");
    expect(result.stdout).toContain("map: acme/widgets");
    // Frontier by route class
    expect(result.stdout).toContain("escalate (HITL)");
    expect(result.stdout).toContain("research");
    expect(result.stdout).toContain("implement");
    expect(result.stdout).toContain("provisioning");
    expect(result.stdout).toContain("#10 Survey third-party API");
    expect(result.stdout).toContain("#11 Ship billing integration");
    expect(result.stdout).toContain("#15 Build the widget renderer");
    // HITL waiting list
    expect(result.stdout).toContain("HITL waiting: 3");
    expect(result.stdout).toContain("#12 Draft UX copy");
    expect(result.stdout).toContain("#13");
    // Audit findings
    expect(result.stdout).toContain("receipt-less closes:  2 (7, 8)");
    expect(result.stdout).toContain("open w/o checkpoint:  1 (9)");
    expect(result.stdout).toContain("#16 Migrate the legacy store [alice]");
    // gadgets map: walk:none → implement not walkable
    expect(result.stdout).toContain("map: acme/gadgets");
    expect(result.stdout).toContain("implement (not walk:full)");
    // Clean map marker
    expect(result.stdout).toContain("clean ✓");
    expect(result.stdout).toContain("issues ✗");
  });

  test("--json emits a parseable report with route classes and audit findings", async () => {
    const config = writeConfig({ "acme/*": "RANGER_RO_TEST" });
    const result = await runScout({
      config,
      json: true,
      tokenEnv: { RANGER_RO_TEST: "github_pat_readonly" },
    });

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.readonlySurface).toEqual(["audit", "frontier", "node"]);
    expect(report.identity.login).toBe("scout-test");
    expect(report.maps).toHaveLength(2);

    const widgets = report.maps.find(
      (m: { repo: string }) => m.repo === "acme/widgets",
    );
    expect(widgets.ok).toBe(true);
    expect(widgets.receiptLessCloses).toEqual(["7", "8"]);
    expect(widgets.openWithoutCheckpoint).toEqual(["9"]);
    expect(widgets.claims).toEqual([
      {
        id: "16",
        title: "Migrate the legacy store",
        assignees: ["alice"],
        worker: "unknown",
      },
    ]);

    const byRoute = new Map<string, number>();
    for (const n of widgets.frontier as { route: { route: string } }[]) {
      byRoute.set(n.route.route, (byRoute.get(n.route.route) ?? 0) + 1);
    }
    expect(byRoute.get("escalate-hitl")).toBe(3);
    expect(byRoute.get("research")).toBe(1);
    expect(byRoute.get("implement")).toBe(1);
    expect(byRoute.get("provisioning")).toBe(1);
  });

  test("aborts a map whose token is write-capable (classic scopes)", async () => {
    const config = writeConfig({ "acme/*": "RANGER_RO_TEST" });
    const result = await runScout({
      config,
      tokenEnv: { RANGER_RO_TEST: "gho_write" },
      scopes: "repo, workflow",
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "refusing to run scout with a write-capable token",
    );
  });

  test("aborts when the read-only token env is unset (no keyring fallback)", async () => {
    const config = writeConfig({ "acme/*": "RANGER_RO_TEST" });
    const result = await runScout({ config, tokenEnv: {} });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("refusing to fall back to the gh keyring");
  });

  test("unknown command exits non-zero with usage help", async () => {
    const result = await runCmd(bun, [cliPath, "tick"], {
      env: process.env,
      cwd: join(import.meta.dir, ".."),
    });
    expect(result.code).not.toBe(0);
  });
});

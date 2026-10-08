import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseForgeRef } from "./forge-ref.ts";

function configContents(host: string, token: string): string {
  parseForgeRef(`gitlab:${host}/group/project`);
  return stringify({
    check_update: false,
    telemetry: false,
    hosts: { [host]: { token, api_host: host, api_protocol: "https" } },
  });
}

/** Arbitrarily named read/write secrets are excluded along with CLI overrides. */
function isolatedEnv(dir: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "TZ",
    "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY",
    "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION",
    "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE",
  ]) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  return { ...env, GLAB_CONFIG_DIR: dir, SOMA_GRAPH_READONLY: "1" };
}

/** One host, one credential, no inherited glab token or host override. */
export function glabConfigEnv(
  host: string,
  token: string,
  base: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const contents = configContents(host, token);
  const dir = mkdtempSync(join(tmpdir(), "ranger-glab-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "config.yml");
    writeFileSync(file, contents, { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    return { env: isolatedEnv(dir, base), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Async per-call variant for the serving and tick read paths. */
export async function glabConfigEnvAsync(
  host: string,
  token: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const contents = configContents(host, token);
  const dir = await mkdtemp(join(tmpdir(), "ranger-glab-"));
  try {
    await chmod(dir, 0o700);
    const file = join(dir, "config.yml");
    await writeFile(file, contents, { mode: 0o600, flag: "wx" });
    await chmod(file, 0o600);
    return { env: isolatedEnv(dir, base), cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

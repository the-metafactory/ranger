import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseForgeRef } from "./forge-ref.ts";

/** One host, one credential, no inherited glab token or host override. */
export function glabConfigEnv(
  host: string,
  token: string,
  base: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  // Validate before using the host as a YAML key (also used by the operator probe).
  parseForgeRef(`gitlab:${host}/group/project`);
  const dir = mkdtempSync(join(tmpdir(), "ranger-glab-"));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, "config.yml");
    writeFileSync(file, stringify({
      check_update: false,
      telemetry: false,
      hosts: { [host]: { token, api_host: host, api_protocol: "https" } },
    }), { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
    const env = { ...base };
    for (const name of [
      "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN",
      "JOB_TOKEN", "GLAB_TOKEN", "GITLAB_HOST", "GL_HOST", "GLAB_HOST",
      "GITLAB_API_HOST", "GITLAB_API_PROTOCOL", "API_PROTOCOL", "GITLAB_URI", "GITLAB_URL",
      "GLAB_ENABLE_CI_AUTOLOGIN", "GLAB_SEND_TELEMETRY", "CHECK_UPDATE",
    ]) delete env[name];
    env.GLAB_CONFIG_DIR = dir;
    env.SOMA_GRAPH_READONLY = "1";
    return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Forge credentials and CLI overrides must not reach worker code or human merges. */
export const MACHINE_FORGE_KEYS = [
 "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST",
 "GITLAB_TOKEN", "GLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN",
 "GLAB_CONFIG_DIR", "GITLAB_HOST", "GITLAB_URI",
] as const;

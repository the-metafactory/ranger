/**
 * The host env names a worker inherits (see workerHostEnv). A leaf module so
 * config validation can refuse credential env names that would pass it
 * without importing worker-env.ts (which imports config.ts).
 */
const ALLOWED_NAMES = new Set([
 "PATH",
 "HOME",
 "USER",
 "LOGNAME",
 "LANG",
 "LC_ALL",
 "LC_CTYPE",
 "LC_MESSAGES",
 "LC_TIME",
 "TERM",
 "TZ",
 "SHELL",
 "PWD",
 "TMPDIR",
 "XDG_CONFIG_HOME",
 "XDG_CACHE_HOME",
 "XDG_STATE_HOME",
 "SSH_AUTH_SOCK",
 "GIT_ASKPASS",
 "GIT_TERMINAL_PROMPT",
]);

const ALLOWED_PREFIXES = [
 "ANTHROPIC_",
 "CLAUDE_",
 "CLAUDECODE_",
 "CODEX_",
 "OPENAI_",
 "AZURE_",
 "BEDROCK_",
 "VERTEX_",
 "GEMINI_",
 "GOOGLE_",
 "OPENROUTER_",
 "LITELLM_",
 "SOMA_",
 "SAGE_",
 "PILOT_",
 "GIT_", // git identity + config passthrough (auth header is overridden by gitAuthEnv)
];

/** True when workerHostEnv would hand `name` to untrusted worker code. */
export function workerEnvPasses(name: string): boolean {
 return ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some(prefix => name.startsWith(prefix));
}

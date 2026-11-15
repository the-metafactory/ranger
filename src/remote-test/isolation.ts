/** The one declaration of Bun's isolation flags: the container bootstrap takes
 * them as engine arguments and every reviewed recipe prefixes its command with
 * them, so a checkout's own bunfig.toml and .env never reach either. */
export const CONTAINER_BOOTSTRAP_FLAGS = ["--config=/dev/null", "--no-env-file"] as const;

/**
 * Shared Discord API-base resolution (escalation desk + walker announcer).
 *
 * `RANGER_DISCORD_API_BASE` may only target discord.com over https, or a
 * loopback listener when the test seam is explicitly opted in
 * (`RANGER_DISCORD_ALLOW_TEST_OVERRIDE=1`). An injected override can
 * otherwise redirect a bot token to an attacker host. Absent/empty → the
 * fixed Discord origin.
 */
export function resolveDiscordApiBase(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.RANGER_DISCORD_API_BASE;
  if (override === undefined || override.length === 0) {
    return "https://discord.com/api/v10";
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(
      "RANGER_DISCORD_API_BASE is not a valid URL; refusing to use it",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host === "discord.com") {
    if (url.protocol !== "https:") {
      throw new Error(
        "RANGER_DISCORD_API_BASE discord.com override must be https",
      );
    }
    return override;
  }
  // Loopback is only a test seam, and only when explicitly opted in — an
  // injected override otherwise redirects the bot token to a local listener.
  if (
    (host === "localhost" || host === "127.0.0.1") &&
    env.RANGER_DISCORD_ALLOW_TEST_OVERRIDE === "1"
  ) {
    return override;
  }
  throw new Error(
    `RANGER_DISCORD_API_BASE host ${host} is not allowed — ` +
      "discord.com (https) or an explicit localhost test override only",
  );
}

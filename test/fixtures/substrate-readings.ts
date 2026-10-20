export async function eligibleCodexReading() {
 return {
  substrate: "codex" as const,
  readAt: new Date(),
  windows: [{ kind: "five_hour" as const, usedPct: 10, resetsAt: Math.floor(Date.now() / 1000) + 3600 }],
  capped: false,
  cappedUntil: null,
 };
}

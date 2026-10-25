// Summarise a /api/state JSON file. Exit 0 when at least one map was read without error.
// usage: bun state-summary.ts <state.json> [--quiet]
const [path, flag] = Bun.argv.slice(2);
if (!path) throw new Error("usage: bun state-summary.ts <state.json> [--quiet]");
const state = JSON.parse(await Bun.file(path).text()) as Record<string, unknown> & {
  maps?: { key: string; error?: string }[];
};
const maps = state.maps ?? [];
if (flag !== "--quiet") {
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) console.log(`${key}: ${value.length}`);
  }
  const failed = maps.filter((m) => m.error);
  console.log(`maps read: ${maps.length - failed.length}/${maps.length}`);
  for (const m of failed) console.log(`map ${m.key}: ERROR ${m.error}`);
}
process.exit(maps.some((m) => !m.error) ? 0 : 1);

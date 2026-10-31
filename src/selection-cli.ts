import { loadConfig, resolveConfigPath } from "./config.ts";
import { openJournal } from "./journal.ts";
import { SelectionRequestSchema, selectParserSubstrate, type SelectionResult } from "./selection.ts";

async function readRequest(): Promise<unknown> {
 let raw = "";
 const timer = setTimeout(() => process.stdin.destroy(new Error("request input timed out after 5000ms")), 5_000);
 try {
  for await (const chunk of process.stdin) {
   raw += String(chunk);
   if (Buffer.byteLength(raw) > 16_384) throw new Error("request exceeds 16384 bytes");
  }
  return JSON.parse(raw) as unknown;
 } finally {
  clearTimeout(timer);
 }
}

export async function runSelectionCli(configPath: string | undefined): Promise<void> {
 let request;
 try {
  request = SelectionRequestSchema.parse(await readRequest());
 } catch (error) {
  emit({ version: 1, kind: "unavailable", reason: "invalid-request", candidates: [] });
  process.stderr.write(`ranger select-substrate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
  return;
 }
 try {
  const { config } = loadConfig(resolveConfigPath(configPath, process.env, process.cwd()));
  const journal = openJournal(config);
  let result: SelectionResult;
  try {
   result = await selectParserSubstrate(request, config, journal);
  } finally {
   journal.close();
  }
  emit(result);
 } catch (error) {
  emit({ version: 1, kind: "unavailable", reason: "integration-unavailable", candidates: [] });
  process.stderr.write(`ranger select-substrate: ${error instanceof Error ? error.message : String(error)}\n`);
 }
}

function emit(result: SelectionResult): void {
 process.stdout.write(`${JSON.stringify(result)}\n`);
}

#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { denyReason, findCanonicalWrite, guardedRoots } from "../canonical-guard.ts";
import { expandHome, loadConfig, resolveConfigPath } from "../config.ts";

interface HookInput {
 tool_name?: unknown;
 tool_input?: { command?: unknown };
 cwd?: unknown;
}

const DEFAULT_ROOT = "~/work/ranger-repos";

function roots(): { roots: string[]; canonicalRoot: string } {
 try {
  const { config } = loadConfig(resolveConfigPath(undefined, process.env, process.cwd()), process.env, () => undefined);
  return { roots: guardedRoots(config), canonicalRoot: resolve(expandHome(config.state.canonicalRoot)) };
 } catch {
  const canonicalRoot = resolve(expandHome(DEFAULT_ROOT));
  return { roots: [canonicalRoot], canonicalRoot };
 }
}

function main(): void {
 let input: HookInput;
 try {
  input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
 } catch {
  return;
 }
 const command = input.tool_input?.command;
 if (input.tool_name !== "Bash" || typeof command !== "string") return;
 const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
 const guarded = roots();
 const write = findCanonicalWrite(command, cwd, guarded.roots, guarded.canonicalRoot);
 if (write === undefined) return;
 process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason(write) },
 }));
}

main();

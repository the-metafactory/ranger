import { existsSync } from "node:fs";
import { join } from "node:path";
import { vsaClaimRefusal } from "./candidates.ts";
import type { RangerConfig, RangerMapConfig } from "./config.ts";
import { lanePort } from "./forge-lanes.ts";
import type { ForgeReadPort } from "./forge.ts";
import { safeGit } from "./git-ops.ts";
import { IMPLEMENT_KINDS } from "./route.ts";
import { canonicalDir } from "./worker.ts";

export interface BaseVsa {
 text: string;
 createdAt: Date;
}

/**
 * `VSA.md` at `origin/<base>` in `canonical`, or null when there is no
 * checkout or the base has no `VSA.md`. Any other git failure throws.
 */
export async function readBaseVsa(canonical: string, base: string): Promise<BaseVsa | null> {
 if (!existsSync(join(canonical, ".git"))) return null;
 const ref = `refs/remotes/origin/${base}`;
 const git = async (args: string[]): Promise<string> => {
  const result = await safeGit(args, { cwd: canonical, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args[0]} ${ref}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
 };
 if ((await git(["ls-tree", "--name-only", ref, "--", "VSA.md"])).trim() === "") return null;
 const text = await git(["show", `${ref}:VSA.md`]);
 const added = (await git(["log", "--diff-filter=A", "--format=%cI", ref, "--", "VSA.md"])).trim().split("\n").filter(Boolean);
 const oldest = added.at(-1);
 if (oldest === undefined) throw new Error(`no commit on ${ref} adds VSA.md`);
 return { text, createdAt: new Date(oldest) };
}

export interface VsaGateArgs {
 config?: RangerConfig;
 map: RangerMapConfig;
 node: { id: string; kind: string; body?: string };
 token: string;
 forge?: Pick<ForgeReadPort, "issueCreatedAt">;
}

/**
 * Why the VSA gate refuses this claim, or null. Fails closed: an error
 * reading `VSA.md` or the node's date refuses with that error. Without a
 * config there is no checkout to read, so the gate allows.
 */
export async function vsaGateRefusal(args: VsaGateArgs): Promise<string | null> {
 const { config, map, node } = args;
 if (config === undefined || !IMPLEMENT_KINDS.has(node.kind)) return null;
 let vsa: BaseVsa | null;
 try {
  vsa = await readBaseVsa(canonicalDir(config, map), map.base);
 } catch (error) {
  return `VSA.md unreadable on origin/${map.base} (${error instanceof Error ? error.message : String(error)})`;
 }
 if (vsa === null) return null;
 let createdAt: Date;
 try {
  if (!/^\d+$/.test(node.id)) throw new Error(`node id ${node.id} is not an issue number`);
  const forge = args.forge ?? lanePort(config, map.repo);
  if (forge.issueCreatedAt === undefined) throw new Error("this forge cannot read issue creation dates");
  createdAt = new Date(await forge.issueCreatedAt(map.repo, Number(node.id), args.token));
 } catch (error) {
  return `node creation date unreadable (${error instanceof Error ? error.message : String(error)})`;
 }
 return vsaClaimRefusal(node.body, node.kind, createdAt, vsa.text, vsa.createdAt);
}

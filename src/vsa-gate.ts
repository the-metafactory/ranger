import { existsSync } from "node:fs";
import { join } from "node:path";
import { criterionCitations, iscLine, vsaClaimVerdict, type VsaClaimVerdict } from "./candidates.ts";
import { canonicalDir, type RangerConfig, type RangerMapConfig } from "./config.ts";
import { lanePort } from "./forge-lanes.ts";
import type { ForgeReadPort } from "./forge.ts";
import { safeGit } from "./git-ops.ts";
import type { Journal } from "./journal.ts";
import { IMPLEMENT_KINDS } from "./route.ts";

export interface BaseVsa {
 text: string;
 createdAt: Date;
}

/** Where the gate keeps values that never change for a given key: the journal's health table. */
export type VsaCache = Pick<Journal, "getHealth" | "setHealth">;

/**
 * `VSA.md` at `origin/<base>` in `canonical`, or null when there is no
 * checkout or the base has no `VSA.md`. Any other git failure throws. The
 * add date comes from a walk of the base's history, so `cache` keeps it
 * with the base commit it was read at and the walk runs again only when
 * `origin/<base>` moves.
 */
export async function readBaseVsa(canonical: string, base: string, cache?: VsaCache): Promise<BaseVsa | null> {
 if (!existsSync(join(canonical, ".git"))) return null;
 const ref = `refs/remotes/origin/${base}`;
 const git = async (args: string[]): Promise<string> => {
  const result = await safeGit(args, { cwd: canonical, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args[0]} ${ref}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
 };
 const sha = (await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
 if ((await git(["ls-tree", "--name-only", sha, "--", "VSA.md"])).trim() === "") return null;
 const text = await git(["show", `${sha}:VSA.md`]);
 const key = `vsa.added:${canonical}#${base}`;
 const cached = cache?.getHealth(key);
 if (cached?.startsWith(`${sha} `) === true) return { text, createdAt: new Date(cached.slice(sha.length + 1)) };
 const added = (await git(["log", "--diff-filter=A", "--format=%cI", sha, "--", "VSA.md"])).trim().split("\n").filter(Boolean);
 const oldest = added.at(-1);
 if (oldest === undefined) throw new Error(`no commit on ${ref} adds VSA.md`);
 cache?.setHealth(key, `${sha} ${oldest}`);
 return { text, createdAt: new Date(oldest) };
}

async function cachedIssueCreatedAt(args: VsaGateArgs & { config: RangerConfig }): Promise<Date> {
 const { config, map, node } = args;
 const key = `vsa.issue-created:${map.repo}#${node.id}`;
 const cached = args.cache.getHealth(key);
 if (cached !== null) return new Date(cached);
 if (!/^\d+$/.test(node.id)) throw new Error(`node id ${node.id} is not an issue number`);
 const forge = args.forge ?? lanePort(config, map.repo);
 if (forge.issueCreatedAt === undefined) throw new Error("this forge cannot read issue creation dates");
 const read = await forge.issueCreatedAt(map.repo, Number(node.id), args.token);
 if (Number.isNaN(new Date(read).getTime())) throw new Error(`forge returned creation date ${JSON.stringify(read)}`);
 args.cache.setHealth(key, read);
 return new Date(read);
}

export interface VsaGateArgs {
 config?: RangerConfig;
 map: RangerMapConfig;
 node: { id: string; kind: string; body?: string };
 token: string;
 forge?: Pick<ForgeReadPort, "issueCreatedAt">;
 cache: VsaCache;
}

/**
 * The VSA gate's verdict on this claim. Fails closed: an error reading
 * `VSA.md` or the node's date refuses with that error. Without a config
 * there is no checkout to read, so the gate allows.
 */
export async function vsaGate(args: VsaGateArgs): Promise<VsaClaimVerdict> {
 const { config, map, node } = args;
 if (config === undefined || !IMPLEMENT_KINDS.has(node.kind)) return null;
 let vsa: BaseVsa | null;
 try {
  vsa = await readBaseVsa(canonicalDir(config, map), map.base, args.cache);
 } catch (error) {
  return { refused: `VSA.md unreadable on origin/${map.base} (${error instanceof Error ? error.message : String(error)})` };
 }
 if (vsa === null) return null;
 let createdAt: Date;
 try {
  createdAt = await cachedIssueCreatedAt({ ...args, config });
 } catch (error) {
  return { refused: `node creation date unreadable (${error instanceof Error ? error.message : String(error)})` };
 }
 return vsaClaimVerdict(node.body, node.kind, createdAt, vsa.text, vsa.createdAt);
}

/**
 * The ISC line ranger writes into a node it files: the criteria `source`
 * cites, else `ISC: none (<none>)`. Null when the base has no `VSA.md`, the
 * kind needs no citation, or there is nothing to write; `error` when
 * `VSA.md` could not be read, so the node is filed without a line.
 */
export async function filedIscLine(
 canonical: string,
 base: string,
 kind: string | undefined,
 source: string | undefined,
 none?: string,
): Promise<{ line: string | null } | { error: string }> {
 if (kind !== undefined && !IMPLEMENT_KINDS.has(kind)) return { line: null };
 try {
  const vsa = await readBaseVsa(canonical, base);
  return { line: vsa === null ? null : iscLine(criterionCitations(source, vsa.text), none) };
 } catch (error) {
  return { error: error instanceof Error ? error.message : String(error) };
 }
}

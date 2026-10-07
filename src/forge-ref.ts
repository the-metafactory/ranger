/** A repository identity, independent of a forge's API or credentials. */
export interface ForgeRef {
 readonly forge: "github" | "gitlab";
 readonly host: string;
 readonly path: string;
}

// No empty or traversal segments, URL escapes, ports, queries or fragments.
const SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9._-]+`;
const LABEL = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
const HOST = `${LABEL}(?:\\.${LABEL})*`;
export const REPO_PATTERN = new RegExp(
 `^(?:${SEGMENT}/${SEGMENT}|github:github\\.com/${SEGMENT}/${SEGMENT}|gitlab:${HOST}/${SEGMENT}(?:/${SEGMENT})+)$` + String.raw`(?![\s\S])`,
);

// Config carries immutable typed refs. A bounded memo lets string-only
// boundaries reuse parsed values without growing with serve HTTP inputs.
const refs = new Map<string, ForgeRef>();
const MAX_CACHED_REFS = 256;
const IID_PATTERN = /^\d+$(?![\s\S])/;
export function parseForgeRef(repo: string): ForgeRef {
 const cached = refs.get(repo);
 if (cached !== undefined) return cached;
 if (!REPO_PATTERN.test(repo)) {
  throw new Error(`invalid repo '${repo}': expected owner/name, github:github.com/owner/name or gitlab:host/group/project`);
 }
 const colon = repo.indexOf(":");
 const qualified = colon >= 0;
 const forge = qualified ? repo.slice(0, colon) as ForgeRef["forge"] : "github";
 const location = qualified ? repo.slice(colon + 1) : repo;
 const slash = location.indexOf("/");
 const ref: ForgeRef = Object.freeze({
  forge,
  host: qualified ? location.slice(0, slash) : "github.com",
  path: qualified ? location.slice(slash + 1) : repo,
 });
 if (refs.size + 3 > MAX_CACHED_REFS) refs.clear();
 refs.set(repo, ref);
 refs.set(repoIdentity(ref), ref);
 refs.set(qualifiedRepo(ref), ref);
 return ref;
}

/** GitHub keeps its historical bare identity; GitLab includes the host. */
export function repoIdentity(ref: ForgeRef): string {
 return ref.forge === "github" ? ref.path : qualifiedRepo(ref);
}

export function qualifiedRepo(ref: ForgeRef): string {
 return `${ref.forge}:${ref.host}/${ref.path}`;
}

/** Registration is independent of operational support, added by later forge slices. */
const CAPABILITIES = {
 github: Object.freeze({ execution: true, githubApi: true }),
 gitlab: Object.freeze({ execution: false, githubApi: false }),
} as const;
export function forgeCapabilities(ref: ForgeRef) {
 return CAPABILITIES[ref.forge];
}

/** Safe for untrusted string boundaries; invalid refs have no GitHub capability. */
export function isGithubRepo(repo: string): boolean {
 return REPO_PATTERN.test(repo) && forgeCapabilities(parseForgeRef(repo)).githubApi;
}

export function executionRefusal(repo: string): string | null {
 const ref = parseForgeRef(repo);
 return forgeCapabilities(ref).execution ? null :
  `GitLab execution is not implemented: ${repo} — registered refs cannot be walked until the forge gates and lanes are available`;
}

export function readRefusal(repo: string): string | null {
 return forgeCapabilities(parseForgeRef(repo)).githubApi ? null : `GitLab read gate is not implemented: ${repo}`;
}

/**
 * All persistent and file identities for a repository/iid pair. GitHub's
 * formats are deliberately byte-identical to the pre-forge journal/cache.
 * GitLab journal keys use the unambiguous repo#iid node key; file names use
 * reversible URL encoding, including every slash. No GitHub migration.
 */
export function encodeForgeRef(ref: ForgeRef, iid: string | number): {
 key: string; journalKey: string; cacheKey: string; fileStem: string;
} {
 const id = normalizeNodeId(ref, String(iid));
 const repo = repoIdentity(ref);
 const key = `${repo}#${id}`;
 const fileRepo = ref.forge === "github" ? ref.path.replace("/", "__") : encodeURIComponent(repo);
 return { key, journalKey: ref.forge === "github" ? `${repo}:${id}` : key, cacheKey: `frontier:${key}`, fileStem: `${fileRepo}-${id}` };
}

export const nodeKey = (repo: string, id: string | number) => encodeForgeRef(parseForgeRef(repo), id).key;
export const journalKeyFor = (repo: string, id: string | number) => encodeForgeRef(parseForgeRef(repo), id).journalKey;
export const fileStemFor = (repo: string, id: string | number) => encodeForgeRef(parseForgeRef(repo), id).fileStem;

/** Decode a map/node key with the same validation as configuration. */
export function decodeForgeKey(key: string): { repo: string; forgeRef: ForgeRef; iid: string } {
 const hash = key.lastIndexOf("#");
 if (hash < 0) throw new Error(`bad map/node key: ${key}`);
 const repo = key.slice(0, hash);
 const forgeRef = parseForgeRef(repo);
 const iid = key.slice(hash + 1);
 if (!IID_PATTERN.test(iid)) throw new Error(`bad map/node key: ${key}`);
 return { repo, forgeRef, iid };
}

/** A soma located id is local only when its full project path matches. */
export function normalizeNodeId(ref: ForgeRef, id: string): string {
 // GitHub scalar ids, including located/display text, keep their historical
 // bytes. GitLab is the new boundary that requires local numeric iids.
 if (ref.forge === "github") return id;
 const hash = id.lastIndexOf("#");
 const iid = hash < 0 ? id : id.slice(hash + 1);
 if (hash >= 0 && id.slice(0, hash) !== ref.path) {
  throw new Error(`node id '${id}' names a different project from ${qualifiedRepo(ref)}`);
 }
 if (!IID_PATTERN.test(iid)) throw new Error(`bad node iid '${id}' for ${qualifiedRepo(ref)}`);
 return iid;
}

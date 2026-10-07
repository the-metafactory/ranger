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

// Config parses once; string-only boundaries (journal rows, CLI arguments)
// reuse the same immutable value rather than inventing another interpretation.
const refs = new Map<string, ForgeRef>();
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
 refs.set(repo, ref);
 refs.set(repoIdentity(ref), ref);
 refs.set(qualifiedRepo(ref), ref);
 return ref;
}

/** GitHub keeps its historical bare identity; GitLab includes the host. */
export function repoIdentity(ref: ForgeRef): string {
 return ref.forge === "github" ? ref.path : `${ref.forge}:${ref.host}/${ref.path}`;
}

export function qualifiedRepo(ref: ForgeRef): string {
 return `${ref.forge}:${ref.host}/${ref.path}`;
}

/**
 * All persistent and file identities for a repository/iid pair. GitHub's
 * formats are deliberately byte-identical to the pre-forge journal/cache.
 * GitLab file names use reversible URL encoding, including every slash.
 */
export function encodeForgeRef(ref: ForgeRef, iid: string | number): {
 key: string; journalKey: string; cacheKey: string; fileStem: string;
} {
 const id = normalizeNodeId(ref, String(iid));
 const repo = repoIdentity(ref);
 const key = `${repo}#${id}`;
 const fileRepo = ref.forge === "github" ? ref.path.replace("/", "__") : encodeURIComponent(repo);
 return { key, journalKey: `${repo}:${id}`, cacheKey: `frontier:${key}`, fileStem: `${fileRepo}-${id}` };
}

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
 const hash = id.lastIndexOf("#");
 // GitHub's existing read surface also carries malformed scalar ids as
 // inert display text (the escalation mention guard). Preserve its keys and
 // arguments; numeric serve/action guards still decide what may execute.
 if (ref.forge === "github" && hash < 0) return id;
 const iid = hash < 0 ? id : id.slice(hash + 1);
 if (hash >= 0 && id.slice(0, hash) !== ref.path) {
  throw new Error(`node id '${id}' names a different project from ${qualifiedRepo(ref)}`);
 }
 if (!IID_PATTERN.test(iid)) throw new Error(`bad node iid '${id}' for ${qualifiedRepo(ref)}`);
 return iid;
}

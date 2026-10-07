import { parseRefAdvertisement } from "./git/pktline";

const TOKEN_TTL_S = 15 * 60;
const RENEW_BEFORE_MS = 2 * 60_000;

export class UpstreamError extends Error {}

type CachedToken = { token: string; expiresAt: number };
const tokens = new Map<string, CachedToken>();
const remotes = new Map<string, string>();

export function clearArtifactsCaches() {
  tokens.clear();
  remotes.clear();
}

// wrangler dev delivers binding errors as plain Errors with the code stripped and the
// message prefixed "ArtifactsError: " (spike finding), so fall back to the message.
const MESSAGE_CODES: [RegExp, string][] = [
  [/currently being imported/i, "IMPORT_IN_PROGRESS"],
  [/currently being forked/i, "FORK_IN_PROGRESS"],
  [/being created/i, "CREATE_IN_PROGRESS"],
  [/already exists/i, "ALREADY_EXISTS"],
  [/requires authentication/i, "REMOTE_AUTH_REQUIRED"],
  [/not found/i, "NOT_FOUND"],
  [/invalid repo name/i, "INVALID_REPO_NAME"],
  [/must be an https url/i, "INVALID_INPUT"],
  [/internal error/i, "INTERNAL_ERROR"],
];

export function artifactsErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "ArtifactsError" && typeof e.code === "string") return e.code;
  const message = typeof e.message === "string" ? e.message : "";
  if (!message.startsWith("ArtifactsError")) return null;
  return MESSAGE_CODES.find(([re]) => re.test(message))?.[1] ?? "UNKNOWN";
}

export function forgetRepoAccess(name: string) {
  tokens.delete(`${name}:read`);
  tokens.delete(`${name}:write`);
}

/** Remote URL plus a cached short-lived Artifacts token (each mint is a billed operation). */
export async function getRepoAccess(art: Artifacts, name: string, scope: "read" | "write", now: number = Date.now()) {
  const key = `${name}:${scope}`;
  const hit = tokens.get(key);
  const remote = remotes.get(name);
  if (hit && remote && hit.expiresAt - now > RENEW_BEFORE_MS) return { remote, token: hit.token };

  using repo = await art.get(name);
  const r = remote ?? (await repo.info()).remote;
  const t = await repo.createToken(scope, TOKEN_TTL_S);
  remotes.set(name, r);
  tokens.set(key, { token: t.plaintext, expiresAt: Date.parse(t.expiresAt) });
  return { remote: r, token: t.plaintext };
}

export type Ref = { name: string; kind: "branch" | "tag"; sha: string };

/** Branches and tags from the git ref advertisement (Artifacts has no branch-list API); head is null unless it exists. */
export async function listBranches(art: Artifacts, name: string) {
  const { remote, token } = await getRepoAccess(art, name, "read");
  const res = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "git/cloudflare-git" },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) forgetRepoAccess(name);
    throw new UpstreamError(`info/refs for ${name} returned ${res.status}`);
  }
  const advert = parseRefAdvertisement(new Uint8Array(await res.arrayBuffer()));
  const branches: Ref[] = [];
  const tags: Ref[] = [];
  for (const [ref, sha] of advert.refs) {
    if (ref.startsWith("refs/heads/")) branches.push({ name: ref.slice("refs/heads/".length), kind: "branch", sha });
    else if (ref.startsWith("refs/tags/") && !ref.endsWith("^{}")) {
      // An annotated tag is advertised twice; the peeled "^{}" entry is the commit it points at.
      tags.push({ name: ref.slice("refs/tags/".length), kind: "tag", sha: advert.refs.get(`${ref}^{}`) ?? sha });
    }
  }
  // HEAD's symref can name a branch that was never pushed (e.g. default "main", only "master" pushed).
  const head = advert.head !== null && branches.some((b) => b.name === advert.head) ? advert.head : null;
  const byName = (a: Ref, b: Ref) => a.name.localeCompare(b.name, undefined, { numeric: true });
  branches.sort((a, b) => (a.name === head ? -1 : b.name === head ? 1 : byName(a, b)));
  tags.sort(byName);
  return { branches, head, tags };
}

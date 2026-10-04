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

/** Branch names from the git ref advertisement (Artifacts has no branch-list API); head is null unless it exists. */
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
  const names = [...advert.refs.keys()].filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice("refs/heads/".length));
  // HEAD's symref can name a branch that was never pushed (e.g. default "main", only "master" pushed).
  const head = advert.head !== null && names.includes(advert.head) ? advert.head : null;
  const branches = names.sort((a, b) => (a === head ? -1 : b === head ? 1 : a.localeCompare(b)));
  return { branches, head };
}

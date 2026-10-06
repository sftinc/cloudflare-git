import { artifactsErrorCode } from "./artifacts";
import { findRepoByName, findRepoByStorageName, insertRepo, markProvisioned, type RepoRow } from "./db/repos";

export type ProvisionInput =
  | { kind: "create"; name: string; description: string; defaultBranch: string }
  | { kind: "import"; name: string; description: string; url: string; branch: string };
export type ProvisionStatus = "ready" | "pending" | "missing";
export type ProvisionResult = { ok: true; repo: RepoRow; status: ProvisionStatus } | { ok: false; error: string; restoreId?: string; clearUrl?: boolean };

const MESSAGES: Record<string, string> = {
  REMOTE_AUTH_REQUIRED: "No public repository at that URL (it may be private or missing). For private repos, create an empty repo and push a mirror (see README).",
  NOT_FOUND: "No repository was found at that URL.",
  INVALID_URL: "That URL doesn't point to a git repository.",
  INVALID_INPUT: "Artifacts rejected the input. Check the URL and branch.",
  INVALID_REPO_NAME: "Artifacts rejected that repository name.",
  UPSTREAM_UNAVAILABLE: "The source server couldn't be reached. Try again.",
  MEMORY_LIMIT: "The repository is too large to import. Push a mirror instead (see README).",
};

export const DESCRIPTION_MAX = 350; // same as GitHub

export function validateRepoName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) return "Use 2-63 lowercase letters, digits or hyphens, starting with a letter or digit.";
  return null;
}

function checkInput(input: ProvisionInput): ProvisionResult | null {
  const nameError = validateRepoName(input.name);
  if (nameError) return { ok: false, error: nameError };
  if (input.description.length > DESCRIPTION_MAX) return { ok: false, error: `Keep the description to ${DESCRIPTION_MAX} characters or fewer.` };
  if (input.kind === "create" && input.defaultBranch && !/^[A-Za-z0-9._/-]{1,100}$/.test(input.defaultBranch)) {
    return { ok: false, error: "That default branch name isn't valid." };
  }
  if (input.kind === "import") {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, error: "Enter a full https:// URL." };
    }
    if (url.username || url.password) {
      return { ok: false, clearUrl: true, error: "Don't put credentials in the URL. Private imports aren't supported: create an empty repo and push a mirror (see README)." };
    }
    if (url.protocol !== "https:") return { ok: false, error: "Only https:// URLs can be imported." };
  }
  return null;
}

/** Spec §10: D1 row first, then Artifacts; a failed attempt is retried by resubmitting the same name. */
export async function provisionRepo(db: D1Database, art: Artifacts, input: ProvisionInput, now: number): Promise<ProvisionResult> {
  const invalid = checkInput(input);
  if (invalid) return invalid;
  const existing = await findRepoByName(db, input.name);
  if (existing && (existing.provisioned_at !== null || existing.deleted_at !== null)) {
    return existing.deleted_at !== null
      ? { ok: false, error: `A deleted repo named "${input.name}" exists. Restore it instead.`, restoreId: existing.id }
      : { ok: false, error: `A repo named "${input.name}" already exists.` };
  }
  if (!existing) {
    // A renamed repo keeps its old name as its Artifacts name, so that name can't be reused.
    const holder = await findRepoByStorageName(db, input.name);
    if (holder) return { ok: false, error: `"${input.name}" is still the storage name of repo "${holder.name}". Pick another name.` };
  }
  const repo = existing ?? (await insertRepo(db, { name: input.name, description: input.description || null }, now));
  try {
    if (input.kind === "create") {
      await art.create(repo.storage_name, { setDefaultBranch: input.defaultBranch || "main", ...(input.description ? { description: input.description } : {}) });
    } else {
      await art.import({
        source: { url: input.url, ...(input.branch ? { branch: input.branch } : {}) },
        target: { name: repo.storage_name, ...(input.description ? { opts: { description: input.description } } : {}) },
      });
    }
  } catch (err) {
    const code = artifactsErrorCode(err);
    if (code !== "ALREADY_EXISTS") {
      console.warn(JSON.stringify({ msg: "provision failed", repo: input.name, kind: input.kind, code, error: String(err) }));
      return { ok: false, error: (code && MESSAGES[code]) ?? `Artifacts couldn't ${input.kind} the repo (${code ?? "unknown error"}). Try again.` };
    }
  }
  return { ok: true, repo, status: await refreshProvisioning(db, art, repo, now) };
}

export async function refreshProvisioning(db: D1Database, art: Artifacts, repo: RepoRow, now: number): Promise<ProvisionStatus> {
  try {
    using _h = await art.get(repo.storage_name);
    await markProvisioned(db, repo.id, now);
    return "ready";
  } catch (err) {
    const code = artifactsErrorCode(err);
    if (code?.endsWith("_IN_PROGRESS")) return "pending";
    if (code === "NOT_FOUND") return "missing";
    throw err;
  }
}

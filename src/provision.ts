import { artifactsErrorCode } from "./artifacts";
import { findAlias, findRepoByName, insertRepo, markProvisioned, retireRepo, type RepoRow } from "./db/repos";

export type ProvisionInput =
  | { kind: "create"; name: string; description: string; defaultBranch: string; takeAlias?: string }
  | { kind: "import"; name: string; description: string; url: string; branch: string; takeAlias?: string };
export type ProvisionStatus = "ready" | "pending" | "missing";
export type ProvisionResult =
  | { ok: true; repo: RepoRow; status: ProvisionStatus }
  | { ok: false; error: string; restoreId?: string; clearUrl?: boolean; takeAlias?: string };

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

/** Today's characters and length, minus the names git refuses (see git check-ref-format). */
function validBranch(b: string) {
  return (
    /^[A-Za-z0-9._/-]{1,100}$/.test(b) &&
    !/\.\.|\/\/|^\/|\/$|^-|\.$/.test(b) &&
    b.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** Spec §1a: taking another repo's old name breaks its links and clones, so the admin confirms first. */
export function aliasWarning(name: string, owner: string) {
  return `"${name}" is an old name of repo "${owner}": links and clones using "${name}" still reach "${owner}". Taking the name breaks them right away, even if the create or import then fails.`;
}

function checkInput(input: ProvisionInput): ProvisionResult | null {
  const nameError = validateRepoName(input.name);
  if (nameError) return { ok: false, error: nameError };
  if (input.description.length > DESCRIPTION_MAX) return { ok: false, error: `Keep the description to ${DESCRIPTION_MAX} characters or fewer.` };
  const branch = input.kind === "create" ? input.defaultBranch : input.branch;
  if (branch && !validBranch(branch)) return { ok: false, error: "That isn't a valid git branch name." };
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

/**
 * Spec §2: the D1 row first, then Artifacts. A row with provisioned_at NULL that is not deleted is a
 * pending create or import and holds its name. On any outcome but "ready" or "pending" this request
 * retires the row, giving the name back; resubmitting is the retry, with a fresh row and fresh storage.
 */
export async function provisionRepo(db: D1Database, art: Artifacts, input: ProvisionInput, now: number): Promise<ProvisionResult> {
  const invalid = checkInput(input);
  if (invalid) return invalid;
  const existing = await findRepoByName(db, input.name);
  if (existing) {
    if (existing.deleted_at !== null) return { ok: false, error: `A deleted repo named "${input.name}" exists. Restore it instead.`, restoreId: existing.id };
    if (existing.provisioned_at === null) return { ok: false, error: `"${input.name}" is still being imported.` };
    return { ok: false, error: `A repo named "${input.name}" already exists.` };
  }
  const alias = await findAlias(db, input.name);
  if (alias && alias.repo_id !== input.takeAlias) return { ok: false, error: aliasWarning(input.name, alias.repo_name), takeAlias: alias.repo_id };
  const repo = await insertRepo(db, { name: input.name, description: input.description || null }, now, alias?.repo_id ?? null);
  let status: ProvisionStatus = "missing";
  let code: string | null = null;
  try {
    if (input.kind === "create") {
      await art.create(repo.storage_name, { setDefaultBranch: input.defaultBranch || "main", ...(input.description ? { description: input.description } : {}) });
    } else {
      await art.import({
        source: { url: input.url, ...(input.branch ? { branch: input.branch } : {}) },
        target: { name: repo.storage_name, ...(input.description ? { opts: { description: input.description } } : {}) },
      });
    }
    status = await refreshProvisioning(db, art, repo, now);
  } catch (err) {
    code = artifactsErrorCode(err);
    console.warn(JSON.stringify({ msg: "provision failed", repo: input.name, kind: input.kind, code, error: String(err) }));
  }
  if (status !== "missing") return { ok: true, repo, status };
  // Only this request retires the row: a page refresh can't tell a failed create from one still running.
  await retireRepo(db, repo.id, now);
  const error =
    input.kind === "import" && input.branch && code === "NOT_FOUND"
      ? `Nothing was found at that URL, or it has no branch "${input.branch}".`
      : ((code && MESSAGES[code]) ?? `Artifacts couldn't ${input.kind} the repo (${code ?? "unknown error"}). Try again.`);
  return { ok: false, error };
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

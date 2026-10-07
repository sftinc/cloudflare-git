import { Hono, type Context } from "hono";
import type { AppEnv } from "../index";
import { verifyAccessJwt } from "../auth/access-jwt";
import { findAlias, findRepoById, findRepoByName, listLiveRepos, listReposForAdmin, renameRepo, retireRepo, setDeleted, setDescription, setPublic } from "../db/repos";
import { createInvite, deleteInvite, inviteStatus, listInvites, revokeInvite } from "../db/invites";
import { createPushToken, deletePushToken, listPushTokens, revokePushToken } from "../db/tokens";
import { createWebhook, deleteWebhook, listWebhooks } from "../db/webhooks";
import { randomSecret, sha256Hex } from "../lib/crypto";
import { aliasWarning, DESCRIPTION_MAX, provisionRepo, refreshProvisioning, validateRepoName, type ProvisionInput, type ProvisionStatus } from "../provision";
import { cloneUrl } from "../render/paths";
import { siteOrigin } from "../lib/site";
import { page } from "../views/layout";
import { ACCESS_LENGTHS, AdminInvites, AdminNewRepo, AdminRepo, AdminRepos, AdminTokens, REDEEM_WINDOWS, type RepoFormValues } from "../views/admin";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", async (c, next) => {
  const token = c.req.header("cf-access-jwt-assertion");
  let ok = false;
  try {
    ok = !!token && !!(await verifyAccessJwt(token, c.env));
  } catch {
    ok = false; // certs fetch failed: not authorized
  }
  if (!ok) return c.notFound();
  if (c.req.method === "POST" && c.req.header("origin") !== siteOrigin(c)) return c.text("Forbidden", 403);
  await next();
  c.res.headers.set("Cache-Control", "no-store"); // pages show secrets
});

const admin = (c: Context<AppEnv>, title: string, body: unknown, status = 200) => page(c, title, body as never, status, { admin: true });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");

async function reposPage(c: Context<AppEnv>) {
  const now = Date.now();
  const repos = await listReposForAdmin(c.env.DB);
  const pending = new Set<string>();
  for (const r of repos) {
    if (r.deleted_at === null && r.provisioned_at === null) {
      try {
        const s = await refreshProvisioning(c.env.DB, c.env.ARTIFACTS, r, now);
        if (s === "ready") r.provisioned_at = now;
        if (s === "pending") pending.add(r.id);
      } catch (err) {
        // One bad row must not lock the owner out of the list; it shows as "Import failed".
        console.error(JSON.stringify({ msg: "provisioning check failed", repo: r.name, error: String(err) }));
      }
    }
  }
  return admin(c, "Repos · admin", <AdminRepos repos={repos} pending={pending} />);
}

async function provision(c: Context<AppEnv>, input: ProvisionInput, values: RepoFormValues) {
  const result = await provisionRepo(c.env.DB, c.env.ARTIFACTS, input, Date.now());
  if (result.ok) {
    await setPublic(c.env.DB, result.repo.id, values.visibility === "public", Date.now());
    return c.redirect(`/admin/repos/${result.repo.id}`, 303);
  }
  return admin(c, "New repo · admin", <AdminNewRepo kind={input.kind} error={result.error} values={result.clearUrl ? { ...values, url: "" } : values} restoreId={result.restoreId} takeAlias={result.takeAlias} />, 422);
}

adminRoutes.get("/", (c) => c.redirect("/admin/repos", 302));
adminRoutes.get("/repos", (c) => reposPage(c));
// Before /repos/:id, so "new" is not read as an id.
adminRoutes.get("/repos/new", (c) => admin(c, "New repo · admin", <AdminNewRepo kind={c.req.query("from") === "import" ? "import" : "create"} />));

adminRoutes.post("/repos", async (c) => {
  const b = await c.req.parseBody();
  const values = { name: str(b.name), description: str(b.description), defaultBranch: str(b.defaultBranch) || "main", visibility: str(b.visibility) };
  return provision(c, { kind: "create", name: values.name, description: values.description, defaultBranch: values.defaultBranch, takeAlias: str(b.take_alias) || undefined }, values);
});

adminRoutes.post("/import", async (c) => {
  const b = await c.req.parseBody();
  const values = { name: str(b.name), description: str(b.description), url: str(b.url), branch: str(b.branch), visibility: str(b.visibility) };
  return provision(c, { kind: "import", name: values.name, description: values.description, url: values.url, branch: values.branch, takeAlias: str(b.take_alias) || undefined }, values);
});

async function repoPage(c: Context<AppEnv>, extra: { secret?: { title: string; value: string }; error?: string; description?: string; name?: string; takeAlias?: string } = {}, status = 200) {
  const repo = await findRepoById(c.env.DB, c.req.param("id")!);
  if (!repo || (repo.provisioned_at === null && repo.deleted_at !== null)) return c.notFound(); // retired: a failed create, given up
  let s: ProvisionStatus = "ready";
  if (repo.provisioned_at === null && repo.deleted_at === null) {
    s = await refreshProvisioning(c.env.DB, c.env.ARTIFACTS, repo, Date.now());
    if (s === "ready") repo.provisioned_at = Date.now();
  }
  const hooks = await listWebhooks(c.env.DB, repo.id);
  return admin(c, `${repo.name} · admin`, <AdminRepo repo={repo} status={s} hooks={hooks} now={Date.now()} renamedUrl={c.req.query("renamed") ? cloneUrl(siteOrigin(c), repo.name) : undefined} {...extra} />, status);
}

adminRoutes.get("/repos/:id", (c) => repoPage(c));

adminRoutes.post("/repos/:id/description", async (c) => {
  const repo = await findRepoById(c.env.DB, c.req.param("id"));
  if (!repo || repo.deleted_at !== null) return c.notFound();
  const description = str((await c.req.parseBody()).description);
  if (description.length > DESCRIPTION_MAX) return repoPage(c, { error: `Keep the description to ${DESCRIPTION_MAX} characters or fewer.`, description }, 422);
  await setDescription(c.env.DB, repo.id, description || null, Date.now());
  return c.redirect(`/admin/repos/${repo.id}`, 303);
});

adminRoutes.post("/repos/:id/rename", async (c) => {
  const repo = await findRepoById(c.env.DB, c.req.param("id"));
  if (!repo || repo.deleted_at !== null) return c.notFound();
  const b = await c.req.parseBody();
  const name = str(b.name);
  const takeAlias = str(b.take_alias) || null;
  const invalid = validateRepoName(name);
  if (invalid) return repoPage(c, { error: invalid, name }, 422);
  const taken = await findRepoByName(c.env.DB, name);
  if (taken && taken.id !== repo.id) {
    const error =
      taken.deleted_at !== null ? `A deleted repo is named "${name}". Restore it, or pick another name.`
      : taken.provisioned_at === null ? `"${name}" is still being imported.`
      : `A repo named "${name}" already exists.`;
    return repoPage(c, { error, name }, 422);
  }
  const alias = await findAlias(c.env.DB, name);
  if (alias && alias.repo_id !== repo.id && alias.repo_id !== takeAlias) {
    return repoPage(c, { error: aliasWarning(name, alias.repo_name), name, takeAlias: alias.repo_id }, 422);
  }
  let renamed: boolean;
  try {
    renamed = await renameRepo(c.env.DB, repo.id, name, Date.now(), takeAlias);
  } catch (err) {
    if (!String(err).includes("UNIQUE")) throw err; // another repo took the name meanwhile
    return repoPage(c, { error: `A repo named "${name}" already exists.`, name }, 422);
  }
  if (renamed) return c.redirect(`/admin/repos/${repo.id}?renamed=1`, 303);
  const current = await findRepoById(c.env.DB, repo.id);
  if (!current || current.deleted_at !== null || current.provisioned_at === null) return c.notFound();
  if (current.name === name) return c.redirect(`/admin/repos/${repo.id}`, 303);
  // Not renamed although the name looked free: another repo's old name appeared meanwhile.
  const blocking = await findAlias(c.env.DB, name);
  return repoPage(c, { error: blocking ? aliasWarning(name, blocking.repo_name) : `A repo named "${name}" already exists.`, name, takeAlias: blocking?.repo_id }, 422);
});

adminRoutes.post("/repos/:id/visibility", async (c) => {
  const b = await c.req.parseBody();
  await setPublic(c.env.DB, c.req.param("id"), b.public === "1", Date.now());
  return c.redirect(`/admin/repos/${c.req.param("id")}`, 303);
});

adminRoutes.post("/repos/:id/delete", async (c) => {
  const repo = await findRepoById(c.env.DB, c.req.param("id"));
  // A never-created repo is discarded instead, which gives its name back.
  if (!repo || repo.deleted_at !== null || repo.provisioned_at === null) return c.notFound();
  await setDeleted(c.env.DB, repo.id, true, Date.now());
  return c.redirect("/admin/repos", 303);
});

adminRoutes.post("/repos/:id/restore", async (c) => {
  const repo = await findRepoById(c.env.DB, c.req.param("id"));
  if (!repo || repo.deleted_at === null || repo.provisioned_at === null) return c.notFound(); // retired rows can't come back
  await setDeleted(c.env.DB, repo.id, false, Date.now());
  return c.redirect(`/admin/repos/${repo.id}`, 303);
});

/** Spec §2: an import that failed in the background. Checks again first: it may have finished meanwhile. */
adminRoutes.post("/repos/:id/discard", async (c) => {
  const repo = await findRepoById(c.env.DB, c.req.param("id"));
  if (!repo || repo.deleted_at !== null || repo.provisioned_at !== null) return c.notFound();
  const status = await refreshProvisioning(c.env.DB, c.env.ARTIFACTS, repo, Date.now());
  if (status === "ready") return c.redirect(`/admin/repos/${repo.id}`, 303);
  if (status === "pending") return repoPage(c, { error: "It's still importing." }, 422);
  await retireRepo(c.env.DB, repo.id, Date.now());
  return c.redirect("/admin/repos", 303);
});

function webhookUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Enter a full URL.";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "Webhook URLs must use https://.";
  return null;
}

adminRoutes.post("/repos/:id/webhooks", async (c) => {
  const b = await c.req.parseBody();
  const url = str(b.url);
  const error = webhookUrlError(url);
  if (error) return repoPage(c, { error }, 422);
  const secret = randomSecret();
  await createWebhook(c.env.DB, { repoId: c.req.param("id"), url, branch: str(b.branch).replace(/^refs\/heads\//, "") || null, secret }, Date.now());
  return repoPage(c, { secret: { title: "Webhook signing secret", value: secret } });
});

adminRoutes.post("/repos/:id/webhooks/:hid/delete", async (c) => {
  await deleteWebhook(c.env.DB, c.req.param("hid"), Date.now());
  return c.redirect(`/admin/repos/${c.req.param("id")}`, 303);
});

adminRoutes.post("/repos/:id/direct-push", async (c) => {
  const repo = await findRepoById(c.env.DB, c.req.param("id"));
  if (!repo) return c.notFound();
  using h = await c.env.ARTIFACTS.get(repo.storage_name);
  const [{ remote }, token] = await Promise.all([h.info(), h.createToken("write", 3600)]);
  const url = new URL(remote);
  url.username = "x";
  url.password = token.plaintext.split("?expires=")[0];
  return repoPage(c, { secret: { title: "Direct push URL (1 hour)", value: url.toString() } });
});

async function invitesPage(c: Context<AppEnv>, extra: { link?: string; error?: string } = {}, status = 200) {
  const now = Date.now();
  const invites = (await listInvites(c.env.DB)).map((i) => ({ ...i, status: inviteStatus(i, now) }));
  return admin(c, "Invites · admin", <AdminInvites invites={invites} repos={await listLiveRepos(c.env.DB)} {...extra} />, status);
}

adminRoutes.get("/invites", (c) => invitesPage(c));

adminRoutes.post("/invites", async (c) => {
  const b = await c.req.parseBody({ all: true });
  const label = str(b.label);
  const repoIds = list(b.repos);
  const allRepos = str(b.all) === "1";
  const redeem = REDEEM_WINDOWS[str(b.redeem)];
  const access = str(b.access);
  if (!label || (!allRepos && repoIds.length === 0) || redeem === undefined || !(access in ACCESS_LENGTHS)) {
    return invitesPage(c, { error: "Give the invite a name and pick at least one repo, or All repositories." }, 422);
  }
  const code = randomSecret();
  const now = Date.now();
  await createInvite(c.env.DB, { label, codeHash: await sha256Hex(code), accessMs: ACCESS_LENGTHS[access], redeemByAt: now + redeem, repoIds, allRepos }, now);
  return invitesPage(c, { link: `${siteOrigin(c)}/invite/${code}` });
});

adminRoutes.post("/invites/:id/revoke", async (c) => {
  await revokeInvite(c.env.DB, c.req.param("id"), Date.now());
  return c.redirect("/admin/invites", 303);
});

adminRoutes.post("/invites/:id/delete", async (c) => {
  await deleteInvite(c.env.DB, c.req.param("id"), Date.now());
  return c.redirect("/admin/invites", 303);
});

async function tokensPage(c: Context<AppEnv>, extra: { created?: string; error?: string } = {}, status = 200) {
  return admin(c, "Push tokens · admin", <AdminTokens tokens={await listPushTokens(c.env.DB)} repos={await listLiveRepos(c.env.DB)} now={Date.now()} origin={siteOrigin(c)} {...extra} />, status);
}

adminRoutes.get("/tokens", (c) => tokensPage(c));

adminRoutes.post("/tokens", async (c) => {
  const b = await c.req.parseBody({ all: true });
  const name = str(b.name);
  const repoIds = list(b.repos);
  const allRepos = str(b.all) === "1";
  if (!name || (!allRepos && repoIds.length === 0)) {
    return tokensPage(c, { error: "Give the token a name and pick at least one repo, or All repositories." }, 422);
  }
  const now = Date.now();
  const ms = ACCESS_LENGTHS[str(b.expires)] ?? null;
  const token = randomSecret();
  await createPushToken(c.env.DB, { name, tokenHash: await sha256Hex(token), repoIds, allRepos, expiresAt: ms === null ? null : now + ms }, now);
  return tokensPage(c, { created: token });
});

adminRoutes.post("/tokens/:id/revoke", async (c) => {
  await revokePushToken(c.env.DB, c.req.param("id"), Date.now());
  return c.redirect("/admin/tokens", 303);
});

adminRoutes.post("/tokens/:id/delete", async (c) => {
  await deletePushToken(c.env.DB, c.req.param("id"), Date.now());
  return c.redirect("/admin/tokens", 303);
});

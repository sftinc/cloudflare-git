import type { RepoRow } from "../db/repos";
import type { InviteRow } from "../db/invites";
import type { PushTokenRow } from "../db/tokens";
import type { WebhookRow } from "../db/webhooks";
import { fmtDate, NO_REPOS_OWNER } from "./public";
import { repoHref } from "../render/paths";
import { GitSetup } from "./git-setup";
import { DESCRIPTION_MAX } from "../provision";
import { Book, Download, Plus } from "./icons";

const day = (ms: number) => fmtDate(Math.floor(ms / 1000));

export type RepoFormValues = { name?: string; description?: string; defaultBranch?: string; url?: string; branch?: string; visibility?: string };

export function Secret(props: { title: string; value: string; children?: unknown }) {
  return (
    <div class="secret">
      <strong>{props.title}</strong> <span class="muted">Shown once. Copy it now.</span>
      <code id="secret">{props.value}</code>
      <button type="button" class="btn" data-copy={props.value}>Copy</button>
      {props.children}
    </div>
  );
}

function Post(props: { action: string; label: string; class?: string; name?: string; value?: string }) {
  return (
    <form method="post" action={props.action}>
      {props.name && <input type="hidden" name={props.name} value={props.value} />}
      <button type="submit" class={props.class}>{props.label}</button>
    </form>
  );
}

export function repoState(r: RepoRow, pending: Set<string>) {
  if (r.deleted_at !== null) return <span class="badge bad">Deleted</span>;
  if (r.provisioned_at === null) return pending.has(r.id) ? <span class="badge warn">Importing…</span> : <span class="badge bad">Not created</span>;
  return r.public_at !== null ? <span class="badge ok">Public</span> : <span class="badge">Private</span>;
}

function VisibilitySelect(props: { private: boolean }) {
  return (
    <label>Visibility
      <select name="visibility">
        <option value="public" selected={!props.private}>Public: anyone can browse and clone</option>
        <option value="private" selected={props.private}>Private: only you and invitees</option>
      </select>
    </label>
  );
}

export function AdminRepos(props: { repos: RepoRow[]; pending: Set<string> }) {
  const live = props.repos.filter((r) => r.deleted_at === null);
  const deleted = props.repos.filter((r) => r.deleted_at !== null);
  return (
    <>
      <h1 class="page-title">Repos</h1>
      {live.length === 0 ? (
        <section class="card empty">
          <span class="empty-icon"><Book /></span>
          <h2>No repos yet</h2>
          <p class="muted">{NO_REPOS_OWNER}</p>
        </section>
      ) : (
      <div class="card table-scroll">
        <table class="list">
          <thead><tr><th>Name</th><th>State</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {live.map((r) => (
              <tr>
                <td><a href={`/admin/repos/${r.id}`}><strong>{r.name}</strong></a>{r.description && <div class="muted">{r.description}</div>}</td>
                <td>{repoState(r, props.pending)}</td>
                <td class="muted">{day(r.created_at)}</td>
                <td>{r.provisioned_at !== null && <a href={repoHref(r.name)}>View</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {deleted.length > 0 && (
        <section class="card table-scroll">
          <h2>Deleted</h2>
          <table class="list">
            <tbody>
              {deleted.map((r) => (
                <tr><td>{r.name}</td><td class="muted">deleted {day(r.deleted_at!)}</td><td><Post action={`/admin/repos/${r.id}/restore`} label="Restore" /></td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

const remaining = (text: string) => `${Math.max(0, DESCRIPTION_MAX - text.length)} characters remaining`;

const NAME_INPUT = { type: "text", name: "name", required: true, pattern: "[a-z0-9][a-z0-9\\-]{1,62}", title: "2-63 lowercase letters, digits or hyphens, starting with a letter or digit" };

export function AdminNewRepo(props: { kind: "create" | "import"; error?: string; values?: RepoFormValues; restoreId?: string }) {
  const v = props.values ?? {};
  const create = props.kind === "create";
  const name = <label>Name <span class="hint">lowercase letters, digits, hyphens</span><input {...NAME_INPUT} value={v.name ?? ""} /></label>;
  const description = (
    <label>Description <span class="hint">optional</span>
      <input type="text" name="description" maxlength={DESCRIPTION_MAX} value={v.description ?? ""} aria-describedby="description-remaining" data-remaining="description-remaining" />
      <span class="hint remaining" id="description-remaining">{remaining(v.description ?? "")}</span>
    </label>
  );
  return (
    <>
      <h1 class="page-title">New repo</h1>
      <div class="form-card">
        <nav class="source-pick" aria-label="Start from">
          <a href="/admin/repos/new" aria-current={create ? "page" : undefined}>
            <span class="pick-icon"><Plus /></span>
            <span><strong>Empty</strong><span class="muted">Push your code to a new repository.</span></span>
          </a>
          <a href="/admin/repos/new?from=import" aria-current={create ? undefined : "page"}>
            <span class="pick-icon"><Download /></span>
            <span><strong>Import</strong><span class="muted">Copy one branch from a public URL.</span></span>
          </a>
        </nav>
        {props.error && (
          <div class="error">
            {props.error} {props.restoreId && <Post action={`/admin/repos/${props.restoreId}/restore`} label="Restore it" class="link" />}
          </div>
        )}
        <section class="card">
          {create ? (
            <form method="post" action="/admin/repos" class="stack">
              {name}
              {description}
              <label>Default branch<input type="text" name="defaultBranch" value={v.defaultBranch || "main"} /></label>
              <VisibilitySelect private={v.visibility === "private"} />
              <button type="submit" class="primary">Create repository</button>
            </form>
          ) : (
            <form method="post" action="/admin/import" class="stack">
              <label>Source URL<input type="url" name="url" required placeholder="https://github.com/you/repo" value={v.url ?? ""} /></label>
              <label>Branch <span class="hint">optional, defaults to the source's default</span><input type="text" name="branch" value={v.branch ?? ""} /></label>
              <p class="hint">Imports one branch and no tags. For every branch and tag, create an empty repository and push a mirror (see README).</p>
              {name}
              {description}
              <VisibilitySelect private={v.visibility === "private"} />
              <button type="submit" class="primary">Import repository</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}

export function AdminRepo(props: {
  repo: RepoRow; status: "ready" | "pending" | "missing"; hooks: WebhookRow[];
  secret?: { title: string; value: string }; error?: string; description?: string;
}) {
  const r = props.repo;
  const description = props.description ?? r.description ?? "";
  const live = r.deleted_at === null && r.provisioned_at !== null;
  return (
    <>
      <h1 class="page-title settings-title">
        <Book /><a href="/admin/repos" class="crumb">Repos</a><span class="sep">/</span><span class="settings-name">{r.name}</span>
        {repoState(r, new Set(props.status === "pending" ? [r.id] : []))}
      </h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.secret && <Secret title={props.secret.title} value={props.secret.value} />}
      {live && (
        <>
          <h2 class="section-title">General</h2>
          <div class="box">
            <form method="post" action={`/admin/repos/${r.id}/description`} class="row field-row">
              <label for="description">Description</label>
              <div class="inline">
                <input type="text" id="description" name="description" maxlength={DESCRIPTION_MAX} placeholder="Short description of this repo" value={description} aria-describedby="description-remaining" data-remaining="description-remaining" />
                <button type="submit">Save</button>
              </div>
              <span class="hint" id="description-remaining">{remaining(description)}</span>
            </form>
          </div>
          <h2 class="section-title">Webhooks</h2>
          <p class="section-lead">Called after each push to this repo.</p>
          <div class="box">
            {props.hooks.map((h) => (
              <div class="row hook">
                <code>{h.url}</code>
                {h.branch ? <span class="tag">{h.branch}</span> : <span class="tag all">All branches</span>}
                <Post action={`/admin/repos/${r.id}/webhooks/${h.id}/delete`} label="Delete" class="danger" />
              </div>
            ))}
            {props.hooks.length === 0 && <p class="row muted">No webhooks yet.</p>}
            <form method="post" action={`/admin/repos/${r.id}/webhooks`} class="row field-row add-hook">
              <label for="hook-url">Add webhook</label>
              <div class="inline">
                <input type="url" id="hook-url" name="url" required placeholder="https://builds.example.com/hook" />
                <input type="text" name="branch" class="branch" placeholder="Branch (optional)" aria-label="Branch (optional)" />
                <button type="submit" class="primary">Add webhook</button>
              </div>
            </form>
          </div>
          <h2 class="section-title">Direct push</h2>
          <div class="box">
            <div class="row">
              <div class="row-text"><strong>Push more than 100 MB</strong><span>Pushes through this site stop at 100 MB. Get a one-hour URL that pushes straight to storage. Webhooks don't fire for direct pushes.</span></div>
              <Post action={`/admin/repos/${r.id}/direct-push`} label="Get a direct push URL" />
            </div>
          </div>
        </>
      )}
      <h2 class="section-title danger">Danger Zone</h2>
      <div class="box danger-zone">
        {r.deleted_at !== null ? (
          <div class="row">
            <div class="row-text"><strong>Restore this repo</strong><span>Bring it back with its webhooks and access.</span></div>
            <Post action={`/admin/repos/${r.id}/restore`} label="Restore this repo" />
          </div>
        ) : (
          <>
            {live && (
              <div class="row">
                <div class="row-text">
                  <strong>Change visibility</strong>
                  <span>{r.public_at !== null ? "This repo is public: anyone can browse and clone it." : "This repo is private: only you and invitees can see it."}</span>
                </div>
                {r.public_at !== null
                  ? <Post action={`/admin/repos/${r.id}/visibility`} name="public" value="0" label="Make private" class="danger" />
                  : <Post action={`/admin/repos/${r.id}/visibility`} name="public" value="1" label="Make public" class="danger" />}
              </div>
            )}
            <div class="row">
              <div class="row-text"><strong>Delete this repo</strong><span>You can restore it later from the Repos page.</span></div>
              <Post action={`/admin/repos/${r.id}/delete`} label="Delete this repo" class="danger" />
            </div>
          </>
        )}
      </div>
    </>
  );
}

export const REDEEM_WINDOWS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };
export const ACCESS_LENGTHS: Record<string, number | null> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "1y": 365 * 86_400_000, never: null };
const ACCESS_LABELS: Record<string, string> = { "7d": "7 days", "30d": "30 days", "1y": "1 year", never: "Never" };

/** Same lengths, order and labels for invites and push tokens; only the default differs. */
function ExpirySelect(props: { name: string; selected: string }) {
  return (
    <select name={props.name}>
      {Object.keys(ACCESS_LENGTHS).map((k) => <option value={k} selected={k === props.selected}>{ACCESS_LABELS[k]}</option>)}
    </select>
  );
}

export function AdminInvites(props: { invites: (InviteRow & { repo_names: string; status: string })[]; repos: RepoRow[]; link?: string; error?: string }) {
  return (
    <>
      <h1 class="page-title">Invites</h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.link && <Secret title="Invite link" value={props.link} />}
      <section class="card form-card">
        <h2>New invite</h2>
        <form method="post" action="/admin/invites" class="stack">
          <label>Who is it for?<input type="text" name="label" required placeholder="Sam" /></label>
          <label>Link must be opened within
            <select name="redeem"><option value="1h">1 hour</option><option value="24h" selected>24 hours</option><option value="7d">7 days</option></select>
          </label>
          <label>Access lasts
            <ExpirySelect name="access" selected="30d" />
          </label>
          <fieldset>
            <legend>Repos</legend>
            <label><input type="checkbox" name="all" value="1" /> All repositories, including new ones</label>
            {props.repos.map((r) => <label><input type="checkbox" name="repos" value={r.id} /> {r.name} {r.public_at === null ? "" : <span class="muted">(public)</span>}</label>)}
          </fieldset>
          <button type="submit" class="primary">Create invite link</button>
        </form>
      </section>
      {props.invites.length > 0 && (
        <div class="card table-scroll">
          <table class="list">
            <thead><tr><th>For</th><th>Repos</th><th>Status</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {props.invites.map((i) => (
                <tr>
                  <td>{i.label}</td>
                  <td>{i.all_repos_at !== null ? "All repositories" : i.repo_names || <span class="muted">none</span>}</td>
                  <td><span class={`badge ${i.status === "active" ? "ok" : i.status === "waiting" ? "warn" : "bad"}`}>{i.status}</span></td>
                  <td class="muted">{i.redeemed_at === null ? `open by ${day(i.redeem_by_at)}` : i.access_expires_at === null ? "never" : day(i.access_expires_at)}</td>
                  <td class="actions">
                    {i.revoked_at === null && <Post action={`/admin/invites/${i.id}/revoke`} label="Revoke" />}
                    <Post action={`/admin/invites/${i.id}/delete`} label="Delete" class="danger" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AdminTokens(props: { tokens: (PushTokenRow & { repo_names: string | null })[]; repos: RepoRow[]; now: number; created?: string; origin: string; error?: string }) {
  return (
    <>
      <h1 class="page-title">Push tokens</h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.created && (
        <Secret title="New push token" value={props.created}>
          <GitSetup origin={props.origin} password={props.created} />
        </Secret>
      )}
      {props.tokens.length > 0 && (
        <div class="card table-scroll">
          <table class="list">
            <thead><tr><th>Name</th><th>Repos</th><th>Last used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {props.tokens.map((t) => (
                <tr>
                  <td>{t.name}</td>
                  <td>{t.all_repos_at !== null ? "All repositories" : t.repo_names ?? <span class="muted">none</span>}</td>
                  <td class="muted">{t.last_used_at ? day(t.last_used_at) : "never"}</td>
                  <td class="muted">{t.expires_at ? day(t.expires_at) : "never"}</td>
                  <td>{t.revoked_at !== null ? <span class="badge bad">revoked</span> : t.expires_at !== null && t.expires_at <= props.now ? <span class="badge bad">expired</span> : <span class="badge ok">active</span>}</td>
                  <td class="actions">
                    {t.revoked_at === null && <Post action={`/admin/tokens/${t.id}/revoke`} label="Revoke" />}
                    <Post action={`/admin/tokens/${t.id}/delete`} label="Delete" class="danger" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section class="card form-card">
        <h2>New token</h2>
        <form method="post" action="/admin/tokens" class="stack">
          <label>Name<input type="text" name="name" required placeholder="laptop" /></label>
          <label>Expires
            <ExpirySelect name="expires" selected="never" />
          </label>
          <fieldset>
            <legend>Repos</legend>
            <label><input type="checkbox" name="all" value="1" /> All repositories, including new ones</label>
            {props.repos.map((r) => <label><input type="checkbox" name="repos" value={r.id} /> {r.name}</label>)}
          </fieldset>
          <button type="submit" class="primary">Create token</button>
        </form>
      </section>
    </>
  );
}

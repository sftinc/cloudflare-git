import type { RepoRow } from "../db/repos";
import type { InviteRow } from "../db/invites";
import type { PushTokenRow } from "../db/tokens";
import type { WebhookRow } from "../db/webhooks";
import { fmtDate } from "./public";

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

export function AdminRepos(props: { repos: RepoRow[]; pending: Set<string>; error?: string; form?: "create" | "import"; values?: RepoFormValues; restoreId?: string }) {
  const v = props.values ?? {};
  const live = props.repos.filter((r) => r.deleted_at === null);
  const deleted = props.repos.filter((r) => r.deleted_at !== null);
  return (
    <>
      <h1 class="page-title">Repositories</h1>
      {props.error && (
        <div class="error">
          {props.error} {props.restoreId && <Post action={`/admin/repos/${props.restoreId}/restore`} label="Restore it" class="link" />}
        </div>
      )}
      <div class="card table-scroll">
        <table class="list">
          <thead><tr><th>Name</th><th>State</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {live.map((r) => (
              <tr>
                <td><a href={`/admin/repos/${r.id}`}><strong>{r.name}</strong></a>{r.description && <div class="muted">{r.description}</div>}</td>
                <td>{repoState(r, props.pending)}</td>
                <td class="muted">{day(r.created_at)}</td>
                <td>{r.provisioned_at !== null && <a href={`/${r.name}`}>View</a>}</td>
              </tr>
            ))}
            {live.length === 0 && <tr><td colspan={4} class="muted">No repositories yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div class="grid-2">
        <section class="card" id="new">
          <h2>Create an empty repo</h2>
          <form method="post" action="/admin/repos" class="stack">
            <label>Name <span class="hint">lowercase letters, digits, hyphens</span><input type="text" name="name" required pattern="[a-z0-9][a-z0-9\-]{1,62}" title="2-63 lowercase letters, digits or hyphens, starting with a letter or digit" value={props.form === "create" ? v.name : ""} /></label>
            <label>Description <span class="hint">optional</span><input type="text" name="description" value={props.form === "create" ? v.description : ""} /></label>
            <label>Default branch<input type="text" name="defaultBranch" value={props.form === "create" ? v.defaultBranch || "main" : "main"} /></label>
            <VisibilitySelect private={props.form === "create" && v.visibility === "private"} />
            <button type="submit" class="primary">Create</button>
          </form>
        </section>
        <section class="card">
          <h2>Import from a public URL</h2>
          <form method="post" action="/admin/import" class="stack">
            <label>Name <span class="hint">lowercase letters, digits, hyphens</span><input type="text" name="name" required pattern="[a-z0-9][a-z0-9\-]{1,62}" title="2-63 lowercase letters, digits or hyphens, starting with a letter or digit" value={props.form === "import" ? v.name : ""} /></label>
            <label>Source URL<input type="url" name="url" required placeholder="https://github.com/you/repo" value={props.form === "import" ? v.url : ""} /></label>
            <label>Branch <span class="hint">optional, defaults to the source's default</span><input type="text" name="branch" value={props.form === "import" ? v.branch : ""} /></label>
            <p class="hint">Imports one branch and no tags. For every branch and tag, create an empty repo and push a mirror (see README).</p>
            <label>Description <span class="hint">optional</span><input type="text" name="description" value={props.form === "import" ? v.description : ""} /></label>
            <VisibilitySelect private={props.form === "import" && v.visibility === "private"} />
            <button type="submit" class="primary">Import</button>
          </form>
        </section>
      </div>
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

export function AdminRepo(props: {
  repo: RepoRow; status: "ready" | "pending" | "missing"; origin: string; hooks: WebhookRow[];
  secret?: { title: string; value: string }; error?: string;
}) {
  const r = props.repo;
  const cloneUrl = `${props.origin}/${r.name}.git`;
  const statusText = r.provisioned_at !== null ? "Ready" : props.status === "pending" ? "Importing…" : "Not created";
  return (
    <>
      <p><a href="/admin">← Repositories</a></p>
      <h1 class="page-title">{r.name} {repoState(r, new Set(props.status === "pending" ? [r.id] : []))}</h1>
      <p class="muted">Status: {statusText}</p>
      {props.error && <div class="error">{props.error}</div>}
      {props.secret && <Secret title={props.secret.title} value={props.secret.value} />}
      <section class="card">
        <h2>Access</h2>
        <p>Clone / push URL: <code>{cloneUrl}</code> <button type="button" class="btn" data-copy={cloneUrl}>Copy</button></p>
        <div class="actions">
          {r.deleted_at === null && r.provisioned_at !== null && (
            r.public_at === null
              ? <Post action={`/admin/repos/${r.id}/visibility`} name="public" value="1" label="Make public" />
              : <Post action={`/admin/repos/${r.id}/visibility`} name="public" value="0" label="Make private" />
          )}
          {r.provisioned_at !== null && <a class="btn" href={`/${r.name}`}>View</a>}
          {r.deleted_at === null
            ? <Post action={`/admin/repos/${r.id}/delete`} label="Delete" class="danger" />
            : <Post action={`/admin/repos/${r.id}/restore`} label="Restore" />}
        </div>
        <p class="muted">Pushing: use a push token as the password. <code>git remote add origin {cloneUrl}</code> then <code>git push -u origin main</code>.</p>
      </section>
      <section class="card table-scroll">
        <h2>Webhooks</h2>
        <table class="list">
          <thead><tr><th>URL</th><th>Branch</th><th></th></tr></thead>
          <tbody>
            {props.hooks.map((h) => (
              <tr><td><code>{h.url}</code></td><td>{h.branch ?? <span class="muted">all</span>}</td><td><Post action={`/admin/repos/${r.id}/webhooks/${h.id}/delete`} label="Delete" class="danger" /></td></tr>
            ))}
            {props.hooks.length === 0 && <tr><td colspan={3} class="muted">No webhooks.</td></tr>}
          </tbody>
        </table>
        <form method="post" action={`/admin/repos/${r.id}/webhooks`} class="stack">
          <label>URL<input type="url" name="url" required placeholder="https://builds.example.com/hook" /></label>
          <label>Branch <span class="hint">optional; empty means every branch</span><input type="text" name="branch" /></label>
          <button type="submit" class="primary">Add webhook</button>
        </form>
      </section>
      {r.provisioned_at !== null && (
        <section class="card">
          <h2>Direct push (over 100 MB)</h2>
          <p class="muted">Pushes through this site are limited to 100 MB. For a bigger push, push straight to storage with a one-hour URL. Webhooks don't fire for direct pushes.</p>
          <form method="post" action={`/admin/repos/${r.id}/direct-push`} class="stack"><button type="submit">Get a direct push URL</button></form>
        </section>
      )}
    </>
  );
}

export const REDEEM_WINDOWS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };
export const ACCESS_LENGTHS: Record<string, number | null> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "1y": 365 * 86_400_000, never: null };

export function AdminInvites(props: { invites: (InviteRow & { repo_names: string; status: string })[]; repos: RepoRow[]; link?: string; error?: string }) {
  return (
    <>
      <h1 class="page-title">Invites</h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.link && <Secret title="Invite link" value={props.link} />}
      <section class="card">
        <h2>New invite</h2>
        <form method="post" action="/admin/invites" class="stack">
          <label>Who is it for?<input type="text" name="label" required placeholder="Sam" /></label>
          <fieldset>
            <legend>Repositories</legend>
            {props.repos.map((r) => <label><input type="checkbox" name="repos" value={r.id} /> {r.name} {r.public_at === null ? "" : <span class="muted">(public)</span>}</label>)}
          </fieldset>
          <label>Link must be opened within
            <select name="redeem"><option value="1h">1 hour</option><option value="24h" selected>24 hours</option><option value="7d">7 days</option></select>
          </label>
          <label>Access lasts
            <select name="access"><option value="7d">7 days</option><option value="30d" selected>30 days</option><option value="1y">1 year</option><option value="never">Never expires</option></select>
          </label>
          <button type="submit" class="primary">Create invite link</button>
        </form>
      </section>
      <div class="card table-scroll">
        <table class="list">
          <thead><tr><th>For</th><th>Repos</th><th>Status</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {props.invites.map((i) => (
              <tr>
                <td>{i.label}</td>
                <td>{i.repo_names || <span class="muted">none</span>}</td>
                <td><span class={`badge ${i.status === "active" ? "ok" : i.status === "waiting" ? "warn" : "bad"}`}>{i.status}</span></td>
                <td class="muted">{i.redeemed_at === null ? `open by ${day(i.redeem_by_at)}` : i.access_expires_at === null ? "never" : day(i.access_expires_at)}</td>
                <td class="actions">
                  {i.revoked_at === null && <Post action={`/admin/invites/${i.id}/revoke`} label="Revoke" />}
                  <Post action={`/admin/invites/${i.id}/delete`} label="Delete" class="danger" />
                </td>
              </tr>
            ))}
            {props.invites.length === 0 && <tr><td colspan={5} class="muted">No invites yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function AdminTokens(props: { tokens: (PushTokenRow & { repo_names: string | null })[]; repos: RepoRow[]; created?: string; origin: string; error?: string }) {
  return (
    <>
      <h1 class="page-title">Push tokens</h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.created && (
        <Secret title="New push token" value={props.created}>
          <p class="muted">Use it as the password when git asks (any username). On a Mac, the keychain remembers it. For CI, set <code>GIT_PUSH_TOKEN</code> and run <code>git config --global credential.helper '!f() {"{"} echo username=x; echo password=$GIT_PUSH_TOKEN; {"}"}; f'</code>.</p>
        </Secret>
      )}
      <section class="card">
        <h2>New token</h2>
        <form method="post" action="/admin/tokens" class="stack">
          <label>Name<input type="text" name="name" required placeholder="laptop" /></label>
          <fieldset>
            <legend>Limit to repos <span class="hint">none checked = all repos</span></legend>
            {props.repos.map((r) => <label><input type="checkbox" name="repos" value={r.id} /> {r.name}</label>)}
          </fieldset>
          <button type="submit" class="primary">Create token</button>
        </form>
      </section>
      <div class="card table-scroll">
        <table class="list">
          <thead><tr><th>Name</th><th>Repos</th><th>Last used</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {props.tokens.map((t) => (
              <tr>
                <td>{t.name}</td>
                <td>{t.repo_names ?? <span class="muted">all</span>}</td>
                <td class="muted">{t.last_used_at ? day(t.last_used_at) : "never"}</td>
                <td>{t.revoked_at === null ? <span class="badge ok">active</span> : <span class="badge bad">revoked</span>}</td>
                <td class="actions">
                  {t.revoked_at === null && <Post action={`/admin/tokens/${t.id}/revoke`} label="Revoke" />}
                  <Post action={`/admin/tokens/${t.id}/delete`} label="Delete" class="danger" />
                </td>
              </tr>
            ))}
            {props.tokens.length === 0 && <tr><td colspan={5} class="muted">No tokens yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

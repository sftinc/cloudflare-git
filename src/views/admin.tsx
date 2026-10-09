import type { RepoRow } from "../db/repos";
import type { InviteRow } from "../db/invites";
import type { PushTokenRow } from "../db/tokens";
import type { WebhookRow } from "../db/webhooks";
import { fmtAgo, fmtDate, NO_REPOS_OWNER, plural } from "./public";
import { DAY_MS } from "../purge";
import { repoHref } from "../render/paths";
import { GitSetup } from "./git-setup";
import { DESCRIPTION_MAX } from "../provision";
import { Book, Copy, Download, Plus, Terminal } from "./icons";

const day = (ms: number) => fmtDate(Math.floor(ms / 1000));
const dayTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** "Last delivery: 200, 3 minutes ago"; any non-2xx result counts as failed. */
function lastDelivery(h: WebhookRow, now: number) {
  if (h.last_attempt_at === null) return "No deliveries yet";
  return `Last delivery${/^2\d\d$/.test(h.last_result ?? "") ? "" : " failed"}: ${h.last_result}, ${fmtAgo(h.last_attempt_at, now)}`;
}

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

/** After a refresh the one-time value is gone with its cookie. */
function Gone(props: { title: string }) {
  return (
    <div class="secret">
      <strong>{props.title}</strong> <span class="muted">It can't be shown again: revoke it and create a new one.</span>
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
  if (r.provisioned_at === null) return pending.has(r.id) ? <span class="badge warn">Importing…</span> : <span class="badge bad">Import failed</span>;
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

export function AdminRepos(props: { repos: RepoRow[]; pending: Set<string>; restoreDays: number; now: number }) {
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
                <td>
                  {r.provisioned_at !== null
                    ? <a href={repoHref(r.name)}>View</a>
                    : !props.pending.has(r.id) && <Post action={`/admin/repos/${r.id}/discard`} label="Discard" class="danger" />}
                </td>
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
                <tr>
                  <td><a href={`/admin/repos/${r.id}`}>{r.name}</a></td>
                  <td class="muted">{`deleted ${day(r.deleted_at!)} · can be restored for ${plural(Math.ceil((r.deleted_at! + props.restoreDays * DAY_MS - props.now) / DAY_MS), "more day")}`}</td>
                  <td><Post action={`/admin/repos/${r.id}/restore`} label="Restore" /></td>
                </tr>
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

export function AdminNewRepo(props: { kind: "create" | "import"; error?: string; values?: RepoFormValues; restoreId?: string; takeAlias?: string }) {
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
            {props.takeAlias && <button type="submit" form="repo-form" name="take_alias" value={props.takeAlias} class="link">Take the name anyway</button>}
          </div>
        )}
        <section class="card">
          {create ? (
            <form method="post" action="/admin/repos" class="stack" id="repo-form">
              {name}
              {description}
              <label>Default branch<input type="text" name="defaultBranch" value={v.defaultBranch || "main"} /></label>
              <VisibilitySelect private={v.visibility === "private"} />
              <button type="submit" class="primary">Create repository</button>
            </form>
          ) : (
            <form method="post" action="/admin/import" class="stack" id="repo-form">
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

/** Spec §9: the make-public dialog's checkboxes; the server requires every value. */
export const MAKE_PUBLIC_ACKS: [string, string][] = [
  ["browse", "Anyone can browse and clone it without signing in."],
  ["history", "Every branch, tag and past commit becomes visible, including anything ever committed and later removed (keys, passwords)."],
  ["copies", "Making it private again won't undo copies people or search engines have already made."],
];

export function AdminRepo(props: {
  repo: RepoRow; status: "ready" | "pending" | "missing"; hooks: WebhookRow[]; now: number; restoreDays: number;
  secret?: { title: string; value: string }; error?: string; description?: string; name?: string; cloneUrl: string; renamed?: boolean; takeAlias?: string;
}) {
  const r = props.repo;
  const description = props.description ?? r.description ?? "";
  const live = r.deleted_at === null && r.provisioned_at !== null;
  return (
    <>
      <h1 class="page-title settings-title">
        <Book /><a href="/admin/repos" class="crumb">Repos</a><span class="sep">/</span><span class="settings-name">{r.name}</span>
        {repoState(r, new Set(props.status === "pending" ? [r.id] : []))}
        {live && (
          <div class="clone title-clone">
            <Terminal />
            <code>{props.cloneUrl}</code>
            <button type="button" class="btn" data-copy={props.cloneUrl} aria-label="Copy clone URL" title="Copy"><Copy /></button>
          </div>
        )}
      </h1>
      {props.error && (
        <div class="error">
          {props.error} {props.takeAlias && <button type="submit" form="rename-form" name="take_alias" value={props.takeAlias} class="link">Take the name anyway</button>}
        </div>
      )}
      {props.secret && <Secret title={props.secret.title} value={props.secret.value} />}
      {live && (
        <>
          {props.renamed && (
            <div class="secret">
              <strong>Repository renamed.</strong> <span class="muted">Update your existing clones:</span>
              <div class="clone">
                <code>git remote set-url origin {props.cloneUrl}</code>
                <button type="button" class="btn" data-copy={`git remote set-url origin ${props.cloneUrl}`} aria-label="Copy command" title="Copy"><Copy /></button>
              </div>
            </div>
          )}
          <h2 class="section-title">General</h2>
          <div class="box">
            <form method="post" action={`/admin/repos/${r.id}/rename`} class="row field-row" id="rename-form">
              <label for="repo-name">Repository name</label>
              <div class="inline">
                <input {...NAME_INPUT} id="repo-name" value={props.name ?? r.name} aria-describedby="repo-name-hint" />
                <button type="submit">Rename</button>
              </div>
              <span class="hint" id="repo-name-hint">Old links and clone URLs keep working.</span>
            </form>
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
                <span class="hook-status muted">{lastDelivery(h, props.now)}</span>
                <details class="hook-secret">
                  <summary>Show secret</summary>
                  <code>{h.secret}</code>
                  <button type="button" class="btn" data-copy={h.secret}>Copy</button>
                </details>
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
          r.deleted_at > props.now - props.restoreDays * DAY_MS ? (
            <div class="row">
              <div class="row-text"><strong>Restore this repo</strong><span>Bring it back with its webhooks and access.</span></div>
              <Post action={`/admin/repos/${r.id}/restore`} label="Restore this repo" />
            </div>
          ) : (
            <p class="row muted">
              {props.restoreDays === 0
                ? "Deleted repos can't be restored: it will be permanently deleted soon."
                : `Deleted more than ${plural(props.restoreDays, "day")} ago: it can't be restored and will be permanently deleted soon.`}
            </p>
          )
        ) : !live ? (
          props.status === "pending" ? (
            <p class="row muted">Still importing. Reload this page to check again.</p>
          ) : (
            <div class="row">
              <div class="row-text"><strong>Discard this import</strong><span>It was never created. Discarding gives its name back.</span></div>
              <Post action={`/admin/repos/${r.id}/discard`} label="Discard" class="danger" />
            </div>
          )
        ) : (
          <>
            <div class="row">
              <div class="row-text">
                <strong>Change visibility</strong>
                <span>{r.public_at !== null ? "This repo is public: anyone can browse and clone it." : "This repo is private: only you and invitees can see it."}</span>
              </div>
              {r.public_at !== null
                ? <Post action={`/admin/repos/${r.id}/visibility`} name="public" value="0" label="Make private" class="danger" />
                : <button type="button" class="danger" data-dialog="make-public">Make public</button>}
            </div>
            <div class="row">
              <div class="row-text">
                <strong>Delete this repo</strong>
                <span>{props.restoreDays === 0 ? "This can't be undone." : `You can restore it from the Repos page for ${plural(props.restoreDays, "day")}.`}</span>
              </div>
              <button type="button" class="danger" data-dialog="delete-repo">Delete this repo</button>
            </div>
          </>
        )}
      </div>
      {live && r.public_at === null && (
        <dialog id="make-public" class="confirm" aria-labelledby="make-public-title">
          <form method="post" action={`/admin/repos/${r.id}/visibility`} class="stack" data-confirm>
            <h2 id="make-public-title">Make "{r.name}" public?</h2>
            <input type="hidden" name="public" value="1" />
            {MAKE_PUBLIC_ACKS.map(([value, text]) => (
              <label class="check"><input type="checkbox" name="ack" value={value} required /> {text}</label>
            ))}
            <div class="dialog-actions">
              <button type="button" data-close>Cancel</button>
              <button type="submit" class="danger" disabled>Make public</button>
            </div>
          </form>
        </dialog>
      )}
      {live && (
        <dialog id="delete-repo" class="confirm" aria-labelledby="delete-repo-title">
          <form method="post" action={`/admin/repos/${r.id}/delete`} class="stack" data-confirm>
            <h2 id="delete-repo-title">Delete repo "{r.name}"?</h2>
            <p>{`Its pages and clone URL will return 404 and its webhooks stop. ${props.restoreDays === 0 ? "It can't be restored." : `You can restore it from the admin list for ${plural(props.restoreDays, "day")}.`}`}</p>
            <label>Type DELETE to confirm<input type="text" name="confirm" autocomplete="off" required data-must="DELETE" /></label>
            <div class="dialog-actions">
              <button type="button" data-close>Cancel</button>
              <button type="submit" class="danger" disabled>Delete</button>
            </div>
          </form>
        </dialog>
      )}
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

export function AdminInvites(props: { invites: (InviteRow & { repo_names: string; status: string })[]; repos: RepoRow[]; link?: string; error?: string; gone?: string }) {
  const gone = props.gone ? props.invites.find((i) => i.id === props.gone) : undefined;
  return (
    <>
      <h1 class="page-title">Invites</h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.link && <Secret title="Invite link" value={props.link} />}
      {gone && <Gone title={`Invite for "${gone.label}" was created.`} />}
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
                  <td class="muted">{i.revoked_at !== null ? "" : i.redeemed_at === null ? `open by ${dayTime(i.redeem_by_at)}` : i.access_expires_at === null ? "never" : day(i.access_expires_at)}</td>
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

export function AdminTokens(props: { tokens: (PushTokenRow & { repo_names: string | null })[]; repos: RepoRow[]; now: number; created?: string; origin: string; error?: string; gone?: string }) {
  const gone = props.gone ? props.tokens.find((t) => t.id === props.gone) : undefined;
  return (
    <>
      <h1 class="page-title">Push tokens</h1>
      {props.error && <div class="error">{props.error}</div>}
      {props.created && (
        <Secret title="New push token" value={props.created}>
          <GitSetup origin={props.origin} password={props.created} />
        </Secret>
      )}
      {gone && <Gone title={`Push token "${gone.name}" was created.`} />}
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

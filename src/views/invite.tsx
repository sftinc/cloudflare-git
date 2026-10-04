import type { RepoRow } from "../db/repos";

export function accessLabel(ms: number | null): string {
  if (ms === null) return "Access doesn't expire.";
  const days = Math.round(ms / 86_400_000);
  return `Access lasts ${days === 365 ? "1 year" : `${days} days`} from now.`;
}

export function cloneUrlWithPassword(origin: string, repo: string, password: string): string {
  const u = new URL(`/${repo}.git`, origin);
  u.username = "x";
  u.password = password;
  return u.toString();
}

export function InviteConfirm(props: { label: string; repos: RepoRow[]; accessMs: number | null; action: string }) {
  return (
    <section class="card invite">
      <h2>You're invited, {props.label}</h2>
      <p>This invite gives you read access to:</p>
      <ul>{props.repos.map((r) => <li><strong>{r.name}</strong></li>)}</ul>
      <p class="muted">{accessLabel(props.accessMs)} The link works once.</p>
      <form method="post" action={props.action}>
        <button type="submit" class="primary">Accept invite</button>
      </form>
    </section>
  );
}

export function InviteAccepted(props: { repos: RepoRow[]; urls: Record<string, string> }) {
  return (
    <section class="card invite">
      <h2>Invite accepted</h2>
      <p>You can browse these repositories in this browser. To clone them, use your personal URL below.</p>
      <div class="secret">
        <strong>Save these now. They won't be shown again.</strong>
        {props.repos.map((r) => (
          <div>
            <a href={`/${r.name}`}>{r.name}</a>
            <code class="clone-url">{props.urls[r.name]}</code>
            <button type="button" class="btn" data-copy={`git clone ${props.urls[r.name]}`}>Copy clone command</button>
          </div>
        ))}
      </div>
      <p><a href="/">Go to repositories</a></p>
    </section>
  );
}

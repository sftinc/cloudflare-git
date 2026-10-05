import type { RepoRow } from "../db/repos";
import { cloneUrl, repoHref } from "../render/paths";
import { GitSetup } from "./git-setup";
import { Copy } from "./icons";

export function accessLabel(ms: number | null): string {
  if (ms === null) return "Access doesn't expire.";
  const days = Math.round(ms / 86_400_000);
  return `Access lasts ${days === 365 ? "1 year" : `${days} days`} from now.`;
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

export function InviteAccepted(props: { repos: RepoRow[]; origin: string; password: string }) {
  return (
    <section class="card invite">
      <h2>Invite accepted</h2>
      <p>You can browse these repositories in this browser. To clone them, run the command below now (it won't be shown again), then clone as usual.</p>
      <div class="secret">
        <GitSetup origin={props.origin} password={props.password} />
      </div>
      <ul class="clones">
        {props.repos.map((r) => {
          const cmd = `git clone ${cloneUrl(props.origin, r.name)}`;
          return (
            <li>
              <a href={repoHref(r.name)}><strong>{r.name}</strong></a>
              <div class="clone">
                <code>{cmd}</code>
                <button type="button" class="btn" data-copy={cmd}><Copy /> Copy</button>
              </div>
            </li>
          );
        })}
      </ul>
      <p><a href="/">Go to repositories</a></p>
    </section>
  );
}

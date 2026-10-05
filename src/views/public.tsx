import { raw } from "hono/html";
import type { RepoRow } from "../db/repos";
import { blobHref, commitsHref, treeHref } from "../render/paths";
import { Book, Branch, Chevron, Clock, Copy, File, Folder, Plus } from "./icons";

export const fmtDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const firstLine = (s: string) => s.split("\n", 1)[0];

export function Home(props: { repos: RepoRow[]; owner: boolean }) {
  return (
    <>
      <div class="page-head">
        <h1 class="page-title">Repositories</h1>
        <span class="muted">{props.repos.length}</span>
      </div>
      {props.repos.length === 0 ? (
        <section class="card empty">
          <span class="empty-icon"><Book /></span>
          {props.owner ? (
            <>
              <h2>No repositories yet</h2>
              <p class="muted">Create an empty repository to push to, or import one from another host.</p>
              <a href="/admin#new" class="btn primary"><Plus /> New repository</a>
            </>
          ) : (
            <>
              <h2>No repositories to show</h2>
              <p class="muted">There are no public repositories here yet. If you have an invite link, open it to see the repositories it covers.</p>
            </>
          )}
        </section>
      ) : (
        <ul class="repo-grid">
          {props.repos.map((r) => (
            <li>
              <a href={`/${r.name}`} class="repo-card">
                <span class="repo-card-head">
                  <Book />
                  <span class="repo-name">{r.name}</span>
                  {r.public_at === null && <span class="badge">Private</span>}
                </span>
                {r.description && <span class="muted repo-desc">{r.description}</span>}
                <span class="muted repo-updated">Updated {fmtDay(r.updated_at)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CloneBox(props: { url: string }) {
  return (
    <div class="clone">
      <span class="clone-label">Clone</span>
      <code>{props.url}</code>
      <button type="button" class="btn" data-copy={props.url}><Copy /> Copy</button>
    </div>
  );
}

function RepoHeader(props: { repo: RepoRow; cloneUrl: string }) {
  return (
    <div class="repo-head">
      <h1 class="page-title">
        <a href={`/${props.repo.name}`}>{props.repo.name}</a>
        {props.repo.public_at === null ? <span class="badge">Private</span> : <span class="badge ok">Public</span>}
      </h1>
      {props.repo.description && <p class="muted">{props.repo.description}</p>}
      <CloneBox url={props.cloneUrl} />
    </div>
  );
}

function BranchSwitcher(props: { branches: string[]; current: string; href: (b: string) => string }) {
  return (
    <details class="branches">
      <summary>
        <Branch /> <strong>{props.current}</strong> <Chevron />
      </summary>
      <ul>
        {props.branches.map((b) => (
          <li>
            <a href={props.href(b)} class={b === props.current ? "current" : undefined}>{b}</a>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Crumbs(props: { repo: string; branch: string; path: string }) {
  const segs = props.path.split("/").filter(Boolean);
  return (
    <nav class="crumbs" aria-label="Path">
      <a href={treeHref(props.repo, props.branch)}>{props.repo}</a>
      {segs.map((s, i) => (
        <>
          <span class="sep">/</span>
          {i === segs.length - 1 ? <span>{s}</span> : <a href={treeHref(props.repo, props.branch, segs.slice(0, i + 1).join("/"))}>{s}</a>}
        </>
      ))}
    </nav>
  );
}

export function EmptyRepo(props: { repo: RepoRow; cloneUrl: string }) {
  return (
    <>
      <RepoHeader repo={props.repo} cloneUrl={props.cloneUrl} />
      <section class="card">
        <h2>This repository is empty</h2>
        <p class="muted">Push an existing repository from the command line:</p>
        <pre class="code"><code>{`git remote add origin ${props.cloneUrl}\ngit push -u origin main`}</code></pre>
      </section>
    </>
  );
}

export function TreeView(props: {
  repo: RepoRow; branch: string; branches: string[]; path: string; entries: ArtifactsTreeEntry[];
  commit: ArtifactsCommitMetadata; readme: string | null; cloneUrl: string;
}) {
  const { repo, branch, path } = props;
  const child = (name: string) => (path ? `${path}/${name}` : name);
  return (
    <>
      <RepoHeader repo={repo} cloneUrl={props.cloneUrl} />
      <div class="toolbar">
        <BranchSwitcher branches={props.branches} current={branch} href={(b) => treeHref(repo.name, b)} />
        <Crumbs repo={repo.name} branch={branch} path={path} />
        <a class="toolbar-link" href={commitsHref(repo.name, branch)}><Clock /> Commits</a>
      </div>
      <div class="card files">
        <div class="last-commit">
          <span class="commit-msg">{firstLine(props.commit.message)}</span>
          <span class="muted">{props.commit.author.name} · {fmtDate(props.commit.committedAt)} · <code>{props.commit.hash.slice(0, 7)}</code></span>
        </div>
        <ul class="entries">
          {path && (
            <li>
              <a href={treeHref(repo.name, branch, path.split("/").slice(0, -1).join("/"))} class="entry dir"><Folder />..</a>
            </li>
          )}
          {props.entries.map((e) => (
            <li>
              {e.type === "tree" ? (
                <a class="entry dir" href={treeHref(repo.name, branch, child(e.name))}><Folder />{e.name}</a>
              ) : e.type === "gitlink" ? (
                <span class="entry submodule"><Folder />{e.name} <span class="muted">(submodule)</span></span>
              ) : (
                <a class="entry file" href={blobHref(repo.name, branch, child(e.name))}><File />{e.name}</a>
              )}
            </li>
          ))}
        </ul>
      </div>
      {props.readme !== null && (
        <section class="card">
          <div class="file-head readme-head"><span><Book /> README</span></div>
          <article class="markdown">{raw(props.readme)}</article>
        </section>
      )}
    </>
  );
}

export function BlobView(props: {
  repo: RepoRow; branch: string; branches: string[]; path: string; cloneUrl: string; size: number;
  binary: boolean; truncated: boolean; html: string | null; markdown: boolean; showingSource: boolean;
}) {
  const { repo, branch, path } = props;
  const base = blobHref(repo.name, branch, path);
  return (
    <>
      <RepoHeader repo={repo} cloneUrl={props.cloneUrl} />
      <div class="toolbar">
        <BranchSwitcher branches={props.branches} current={branch} href={(b) => treeHref(repo.name, b)} />
        <Crumbs repo={repo.name} branch={branch} path={path} />
      </div>
      <div class="card file">
        <div class="file-head">
          <span class="muted">{fmtSize(props.size)}</span>
          <span class="file-actions">
            {props.markdown && (props.showingSource ? <a href={base}>Preview</a> : <a href={`${base}?source=1`}>Source</a>)}
            <a href={`${base}?raw=1`}>Raw</a>
          </span>
        </div>
        {props.truncated && <p class="notice">Showing the first 1 MB. <a href={`${base}?raw=1`}>View the whole file</a>.</p>}
        {props.binary ? (
          <p class="notice">Binary file not shown. <a href={`${base}?raw=1`}>Download</a></p>
        ) : props.markdown && !props.showingSource ? (
          <article class="markdown">{raw(props.html ?? "")}</article>
        ) : (
          <pre class="code"><code class="hljs">{raw(props.html ?? "")}</code></pre>
        )}
      </div>
    </>
  );
}

export function Commits(props: {
  repo: RepoRow; branch: string; branches: string[]; commits: ArtifactsCommitMetadata[]; page: number; hasNext: boolean; cloneUrl: string;
}) {
  const { repo, branch } = props;
  const href = (p: number) => `${commitsHref(repo.name, branch)}?page=${p}`;
  return (
    <>
      <RepoHeader repo={repo} cloneUrl={props.cloneUrl} />
      <div class="toolbar">
        <BranchSwitcher branches={props.branches} current={branch} href={(b) => commitsHref(repo.name, b)} />
        <a class="toolbar-link" href={treeHref(repo.name, branch)}><Folder /> Files</a>
      </div>
      <ul class="card commits">
        {props.commits.map((c) => (
          <li>
            <span class="commit-msg">{firstLine(c.message)}</span>
            <span class="muted">{c.author.name} · {fmtDate(c.committedAt)}</span>
            <code class="sha">{c.hash.slice(0, 7)}</code>
          </li>
        ))}
      </ul>
      <nav class="pager">
        {props.page > 1 && <a href={href(props.page - 1)}>← Newer</a>}
        {props.hasNext && <a href={href(props.page + 1)}>Older →</a>}
      </nav>
    </>
  );
}

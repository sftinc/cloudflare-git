import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { RepoRow } from "../db/repos";
import type { Ref } from "../artifacts";
import { blobHref, commitsHref, repoHref, treeHref } from "../render/paths";
import { Book, Branch, Chevron, ChevronRight, Clock, Copy, Download, File, Folder, Link, Terminal, Upload } from "./icons";

export const NO_REPOS_OWNER = "Create an empty repository to push to, or import one from another host.";
export const TOO_LARGE = "This file is too large to show or download from the web (the limit is about 20 MB). Clone the repository to get it.";

export const fmtDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const firstLine = (s: string) => s.split("\n", 1)[0];
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 days ago" style, from epoch ms. */
export function fmtAgo(ms: number, now: number) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  const [n, unit] = s < 3600 ? [s / 60, "minute"] : s < 86_400 ? [s / 3600, "hour"] : s < 2_592_000 ? [s / 86_400, "day"] : s < 31_536_000 ? [s / 2_592_000, "month"] : [s / 31_536_000, "year"];
  return `${plural(Math.floor(n), unit)} ago`;
}

export function Home(props: { repos: RepoRow[]; owner: boolean }) {
  return (
    <>
      <div class="page-head">
        <h1 class="page-title">Repos</h1>
        <span class="muted">{props.repos.length}</span>
      </div>
      {props.repos.length === 0 ? (
        <section class="card empty">
          <span class="empty-icon"><Book /></span>
          {props.owner ? (
            <>
              <h2>No repos yet</h2>
              <p class="muted">{NO_REPOS_OWNER}</p>
            </>
          ) : (
            <>
              <h2>No repos to show</h2>
              <p class="muted">There are no public repositories here yet. If you have an invite link, open it to see the repositories it covers.</p>
            </>
          )}
        </section>
      ) : (
        <ul class="repo-grid">
          {props.repos.map((r) => (
            <li>
              <a href={repoHref(r.name)} class="repo-card">
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
    <>
      <p class="clone-label"><Terminal /> Clone</p>
      <div class="clone">
        <code>{props.url}</code>
        <button type="button" class="btn" data-copy={props.url}><Copy /> Copy</button>
      </div>
    </>
  );
}

function RepoHeader(props: { repo: RepoRow; children?: Child }) {
  const { repo } = props;
  return (
    <div class="repo-title-row">
      <h1 class="page-title repo-title">
        <Book /><a href="/" class="crumb">Repos</a><span class="sep">/</span><a href={repoHref(repo.name)} class="repo-title-name">{repo.name}</a>
        {repo.public_at === null ? <span class="badge">Private</span> : <span class="badge ok">Public</span>}
      </h1>
      {props.children && <div class="repo-toolbar">{props.children}</div>}
    </div>
  );
}

function BranchSwitcher(props: { branches: Ref[]; tags: Ref[]; current: string; kind: Ref["kind"]; href: (name: string) => string }) {
  const item = (r: Ref) => (
    <li>
      <a href={props.href(r.name)} class={r.kind === props.kind && r.name === props.current ? "current" : undefined}>{r.name}</a>
    </li>
  );
  return (
    <details class="branches">
      <summary>
        <Branch /> <strong>{props.current}</strong>{props.kind === "tag" && <span class="badge">tag</span>} <Chevron />
      </summary>
      <ul>
        {props.branches.map(item)}
        {props.tags.length > 0 && <li class="group">Tags</li>}
        {props.tags.map(item)}
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
      <button type="button" class="btn" data-copy={props.path} aria-label="Copy path" title="Copy path"><Copy /></button>
    </nav>
  );
}

/** The root folder plus each folder down to the current one, opened; other folders are links that open them. */
function FileTree(props: { repo: string; branch: string; levels: ArtifactsTreeEntry[][]; current: string }) {
  const open = props.current.split("/").filter(Boolean);
  const level = (i: number, prefix: string): Child => (
    <ul>
      {props.levels[i].map((e) => {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        const here = p === props.current ? "page" : undefined;
        if (e.type === "tree") {
          const isOpen = i < props.levels.length - 1 && open[i] === e.name;
          return (
            <li>
              <a href={treeHref(props.repo, props.branch, p)} class={isOpen ? "node dir open" : "node dir"} aria-current={here}>
                {isOpen ? <Chevron /> : <ChevronRight />}<Folder />{e.name}
              </a>
              {isOpen && level(i + 1, p)}
            </li>
          );
        }
        if (e.type === "gitlink") return <li><span class="node"><span class="chev-space" /><Folder />{e.name}</span></li>;
        return <li><a href={blobHref(props.repo, props.branch, p)} class="node" aria-current={here}><span class="chev-space" /><File />{e.name}</a></li>;
      })}
    </ul>
  );
  return (
    <nav class="file-tree" aria-label="Files">
      <h2>Files</h2>
      {level(0, "")}
    </nav>
  );
}

const Commands = (props: { text: string }) => (
  <div class="commands">
    <pre class="code"><code>{props.text}</code></pre>
    <button type="button" class="btn" data-copy={props.text} aria-label="Copy commands" title="Copy"><Copy /></button>
  </div>
);

export function EmptyRepo(props: { repo: RepoRow; head: string | null; info: ArtifactsRepoInfo; cloneUrl: string; now: number }) {
  const { repo, cloneUrl } = props;
  return (
    <>
      <RepoHeader repo={repo} />
      <div class="repo-layout">
        <div class="repo-main">
          <section class="card">
            <div class="empty-head">
              <h2><Book /> This repo is empty</h2>
              <p class="muted">Push your first commit to see its files here.</p>
            </div>
            <h3>Create a new repository on the command line</h3>
            <Commands text={`echo "# ${repo.name}" >> README.md\ngit init\ngit add README.md\ngit commit -m "first commit"\ngit branch -M main\ngit remote add origin ${cloneUrl}\ngit push -u origin main`} />
            <h3>…or push an existing repository from the command line</h3>
            <Commands text={`git remote add origin ${cloneUrl}\ngit branch -M main\ngit push -u origin main`} />
          </section>
        </div>
        <About repo={repo} branch="" head={props.head} readmeName={null} info={props.info} cloneUrl={cloneUrl} now={props.now} />
      </div>
    </>
  );
}

function About(props: { repo: RepoRow; branch: string; head: string | null; readmeName: string | null; info: ArtifactsRepoInfo; cloneUrl: string; now: number }) {
  const { repo, info } = props;
  const source = info.source?.replace(/^git:/, ""); // imports report "git:https://…"
  return (
    <aside class="about">
      <h2>About</h2>
      {repo.description && <p class="about-desc">{repo.description}</p>}
      <p class="clone-label"><Terminal /> Clone</p>
      <div class="clone">
        <code>{props.cloneUrl}</code>
        <button type="button" class="btn" data-copy={props.cloneUrl} aria-label="Copy clone URL" title="Copy"><Copy /></button>
      </div>
      <ul class="facts">
        {props.readmeName && <li><Book /><a href={blobHref(repo.name, props.branch, props.readmeName)}>Readme</a></li>}
        {props.head && <li><Branch /><span>Default branch <strong>{props.head}</strong></span></li>}
        {info.lastPushAt && <li><Upload /><span>Pushed <strong>{fmtAgo(Date.parse(info.lastPushAt), props.now)}</strong></span></li>}
        <li><Clock /><span>Created <strong>{fmtDay(repo.created_at)}</strong></span></li>
        {source && <li><Download /><span>Imported from <strong>{/^https?:\/\//.test(source) ? <a href={source} rel="nofollow noopener">{source}</a> : source}</strong></span></li>}
      </ul>
    </aside>
  );
}

export function TreeView(props: {
  repo: RepoRow; branch: string; kind: Ref["kind"]; branches: Ref[]; tags: Ref[]; head: string | null; path: string; levels: ArtifactsTreeEntry[][];
  commit: ArtifactsCommitMetadata; readme: string | null; readmeName: string | null; info: ArtifactsRepoInfo | null; cloneUrl: string; now: number;
}) {
  const { repo, branch, path, commit } = props;
  const child = (name: string) => (path ? `${path}/${name}` : name);
  const entries = props.levels[props.levels.length - 1];
  const files = (
    <div class="repo-main">
      {path && <Crumbs repo={repo.name} branch={branch} path={path} />}
      <div class="card files">
        <div class="last-commit">
          <span class="commit-author">{commit.author.name}</span>
          <span class="commit-msg">{firstLine(commit.message)}</span>
          <span class="commit-meta"><code>{commit.hash.slice(0, 7)}</code> · {fmtAgo(commit.committedAt * 1000, props.now)}</span>
          <a class="commit-history" href={commitsHref(repo.name, branch)}><Clock /> Commits</a>
        </div>
        <ul class="entries">
          {path && (
            <li>
              <a href={treeHref(repo.name, branch, path.split("/").slice(0, -1).join("/"))} class="entry dir"><Folder />..</a>
            </li>
          )}
          {entries.map((e) => (
            <li>
              {e.type === "tree" ? (
                <a class="entry dir" href={treeHref(repo.name, branch, child(e.name))}><Folder />{e.name}</a>
              ) : e.type === "gitlink" ? (
                <span class="entry submodule"><Folder />{e.name} <span class="muted">(submodule)</span></span>
              ) : (
                <a class="entry file" href={blobHref(repo.name, branch, child(e.name))}>
                  {e.type === "symlink" ? <Link /> : <File />}{e.name}
                  {e.type === "exec" && <span class="badge">executable</span>}
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
      {props.readme !== null && (
        <section class="card">
          <div class="readme-head"><span><Book /> README</span></div>
          <article class="markdown">{raw(props.readme)}</article>
        </section>
      )}
    </div>
  );
  return (
    <>
      <RepoHeader repo={repo}>
        <BranchSwitcher branches={props.branches} tags={props.tags} current={branch} kind={props.kind} href={(b) => treeHref(repo.name, b)} />
        <span class="count"><strong>{props.branches.length}</strong> {props.branches.length === 1 ? "branch" : "branches"}</span>
        <span class="count"><strong>{props.tags.length}</strong> {props.tags.length === 1 ? "tag" : "tags"}</span>
      </RepoHeader>
      {props.info ? (
        <div class="repo-layout">
          {files}
          <About repo={repo} branch={branch} head={props.head} readmeName={props.readmeName} info={props.info} cloneUrl={props.cloneUrl} now={props.now} />
        </div>
      ) : (
        <div class="split">
          <FileTree repo={repo.name} branch={branch} levels={props.levels} current={path} />
          {files}
        </div>
      )}
    </>
  );
}

export type Symlink = { target: string; href: string | null; missing: boolean };

export function BlobView(props: {
  repo: RepoRow; branch: string; kind: Ref["kind"]; branches: Ref[]; tags: Ref[]; path: string; levels: ArtifactsTreeEntry[][]; size: number; lines: number;
  binary: boolean; truncated: boolean; html: string | null; markdown: boolean; showingSource: boolean; tooLarge: boolean; cloneUrl: string;
  exec?: boolean; symlink?: Symlink | null; image?: boolean; // unset for a file too large to read
}) {
  const { repo, branch, path } = props;
  const base = blobHref(repo.name, branch, path);
  const preview = props.markdown && !props.showingSource;
  const summary = props.symlink ? "Symlink" : props.binary ? fmtSize(props.size) : `${plural(props.lines, "line")} · ${fmtSize(props.size)}`;
  return (
    <>
      <RepoHeader repo={repo}>
        <BranchSwitcher branches={props.branches} tags={props.tags} current={branch} kind={props.kind} href={(b) => treeHref(repo.name, b)} />
      </RepoHeader>
      <div class="split">
        <FileTree repo={repo.name} branch={branch} levels={props.levels} current={path} />
        <div class="repo-main">
          <Crumbs repo={repo.name} branch={branch} path={path} />
          {props.tooLarge ? (
            <>
              <div class="card file"><p class="notice">{TOO_LARGE}</p></div>
              <CloneBox url={props.cloneUrl} />
            </>
          ) : (
            <div class="card file">
              <div class="file-head">
                <span class="muted">{summary}{props.exec && " · Executable"}</span>
                <span class="file-actions">
                  {props.markdown && (
                    <nav class="segctl" aria-label="View">
                      <a href={base} aria-current={preview ? "page" : undefined}>Preview</a>
                      <a href={`${base}?source`} aria-current={preview ? undefined : "page"}>Code</a>
                    </nav>
                  )}
                  <a class="btn" href={`${base}?raw`}>Raw</a>
                  {!props.binary && <button type="button" class="btn" data-copy-url={`${base}?raw`} aria-label="Copy file" title="Copy file"><Copy /></button>}
                </span>
              </div>
              {props.truncated && <p class="notice">Showing the first 1 MB. <a href={`${base}?raw`}>View the whole file</a>.</p>}
              {props.symlink ? (
                <p class="notice">
                  Symlink to {props.symlink.href ? <a href={props.symlink.href}><code>{props.symlink.target}</code></a> : <code>{props.symlink.target}</code>}
                  {props.symlink.missing && " (missing)"}
                </p>
              ) : props.image ? (
                <img src={`${base}?raw`} alt={path.split("/").pop()} class="blob-image" />
              ) : props.binary ? (
                <p class="notice">Binary file not shown. <a href={`${base}?raw`}>Download</a></p>
              ) : preview ? (
                <article class="markdown">{raw(props.html ?? "")}</article>
              ) : (
                <div class="code-lines">
                  <div class="ln" aria-hidden="true">{Array.from({ length: Math.max(1, props.lines) }, (_, i) => i + 1).join("\n")}</div>
                  <pre class="code"><code class="hljs">{raw(props.html ?? "")}</code></pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const fmtDayLong = (sec: number) => new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function Commits(props: {
  repo: RepoRow; branch: string; kind: Ref["kind"]; branches: Ref[]; tags: Ref[]; commits: ArtifactsCommitMetadata[]; page: number; hasNext: boolean; now: number;
}) {
  const { repo, branch } = props;
  const href = (p: number) => `${commitsHref(repo.name, branch)}?page=${p}`;
  const days: { day: string; commits: ArtifactsCommitMetadata[] }[] = [];
  for (const c of props.commits) {
    const day = fmtDayLong(c.committedAt);
    if (days[days.length - 1]?.day === day) days[days.length - 1].commits.push(c);
    else days.push({ day, commits: [c] });
  }
  return (
    <>
      <RepoHeader repo={repo}>
        <BranchSwitcher branches={props.branches} tags={props.tags} current={branch} kind={props.kind} href={(b) => commitsHref(repo.name, b)} />
      </RepoHeader>
      {days.map((d) => (
        <>
          <h2 class="commit-day"><Clock /> Commits on {d.day}</h2>
          <ul class="card commits">
            {d.commits.map((c) => (
              <li>
                <span class="commit-text">
                  <span class="commit-msg">{firstLine(c.message)}</span>
                  <span class="muted"><strong>{c.author.name}</strong> committed {fmtAgo(c.committedAt * 1000, props.now)}</span>
                </span>
                <code class="sha">{c.hash.slice(0, 7)}</code>
                <button type="button" class="btn" data-copy={c.hash} aria-label="Copy full SHA" title="Copy full SHA"><Copy /></button>
              </li>
            ))}
          </ul>
        </>
      ))}
      {(props.page > 1 || props.hasNext) && (
        <nav class="pager">
          {props.page > 1 ? <a class="btn" href={href(props.page - 1)}>← Newer</a> : <span class="btn" aria-disabled="true">← Newer</span>}
          {props.hasNext ? <a class="btn" href={href(props.page + 1)}>Older →</a> : <span class="btn" aria-disabled="true">Older →</span>}
        </nav>
      )}
    </>
  );
}

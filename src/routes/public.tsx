import { Hono, type Context } from "hono";
import type { AppEnv } from "../index";
import { artifactsErrorCode, listBranches, type Ref } from "../artifacts";
import { canView, getViewer, visibleRepos } from "../auth/viewer";
import { findLiveAlias, findLiveRepo, type RepoRow } from "../db/repos";
import { highlightCode } from "../render/highlight";
import { renderMarkdown } from "../render/markdown";
import { blobHref, cloneUrl, decodePath, imageType, repoHref, resolveRelative, splitRefPath, treeHref } from "../render/paths";
import { siteOrigin } from "../lib/site";
import { page } from "../views/layout";
import { BlobView, Commits, EmptyRepo, Home, TOO_LARGE, TreeView, type Symlink } from "../views/public";

export const MAX_VIEW_BYTES = 1_048_576;
const PER_PAGE = 30;
const NAME = "[a-z0-9][a-z0-9-]*";

/** `refs` is `branches` then `tags`: splitRefPath relies on that order. */
type Loaded = { repo: RepoRow; branches: Ref[]; head: string | null; tags: Ref[]; refs: Ref[]; cloneUrl: string };

export const publicRoutes = new Hono<AppEnv>();

/** The repo's data, or the response to send instead: 404, or a redirect when the name is an old one. */
async function load(c: Context<AppEnv>): Promise<Loaded | Response> {
  const name = c.req.param("repo")!;
  const live = await findLiveRepo(c.env.DB, name);
  const repo = live ?? (await findLiveAlias(c.env.DB, name));
  if (!repo || !(await canView(c.env.DB, await getViewer(c), repo, Date.now()))) return c.notFound();
  if (!live) {
    const url = new URL(c.req.url);
    return c.redirect(url.pathname.replace(repoHref(name), repoHref(repo.name)) + url.search, 302);
  }
  const { branches, head, tags } = await listBranches(c.env.ARTIFACTS, repo.storage_name);
  return { repo, branches, head, tags, refs: [...branches, ...tags], cloneUrl: cloneUrl(siteOrigin(c), repo.name) };
}

/** Decoded path after `/r/<repo>/<kind>/`, or null when malformed. */
function rest(c: Context<AppEnv>, l: Loaded, kind: string): string | null {
  const prefix = `${repoHref(l.repo.name)}/${kind}/`;
  const pathname = new URL(c.req.url).pathname;
  return pathname.startsWith(prefix) ? decodePath(pathname.slice(prefix.length)) : null;
}

const sortEntries = (entries: ArtifactsTreeEntry[]) =>
  [...entries].sort((a, b) =>
    (a.type === "tree") === (b.type === "tree") ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "tree" ? -1 : 1);

/** The root folder and each folder down to `path`, sorted: the file tree's open levels. The last is `path` itself. */
async function readLevels(h: ArtifactsRepo, rootTree: string, path: string) {
  const root = await h.readTree(rootTree);
  if (!root) return null;
  const levels = [sortEntries(root)];
  for (const seg of path.split("/").filter(Boolean)) {
    const next = levels[levels.length - 1].find((e) => e.name === seg && e.type === "tree");
    const entries = next && (await h.readTree(next.hash));
    if (!entries) return null;
    levels.push(sortEntries(entries));
  }
  return levels;
}

async function renderTree(c: Context<AppEnv>, l: Loaded, ref: Ref, path: string) {
  using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
  const [commit] = await h.log({ ref: ref.sha, limit: 1 });
  if (!commit) return c.notFound();
  const levels = await readLevels(h, commit.treeHash, path);
  if (!levels) return c.notFound();
  const entries = levels[levels.length - 1];
  // The repo's own page (not a subfolder) gets the About card.
  const info = path ? null : await h.info();
  let readme: string | null = null;
  const readmeEntry = entries.find((e) => e.type === "blob" && /^readme\.md$/i.test(e.name));
  if (readmeEntry) {
    const blob = await h.readBlob(readmeEntry.hash);
    if (blob) readme = renderMarkdown(await blob.slice(0, MAX_VIEW_BYTES).text(), { repo: l.repo.name, branch: ref.name, dir: path });
  }
  const title = path ? `${path} · ${l.repo.name}` : l.repo.name;
  return page(
    c,
    title,
    <TreeView repo={l.repo} branch={ref.name} kind={ref.kind} branches={l.branches} tags={l.tags} head={l.head} path={path} levels={levels} commit={commit}
      readme={readme} readmeName={readmeEntry?.name ?? null} info={info} cloneUrl={l.cloneUrl} now={Date.now()} />,
    200,
    { wide: !!path }, // subfolders get the file tree
  );
}

publicRoutes.get("/", async (c) => {
  const viewer = await getViewer(c);
  const repos = await visibleRepos(c.env.DB, viewer, Date.now());
  return page(c, "Repos", <Home repos={repos} owner={viewer.owner} />);
});

publicRoutes.get(`/r/:repo{${NAME}}`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  if (l.branches.length === 0) {
    using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
    return page(c, l.repo.name, <EmptyRepo repo={l.repo} head={l.head} info={await h.info()} cloneUrl={l.cloneUrl} now={Date.now()} />);
  }
  return renderTree(c, l, l.branches[0], ""); // listBranches sorts HEAD's branch first
});

publicRoutes.get(`/r/:repo{${NAME}}/tree/*`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  const r = rest(c, l, "tree");
  const at = r !== null ? splitRefPath(r, l.refs) : null;
  if (!at) return c.notFound();
  return renderTree(c, l, at.ref, at.path);
});

/** Where a symlink points: a link when the target is inside the repo and exists, else plain text (flagged `missing` when it is inside the repo but absent). */
async function resolveSymlink(h: ArtifactsRepo, rootTree: string, l: Loaded, ref: string, dir: string, target: string): Promise<Symlink> {
  const text = { target, href: null, missing: false };
  const to = target.startsWith("/") ? null : resolveRelative(dir, target); // resolveRelative would read "/etc/x" as the repo path "etc/x"
  if (to === null) return text;
  if (to === "") return { ...text, href: treeHref(l.repo.name, ref) };
  const levels = await readLevels(h, rootTree, to.split("/").slice(0, -1).join("/"));
  const found = levels?.[levels.length - 1].find((e) => e.name === to.split("/").pop());
  if (!found) return { ...text, missing: true };
  return { ...text, href: found.type === "tree" ? treeHref(l.repo.name, ref, to) : blobHref(l.repo.name, ref, to) };
}

publicRoutes.get(`/r/:repo{${NAME}}/blob/*`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  const r = rest(c, l, "blob");
  const at = r !== null ? splitRefPath(r, l.refs) : null;
  if (!at || !at.path) return c.notFound();
  using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
  // The commit and folders come before the file, so a file too large to read still gets the normal page around it.
  const [commit] = await h.log({ ref: at.ref.sha, limit: 1 });
  if (!commit) return c.notFound();
  const dir = at.path.split("/").slice(0, -1).join("/");
  const levels = await readLevels(h, commit.treeHash, dir);
  if (!levels) return c.notFound();
  const filename = at.path.split("/").pop()!;
  const entry = levels[levels.length - 1].find((e) => e.name === filename);
  if (!entry || entry.type === "tree" || entry.type === "gitlink") return c.notFound();
  const wantsRaw = c.req.query("raw") !== undefined;
  let blob: Blob | null;
  try {
    blob = await h.readFile({ ref: at.ref.sha, path: at.path });
  } catch (err) {
    // Spike: files of ~20 MB and up throw INTERNAL_ERROR (or MEMORY_LIMIT) instead of returning.
    const code = artifactsErrorCode(err);
    if (code !== "INTERNAL_ERROR" && code !== "MEMORY_LIMIT") throw err;
    if (wantsRaw) {
      return new Response(`${TOO_LARGE}\n\ngit clone ${l.cloneUrl}\n`, { status: 413, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return page(
      c,
      `${filename} · ${l.repo.name}`,
      <BlobView repo={l.repo} branch={at.ref.name} kind={at.ref.kind} branches={l.branches} tags={l.tags} path={at.path} levels={levels} size={0} lines={0}
        binary={false} truncated={false} html={null} markdown={false} showingSource={false} tooLarge cloneUrl={l.cloneUrl} />,
      413,
      { wide: true },
    );
  }
  if (!blob) return c.notFound();
  const binary = new Uint8Array(await blob.slice(0, 8192).arrayBuffer()).includes(0);
  const image = entry.type === "symlink" ? null : imageType(filename); // a symlink shows as a symlink, whatever its name

  if (wantsRaw) {
    const headers: Record<string, string> = { "Content-Security-Policy": "default-src 'none'; sandbox" };
    if (image) headers["Content-Type"] = image;
    else if (binary) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Disposition"] = `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    } else headers["Content-Type"] = "text/plain; charset=utf-8";
    return new Response(blob.stream(), { headers });
  }

  const markdown = /\.md$/i.test(filename);
  const showingSource = c.req.query("source") !== undefined;
  const symlink = entry.type === "symlink" ? await resolveSymlink(h, commit.treeHash, l, at.ref.name, dir, await blob.slice(0, 4096).text()) : null;
  let html: string | null = null;
  let lines = 0;
  if (!binary && !symlink) {
    const text = await blob.slice(0, MAX_VIEW_BYTES).text();
    lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    html = markdown && !showingSource ? renderMarkdown(text, { repo: l.repo.name, branch: at.ref.name, dir }) : highlightCode(text, filename);
  }
  return page(
    c,
    `${filename} · ${l.repo.name}`,
    <BlobView repo={l.repo} branch={at.ref.name} kind={at.ref.kind} branches={l.branches} tags={l.tags} path={at.path} levels={levels} size={blob.size} lines={lines}
      binary={binary} truncated={!binary && blob.size > MAX_VIEW_BYTES} html={html} markdown={markdown} showingSource={showingSource} tooLarge={false} cloneUrl={l.cloneUrl} exec={entry.type === "exec"} symlink={symlink} image={image !== null} />,
    200,
    { wide: true },
  );
});

publicRoutes.get(`/r/:repo{${NAME}}/commits/*`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  const r = rest(c, l, "commits");
  const at = r !== null ? splitRefPath(r, l.refs) : null;
  if (!at || at.path) return c.notFound(); // commits need the exact ref, nothing after it
  const pageNo = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
  const list = await h.log({ ref: at.ref.sha, limit: PER_PAGE + 1, offset: (pageNo - 1) * PER_PAGE });
  if (list.length === 0) return c.notFound(); // past the last page, or a tag that is not on a commit
  return page(
    c,
    `Commits · ${l.repo.name}`,
    <Commits repo={l.repo} branch={at.ref.name} kind={at.ref.kind} branches={l.branches} tags={l.tags} commits={list.slice(0, PER_PAGE)} page={pageNo} hasNext={list.length > PER_PAGE} now={Date.now()} />,
  );
});

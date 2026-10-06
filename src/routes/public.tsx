import { Hono, type Context } from "hono";
import type { AppEnv } from "../index";
import { artifactsErrorCode, listBranches } from "../artifacts";
import { canView, getViewer, visibleRepos } from "../auth/viewer";
import { findLiveAlias, findLiveRepo, type RepoRow } from "../db/repos";
import { highlightCode } from "../render/highlight";
import { renderMarkdown } from "../render/markdown";
import { cloneUrl, decodePath, repoHref, splitRefPath } from "../render/paths";
import { siteOrigin } from "../lib/site";
import { page } from "../views/layout";
import { BlobView, Commits, EmptyRepo, Home, TreeView } from "../views/public";
import { FileTooLarge } from "../views/errors";

export const MAX_VIEW_BYTES = 1_048_576;
const PER_PAGE = 30;
const NAME = "[a-z0-9][a-z0-9-]*";

type Loaded = { repo: RepoRow; branches: string[]; head: string | null; tags: string[]; cloneUrl: string };

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
  return { repo, branches, head, tags, cloneUrl: cloneUrl(siteOrigin(c), repo.name) };
}

/** Decoded path after `/r/<repo>/<kind>/`, or null when malformed. */
function rest(c: Context<AppEnv>, l: Loaded, kind: string): string | null {
  const prefix = `${repoHref(l.repo.name)}/${kind}/`;
  const pathname = new URL(c.req.url).pathname;
  return pathname.startsWith(prefix) ? decodePath(pathname.slice(prefix.length)) : null;
}

const sortEntries = (entries: ArtifactsTreeEntry[]) =>
  [...entries].sort((a, b) => ((a.type === "tree") === (b.type === "tree") ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));

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

async function renderTree(c: Context<AppEnv>, l: Loaded, branch: string, path: string) {
  using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
  const [commit] = await h.log({ ref: branch, limit: 1 });
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
    if (blob) readme = renderMarkdown(await blob.slice(0, MAX_VIEW_BYTES).text(), { repo: l.repo.name, branch, dir: path });
  }
  const title = path ? `${path} · ${l.repo.name}` : l.repo.name;
  return page(
    c,
    title,
    <TreeView repo={l.repo} branch={branch} branches={l.branches} tags={l.tags} head={l.head} path={path} levels={levels} commit={commit}
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
  if (l.branches.length === 0) return page(c, l.repo.name, <EmptyRepo repo={l.repo} cloneUrl={l.cloneUrl} />);
  return renderTree(c, l, l.head ?? l.branches[0], "");
});

publicRoutes.get(`/r/:repo{${NAME}}/tree/*`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  const r = rest(c, l, "tree");
  const at = r !== null ? splitRefPath(r, l.branches) : null;
  if (!at) return c.notFound();
  return renderTree(c, l, at.branch, at.path);
});

publicRoutes.get(`/r/:repo{${NAME}}/blob/*`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  const r = rest(c, l, "blob");
  const at = r !== null ? splitRefPath(r, l.branches) : null;
  if (!at || !at.path) return c.notFound();
  using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
  let blob: Blob | null;
  try {
    blob = await h.readFile({ ref: at.branch, path: at.path });
  } catch (err) {
    // Spike: files of ~25 MB and up throw INTERNAL_ERROR (or MEMORY_LIMIT) instead of returning.
    const code = artifactsErrorCode(err);
    if (code === "INTERNAL_ERROR" || code === "MEMORY_LIMIT") return page(c, "File too large", <FileTooLarge path={at.path} />);
    throw err;
  }
  if (!blob) return c.notFound();
  const [commit] = await h.log({ ref: at.branch, limit: 1 });
  const levels = commit && (await readLevels(h, commit.treeHash, at.path.split("/").slice(0, -1).join("/")));
  if (!levels) return c.notFound();
  const binary = new Uint8Array(await blob.slice(0, 8192).arrayBuffer()).includes(0);
  const filename = at.path.split("/").pop()!;

  if (c.req.query("raw") !== undefined) {
    const headers: Record<string, string> = { "Content-Security-Policy": "default-src 'none'; sandbox" };
    if (binary) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Disposition"] = `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    } else headers["Content-Type"] = "text/plain; charset=utf-8";
    return new Response(blob.stream(), { headers });
  }

  const markdown = /\.md$/i.test(filename);
  const showingSource = c.req.query("source") !== undefined;
  const dir = at.path.split("/").slice(0, -1).join("/");
  let html: string | null = null;
  let lines = 0;
  if (!binary) {
    const text = await blob.slice(0, MAX_VIEW_BYTES).text();
    lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    html = markdown && !showingSource ? renderMarkdown(text, { repo: l.repo.name, branch: at.branch, dir }) : highlightCode(text, filename);
  }
  return page(
    c,
    `${filename} · ${l.repo.name}`,
    <BlobView repo={l.repo} branch={at.branch} branches={l.branches} path={at.path} levels={levels} size={blob.size} lines={lines}
      binary={binary} truncated={!binary && blob.size > MAX_VIEW_BYTES} html={html} markdown={markdown} showingSource={showingSource} />,
    200,
    { wide: true },
  );
});

publicRoutes.get(`/r/:repo{${NAME}}/commits/*`, async (c) => {
  const l = await load(c);
  if (l instanceof Response) return l;
  const branch = rest(c, l, "commits");
  if (!branch || !l.branches.includes(branch)) return c.notFound();
  const pageNo = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  using h = await c.env.ARTIFACTS.get(l.repo.storage_name);
  const list = await h.log({ ref: branch, limit: PER_PAGE + 1, offset: (pageNo - 1) * PER_PAGE });
  return page(
    c,
    `Commits · ${l.repo.name}`,
    <Commits repo={l.repo} branch={branch} branches={l.branches} commits={list.slice(0, PER_PAGE)} page={pageNo} hasNext={list.length > PER_PAGE} now={Date.now()} />,
  );
});

import { Hono, type Context } from "hono";
import type { AppEnv } from "../index";
import { artifactsErrorCode, listBranches } from "../artifacts";
import { canView, getViewer, visibleRepos } from "../auth/viewer";
import { findLiveRepo, type RepoRow } from "../db/repos";
import { highlightCode } from "../render/highlight";
import { renderMarkdown } from "../render/markdown";
import { decodePath, splitRefPath } from "../render/paths";
import { siteOrigin } from "../lib/site";
import { page } from "../views/layout";
import { BlobView, Commits, EmptyRepo, Home, TreeView } from "../views/public";
import { FileTooLarge } from "../views/errors";

export const MAX_VIEW_BYTES = 1_048_576;
const PER_PAGE = 30;
const NAME = "[a-z0-9][a-z0-9-]*";

type Loaded = { repo: RepoRow; branches: string[]; head: string | null; cloneUrl: string };

export const publicRoutes = new Hono<AppEnv>();

async function load(c: Context<AppEnv>): Promise<Loaded | null> {
  const repo = await findLiveRepo(c.env.DB, c.req.param("repo")!);
  if (!repo || !(await canView(c.env.DB, await getViewer(c), repo, Date.now()))) return null;
  const { branches, head } = await listBranches(c.env.ARTIFACTS, repo.name);
  return { repo, branches, head, cloneUrl: `${siteOrigin(c)}/${repo.name}.git` };
}

/** Decoded path after `/<repo>/<kind>/`, or null when malformed. */
function rest(c: Context<AppEnv>, l: Loaded, kind: string): string | null {
  const prefix = `/${l.repo.name}/${kind}/`;
  const pathname = new URL(c.req.url).pathname;
  return pathname.startsWith(prefix) ? decodePath(pathname.slice(prefix.length)) : null;
}

async function readDir(h: ArtifactsRepo, rootTree: string, path: string) {
  let entries = await h.readTree(rootTree);
  for (const seg of path.split("/").filter(Boolean)) {
    const next = entries?.find((e) => e.name === seg && e.type === "tree");
    if (!next) return null;
    entries = await h.readTree(next.hash);
  }
  return entries
    ? [...entries].sort((a, b) => ((a.type === "tree") === (b.type === "tree") ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1))
    : null;
}

async function renderTree(c: Context<AppEnv>, l: Loaded, branch: string, path: string) {
  using h = await c.env.ARTIFACTS.get(l.repo.name);
  const [commit] = await h.log({ ref: branch, limit: 1 });
  if (!commit) return c.notFound();
  const entries = await readDir(h, commit.treeHash, path);
  if (!entries) return c.notFound();
  let readme: string | null = null;
  const readmeEntry = entries.find((e) => e.type === "blob" && /^readme\.md$/i.test(e.name));
  if (readmeEntry) {
    const blob = await h.readBlob(readmeEntry.hash);
    if (blob) readme = renderMarkdown(await blob.slice(0, MAX_VIEW_BYTES).text(), { repo: l.repo.name, branch, dir: path });
  }
  const title = path ? `${path} · ${l.repo.name}` : l.repo.name;
  return page(c, title, <TreeView repo={l.repo} branch={branch} branches={l.branches} path={path} entries={entries} commit={commit} readme={readme} cloneUrl={l.cloneUrl} />);
}

publicRoutes.get("/", async (c) => {
  const viewer = await getViewer(c);
  const repos = await visibleRepos(c.env.DB, viewer, Date.now());
  return page(c, "Repositories", <Home repos={repos} owner={viewer.owner} />);
});

publicRoutes.get(`/:repo{${NAME}}`, async (c) => {
  const l = await load(c);
  if (!l) return c.notFound();
  if (l.branches.length === 0) return page(c, l.repo.name, <EmptyRepo repo={l.repo} cloneUrl={l.cloneUrl} />);
  return renderTree(c, l, l.head ?? l.branches[0], "");
});

publicRoutes.get(`/:repo{${NAME}}/tree/*`, async (c) => {
  const l = await load(c);
  const r = l && rest(c, l, "tree");
  const at = l && r !== null ? splitRefPath(r, l.branches) : null;
  if (!l || !at) return c.notFound();
  return renderTree(c, l, at.branch, at.path);
});

publicRoutes.get(`/:repo{${NAME}}/blob/*`, async (c) => {
  const l = await load(c);
  const r = l && rest(c, l, "blob");
  const at = l && r !== null ? splitRefPath(r, l.branches) : null;
  if (!l || !at || !at.path) return c.notFound();
  using h = await c.env.ARTIFACTS.get(l.repo.name);
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
  if (!binary) {
    const text = await blob.slice(0, MAX_VIEW_BYTES).text();
    html = markdown && !showingSource ? renderMarkdown(text, { repo: l.repo.name, branch: at.branch, dir }) : highlightCode(text, filename);
  }
  return page(
    c,
    `${filename} · ${l.repo.name}`,
    <BlobView repo={l.repo} branch={at.branch} branches={l.branches} path={at.path} cloneUrl={l.cloneUrl} size={blob.size}
      binary={binary} truncated={!binary && blob.size > MAX_VIEW_BYTES} html={html} markdown={markdown} showingSource={showingSource} />,
  );
});

publicRoutes.get(`/:repo{${NAME}}/commits/*`, async (c) => {
  const l = await load(c);
  const branch = l && rest(c, l, "commits");
  if (!l || !branch || !l.branches.includes(branch)) return c.notFound();
  const pageNo = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  using h = await c.env.ARTIFACTS.get(l.repo.name);
  const list = await h.log({ ref: branch, limit: PER_PAGE + 1, offset: (pageNo - 1) * PER_PAGE });
  return page(
    c,
    `Commits · ${l.repo.name}`,
    <Commits repo={l.repo} branch={branch} branches={l.branches} commits={list.slice(0, PER_PAGE)} page={pageNo} hasNext={list.length > PER_PAGE} cloneUrl={l.cloneUrl} />,
  );
});

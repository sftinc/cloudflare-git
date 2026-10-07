import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearArtifactsCaches } from "../src/artifacts";
import { resetAccessKeys } from "../src/auth/access-jwt";
import * as repos from "../src/db/repos";
import { FakeArtifacts, fakeHash } from "./helpers/fake-artifacts";
import { makeEnv, request } from "./helpers/env";
import { stubArtifactsGit } from "./helpers/git-http";
import { ownerEnv, ownerToken } from "./helpers/jwt";

let fake: FakeArtifacts;
const big = "x".repeat(1_100_000);

async function addRepo(name: string, isPublic: boolean) {
  const r = await repos.insertRepo(env.DB, { name, description: `${name} description` }, 1);
  await repos.markProvisioned(env.DB, r.id, 1);
  if (isPublic) await repos.setPublic(env.DB, r.id, true, 1);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM repos WHERE name IN ('site','secret','empty','legacy','rich')").run();
  clearArtifactsCaches();
  resetAccessKeys();
  fake = new FakeArtifacts();
  fake.seed("site", {
    defaultBranch: "main",
    tags: ["v1.0.0"],
    lastPushAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    source: "github:acme/site",
    branches: {
      main: {
        files: {
          "README.md": "# Hello site\n\nSee [the guide](docs/guide.md).\n\n<script>alert(1)</script>",
          "src/index.ts": "export const answer: number = 42;",
          "docs/guide.md": "## Guide\n\n![Diagram](img/d.png)",
          "docs/my file #1.txt": "spaces",
          "data.bin": new Uint8Array([0, 1, 2, 3]),
          "✓ data.bin": new Uint8Array([0, 1, 2, 3]),
          "big.txt": big,
        },
        commits: Array.from({ length: 35 }, (_, i) => ({ message: `Commit ${35 - i}\n\nbody` })),
      },
      "feature/login": { files: { "login.ts": "export {}" } },
    },
  });
  fake.seed("secret", { branches: { main: { files: { "README.md": "# Secret" } } } });
  fake.seed("rich", {
    defaultBranch: "main",
    tags: ["dangling"], // a tag on something that is not a commit
    branches: {
      main: { files: { "a.txt": "on main" } },
      v2: { files: { "a.txt": "branch v2" }, commits: [{ message: "Branch v2 commit" }] },
    },
    tagged: {
      v1: { files: { "a.txt": "at tag v1", "old/b.txt": "b" }, commits: [{ message: "Tagged v1" }] },
      "v1.1": { files: { "a.txt": "at tag v1.1", "old/b.txt": "b" }, commits: [{ message: "Tagged v1.1" }], annotated: true },
      "rel/1.0": { files: { "a.txt": "at tag rel/1.0", "old/b.txt": "b" }, commits: [{ message: "Tagged rel/1.0" }] },
      v2: { files: { "a.txt": "tag v2" }, commits: [{ message: "Tag v2 commit" }] },
    },
  });
  await fake.create("empty");
  await addRepo("site", true);
  await addRepo("secret", false);
  await addRepo("empty", true);
  await addRepo("rich", true);
  stubArtifactsGit(fake);
});
afterEach(() => vi.restoreAllMocks());

const e = () => makeEnv({ ARTIFACTS: fake as unknown as Artifacts });
const e2 = (vars: Record<string, string>) => makeEnv({ ARTIFACTS: fake as unknown as Artifacts, ...vars });
const html = async (path: string, env = e(), headers: Record<string, string> = {}) => {
  const { res } = await request(path, { headers }, env);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

describe("home", () => {
  it("lists public repos only for strangers, all for the owner", async () => {
    const pub = await html("/");
    expect(pub.body).toContain('href="/r/site"');
    expect(pub.body).not.toContain('href="/r/secret"');
    expect(pub.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(pub.body).toContain('<a href="/admin" class="btn icon-btn" aria-label="Log in"');
    expect(pub.body).not.toContain("/admin/repos/new");
    expect(pub.body).not.toContain("/cdn-cgi/access/logout");
    expect(pub.body).not.toContain('class="menu"');
    expect(pub.body).toContain('<link rel="icon" href="/static/favicon.svg"'); // else browsers 404 on /favicon.ico
    const own = await html("/", await ownerEnv({ ARTIFACTS: fake }), { cookie: `CF_Authorization=${await ownerToken()}` });
    expect(own.body).toContain('href="/r/secret"');
    expect(own.body).toContain('href="/admin/repos/new"');
    expect(own.body).toContain('href="/cdn-cgi/access/logout"');
    expect(own.body).toContain('<li><a href="/admin/repos">');
    expect(own.body).not.toContain('aria-label="Log in"');
  });
  it("uses defaults when the site vars are unset, and the vars when set", async () => {
    const plain = await html("/");
    expect(plain.body).toContain("<span>Cloudflare Git</span>");
    expect(plain.body).toContain('<img src="/static/favicon.svg"');
    expect(plain.body).not.toContain("©");
    expect(plain.headers.get("content-security-policy")).toContain("img-src 'self';");
    const branded = await html("/", e2({ SITE_TITLE: "Example Code", LOGO_URL: "https://cdn.example.com/logo.svg", COMPANY_NAME: "Example Co." }));
    expect(branded.body).toContain("<span>Example Code</span>");
    expect(branded.body).toContain('<img src="https://cdn.example.com/logo.svg"');
    expect(branded.body).toContain(`© ${new Date().getFullYear()} Example Co.`);
    expect(branded.headers.get("content-security-policy")).toContain("img-src 'self' https://cdn.example.com;");
  });
  it("without Access configured there is no Log in, and clone URLs use the request origin", async () => {
    const r = await html("/", e2({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }));
    expect(r.body).not.toContain('aria-label="Log in"');
    expect((await html("/r/site", e2({ SITE_ORIGIN: "" }))).body).toContain("https://git.test/r/site.git");
  });
  it("shows an empty-state card", async () => {
    await env.DB.prepare("UPDATE repos SET public_at = NULL").run();
    const r = await html("/");
    expect(r.body).toContain("No repos to show");
    expect(r.body).not.toContain("New repo");
    const own = await html("/", await ownerEnv({ ARTIFACTS: fake }), { cookie: `CF_Authorization=${await ownerToken()}` });
    expect(own.body).not.toContain("No repos");
  });
});

describe("repo pages", () => {
  it("repo home falls back to an existing branch when HEAD names a missing one", async () => {
    fake.seed("legacy", { defaultBranch: "main", branches: { master: { files: { "README.md": "# On master" } } } });
    await addRepo("legacy", true);
    const { status, body } = await html("/r/legacy");
    expect(status).toBe(200);
    expect(body).toContain("<h1>On master</h1>");
  });
  it("repo home renders README safely, files, clone URL and branches", async () => {
    const { status, body } = await html("/r/site");
    expect(status).toBe(200);
    expect(body).toContain("<h1>Hello site</h1>");
    expect(body).toContain('href="/r/site/blob/main/docs/guide.md"');
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("https://git.test/r/site.git");
    expect(body).toContain('href="/r/site/tree/feature/login"');
    expect(body).toContain('href="/r/site/tree/main/src"');
  });
  it("repo home shows the branch picker and counts beside the title, and an About card", async () => {
    const { body } = await html("/r/site");
    expect(body).toContain('<a href="/" class="crumb">Repos</a>');
    expect(body).toContain("<strong>2</strong> branches");
    expect(body).toContain("<strong>1</strong> tag<");
    const about = body.split('<aside class="about">')[1].split("</aside>")[0];
    expect(about).toContain("site description");
    expect(about).toContain('href="/r/site/blob/main/README.md"');
    expect(about).toContain("Default branch <strong>main</strong>");
    expect(about).toContain("Pushed <strong>3 days ago</strong>");
    expect(about).toContain("Imported from <strong>github:acme/site</strong>");
    expect(body).toContain('href="/r/site/commits/main"');
  });
  it("leaves out About rows it has nothing for, and About on subfolders", async () => {
    const secret = await html("/r/secret", await ownerEnv({ ARTIFACTS: fake }), { "cf-access-jwt-assertion": await ownerToken() });
    const about = secret.body.split('<aside class="about">')[1].split("</aside>")[0];
    expect(about).not.toContain("Pushed");
    expect(about).not.toContain("Imported from");
    expect(secret.body).toContain("<strong>1</strong> branch<");
    expect((await html("/r/site/tree/main/docs")).body).not.toContain('<aside class="about">');
  });
  it("private repos are 404 for strangers", async () => {
    expect((await html("/r/secret")).status).toBe(404);
    expect((await html("/r/secret/blob/main/README.md")).status).toBe(404);
  });
  it("empty repos show push instructions", async () => {
    const { status, body } = await html("/r/empty");
    expect(status).toBe(200);
    expect(body).toContain("This repo is empty");
  });
  it("branches with slashes and encoded paths work", async () => {
    expect((await html("/r/site/tree/feature/login")).body).toContain('href="/r/site/blob/feature/login/login.ts"');
    const dir = await html("/r/site/tree/main/docs");
    expect(dir.body).toContain('href="/r/site/blob/main/docs/my%20file%20%231.txt"');
    const file = await html("/r/site/blob/main/docs/my%20file%20%231.txt");
    expect(file.status).toBe(200);
    expect(file.body).toContain("spaces");
  });
  it.each(["/r/site/tree/nope", "/r/site/tree/main/missing", "/r/site/blob/main/missing.txt", "/r/site/blob/main", "/r/site/commits/nope", "/r/nosuchrepo", "/r/site/blob/main/%E0%A4%A"])(
    "%s is a 404 page",
    async (path) => {
      const r = await html(path);
      expect(r.status).toBe(404);
      expect(r.body).toContain("Not found");
    },
  );
});

describe("files", () => {
  it("shows a file tree opened down to the current file, on a wide page", async () => {
    const r = await html("/r/site/blob/main/docs/guide.md");
    expect(r.body).toContain('<body class="wide">');
    const tree = r.body.split('<nav class="file-tree"')[1].split("</nav>")[0];
    expect(tree).toContain('href="/r/site/tree/main/src"'); // root siblings
    expect(tree).toContain('href="/r/site/blob/main/docs/my%20file%20%231.txt"'); // the open folder's files
    expect(tree).toContain('<a href="/r/site/blob/main/docs/guide.md" class="node" aria-current="page">');
    expect(tree).not.toContain("index.ts"); // closed folders stay closed
    const dir = await html("/r/site/tree/main/docs");
    expect(dir.body).toContain('<a href="/r/site/tree/main/docs" class="node dir open" aria-current="page">');
    expect((await html("/r/site")).body).not.toContain('class="file-tree"');
  });
  it("numbers lines and counts them in the header", async () => {
    const r = await html("/r/site/blob/main/README.md?source=1");
    expect(r.body).toContain('<div class="ln" aria-hidden="true">1\n2\n3\n4\n5</div>');
    expect(r.body).toContain("5 lines · ");
    expect(r.body).toContain('data-copy-url="/r/site/blob/main/README.md?raw=1"');
  });
  it("switches markdown between Preview and Code", async () => {
    const preview = await html("/r/site/blob/main/docs/guide.md");
    expect(preview.body).toContain('<a href="/r/site/blob/main/docs/guide.md" aria-current="page">Preview</a>');
    expect(preview.body).toContain('<a href="/r/site/blob/main/docs/guide.md?source=1">Code</a>');
    expect((await html("/r/site/blob/main/docs/guide.md?source=1")).body).toContain('<a href="/r/site/blob/main/docs/guide.md?source=1" aria-current="page">Code</a>');
  });
  it("highlights code", async () => {
    expect((await html("/r/site/blob/main/src/index.ts")).body).toContain("hljs-keyword");
  });
  it("renders markdown with images as links, and shows source on request", async () => {
    const md = await html("/r/site/blob/main/docs/guide.md");
    expect(md.body).toContain("<h2>Guide</h2>");
    expect(md.body.split("<main")[1]).not.toContain("<img"); // the header logo is the only <img>
    expect(md.body).toContain('href="/r/site/blob/main/docs/img/d.png"');
    expect((await html("/r/site/blob/main/docs/guide.md?source=1")).body).toContain("## Guide");
  });
  it("raw text is text/plain and sandboxed", async () => {
    const r = await html("/r/site/blob/main/README.md?raw=1");
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.body).toContain("<script>alert(1)</script>");
  });
  it("binary files download and are not shown inline", async () => {
    const raw = await html("/r/site/blob/main/data.bin?raw=1");
    expect(raw.headers.get("content-type")).toBe("application/octet-stream");
    expect(raw.headers.get("content-disposition")).toBe("attachment; filename=\"data.bin\"; filename*=UTF-8''data.bin");
    expect((await html("/r/site/blob/main/data.bin")).body).toContain("Binary file not shown");
  });
  it("binary downloads with non-ASCII names do not crash", async () => {
    const r = await html("/r/site/blob/main/%E2%9C%93%20data.bin?raw=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toContain("filename*=UTF-8''%E2%9C%93%20data.bin");
  });
  it("files Artifacts cannot read show a too-large page", async () => {
    fake.failNext = { method: "readFile", code: "INTERNAL_ERROR" };
    const r = await html("/r/site/blob/main/big.txt");
    expect(r.status).toBe(200);
    expect(r.body).toContain("File too large to display");
  });
  it("large files are truncated with a notice", async () => {
    const r = await html("/r/site/blob/main/big.txt");
    expect(r.body).toContain("Showing the first 1 MB");
    expect(r.body.length).toBeLessThan(1_200_000);
  });
});

describe("old names", () => {
  const rename = (name: string, to: string) => repos.findRepoByName(env.DB, name).then((r) => repos.renameRepo(env.DB, r!.id, to, 2));
  const at = async (path: string, headers: Record<string, string> = {}) => {
    const r = await html(path, e(), headers);
    return { status: r.status, location: r.headers.get("location") };
  };

  it("redirects every old name straight to the current one, keeping path and query", async () => {
    await addRepo("al-foo", true);
    await rename("al-foo", "al-bar");
    await rename("al-bar", "al-baz");
    for (const old of ["al-foo", "al-bar"]) {
      expect(await at(`/r/${old}`)).toEqual({ status: 302, location: "/r/al-baz" });
      expect(await at(`/r/${old}/blob/main/a.txt?raw=1`)).toEqual({ status: 302, location: "/r/al-baz/blob/main/a.txt?raw=1" });
      expect((await at(`/r/${old}/tree/main/src`)).location).toBe("/r/al-baz/tree/main/src");
      expect((await at(`/r/${old}/commits/main?page=2`)).location).toBe("/r/al-baz/commits/main?page=2");
    }
  });
  it("hides a private repo's new name from strangers but redirects the owner", async () => {
    await addRepo("al-priv", false);
    await rename("al-priv", "al-priv2");
    expect(await at("/r/al-priv")).toEqual({ status: 404, location: null });
    const own = await html("/r/al-priv", await ownerEnv({ ARTIFACTS: fake }), { cookie: `CF_Authorization=${await ownerToken()}` });
    expect([own.status, own.headers.get("location")]).toEqual([302, "/r/al-priv2"]);
  });
  it("lets another repo take a released old name and serves it", async () => {
    await addRepo("al-one", true);
    await addRepo("al-two", true);
    fake.seed("al-two", { branches: { main: { files: { "README.md": "# Two" } } } });
    await rename("al-one", "al-uno");
    expect((await at("/r/al-one")).status).toBe(302);
    await rename("al-two", "al-one");
    const r = await html("/r/al-one");
    expect(r.status).toBe(200);
    expect(r.body).toContain("<h1>Two</h1>");
  });
});

describe("commits", () => {
  it("paginates 30 per page", async () => {
    const p1 = await html("/r/site/commits/main");
    expect(p1.body).toContain("Commit 35");
    expect(p1.body).not.toContain("Commit 5<");
    expect(p1.body).toContain("?page=2");
    const p2 = await html("/r/site/commits/main?page=2");
    expect(p2.body).toContain("Commit 5");
    expect(p2.body).not.toContain("?page=3");
  });
  it("groups commits by day, with the full SHA to copy", async () => {
    const r = await html("/r/site/commits/main");
    expect(r.body).toContain("Commits on Oct 9, 2025");
    expect(r.body).toContain("Commits on Oct 8, 2025");
    expect(r.body).toContain(`data-copy="${fakeHash("commit:main:0")}"`);
    expect(r.body).toContain('aria-disabled="true">← Newer');
    expect((await html("/r/site/commits/feature/login")).body).not.toContain('class="pager"'); // one page: no pager
  });
  it("404s a page past the last commit, and reads a bad page number as page 1", async () => {
    expect((await html("/r/site/commits/main?page=3")).status).toBe(404);
    expect((await html("/r/site/commits/main?page=999999999999")).status).toBe(404);
    for (const bad of ["0", "-2", "abc", ""]) {
      const r = await html(`/r/site/commits/main?page=${bad}`);
      expect(r.status).toBe(200);
      expect(r.body).toContain("Commit 35");
    }
  });
  it("needs an exact ref in the URL", async () => {
    expect((await html("/r/site/commits/feature/login")).status).toBe(200);
    for (const path of ["/r/site/commits/main/extra", "/r/site/commits/feature", "/r/site/commits/"]) expect((await html(path)).status).toBe(404);
  });
});

describe("errors", () => {
  it("Artifacts failures show a 502 page", async () => {
    fake.failNext = { method: "get", code: "INTERNAL_ERROR" };
    const r = await html("/r/site");
    expect(r.status).toBe(502);
    expect(r.body).toContain("Storage unavailable");
  });
});

describe("tags", () => {
  it.each(["v1", "v1.1", "rel/1.0"])("browses the tree, a blob and the commits at tag %s", async (tag) => {
    const tree = await html(`/r/rich/tree/${tag}`);
    expect(tree.status).toBe(200);
    expect(tree.body).toContain(`href="/r/rich/tree/${tag}/old"`); // a folder main does not have
    expect(tree.body).toContain(`href="/r/rich/blob/${tag}/a.txt"`);
    const blob = await html(`/r/rich/blob/${tag}/a.txt`);
    expect(blob.status).toBe(200);
    expect(blob.body).toContain(`at tag ${tag}`);
    expect((await html(`/r/rich/blob/${tag}/old/b.txt`)).status).toBe(200);
    const log = await html(`/r/rich/commits/${tag}`);
    expect(log.status).toBe(200);
    expect(log.body).toContain(`Tagged ${tag}`);
  });
  it("a branch wins over a tag of the same name", async () => {
    const blob = await html("/r/rich/blob/v2/a.txt");
    expect(blob.body).toContain("branch v2");
    expect(blob.body).not.toContain("tag v2");
    expect((await html("/r/rich/commits/v2")).body).toContain("Branch v2 commit");
    expect((await html("/r/rich/tree/v2")).body).toContain('href="/r/rich/blob/v2/a.txt"');
  });
  it("a tag that does not point at a commit is a 404", async () => {
    for (const path of ["/r/rich/tree/dangling", "/r/rich/blob/dangling/a.txt", "/r/rich/commits/dangling"]) expect((await html(path)).status).toBe(404);
  });
});

describe("branch switcher", () => {
  it("lists tags under a Tags heading and badges a tag page", async () => {
    const onTag = await html("/r/rich/tree/v1");
    expect(onTag.body).toContain('<li class="group">Tags</li>');
    expect(onTag.body).toContain('<span class="badge">tag</span>');
    expect(onTag.body).toContain('<a href="/r/rich/tree/v1" class="current">v1</a>');
    expect(onTag.body).toContain('<a href="/r/rich/tree/rel/1.0">rel/1.0</a>');
    expect((await html("/r/rich/commits/v1")).body).toContain('<a href="/r/rich/commits/rel/1.0">rel/1.0</a>');
    expect((await html("/r/rich/blob/v1/a.txt")).body).toContain('<span class="badge">tag</span>');
    const onBranch = await html("/r/rich");
    expect(onBranch.body).toContain('<li class="group">Tags</li>');
    expect(onBranch.body).toContain('<a href="/r/rich/tree/main" class="current">main</a>');
    expect(onBranch.body).not.toContain('<span class="badge">tag</span>');
  });
  it("leaves out the Tags heading when there are no tags", async () => {
    const r = await html("/r/secret", await ownerEnv({ ARTIFACTS: fake }), { "cf-access-jwt-assertion": await ownerToken() });
    expect(r.body).toContain('class="branches"');
    expect(r.body).not.toContain('class="group"');
  });
});

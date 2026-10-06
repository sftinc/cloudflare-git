import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearArtifactsCaches } from "../src/artifacts";
import { resetAccessKeys } from "../src/auth/access-jwt";
import * as repos from "../src/db/repos";
import { FakeArtifacts } from "./helpers/fake-artifacts";
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
  await env.DB.prepare("DELETE FROM repos WHERE name IN ('site','secret','empty','legacy')").run();
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
  await fake.create("empty");
  await addRepo("site", true);
  await addRepo("secret", false);
  await addRepo("empty", true);
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
});

describe("errors", () => {
  it("Artifacts failures show a 502 page", async () => {
    fake.failNext = { method: "get", code: "INTERNAL_ERROR" };
    const r = await html("/r/site");
    expect(r.status).toBe(502);
    expect(r.body).toContain("Storage unavailable");
  });
});

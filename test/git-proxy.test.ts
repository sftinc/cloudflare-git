import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { ZERO_SHA, encodePkt } from "../src/git/pktline";
import { clearArtifactsCaches } from "../src/artifacts";
import { sha256Hex } from "../src/lib/crypto";
import * as repos from "../src/db/repos";
import * as tokens from "../src/db/tokens";
import * as hooks from "../src/db/webhooks";
import { FakeArtifacts } from "./helpers/fake-artifacts";
import { makeEnv, request } from "./helpers/env";
import { stubFetch } from "./helpers/git-http";

const A = "a".repeat(40), B = "b".repeat(40);
const enc = new TextEncoder();
const auth = (pw: string) => ({ Authorization: `Basic ${btoa(`x:${pw}`)}` });

let fake: FakeArtifacts;
let upstream: Request[];

async function setup() {
  for (const t of ["webhooks", "push_token_repos", "push_tokens", "repo_aliases", "repos"]) await env.DB.exec(`DELETE FROM ${t}`);
  fake = new FakeArtifacts();
  for (const name of ["pub", "priv"]) {
    fake.seed(name, { branches: { main: { files: { "a.txt": "a" } } } });
    const r = await repos.insertRepo(env.DB, { name, description: null }, 1);
    await repos.markProvisioned(env.DB, r.id, 1);
    if (name === "pub") await repos.setPublic(env.DB, r.id, true, 1);
  }
  await tokens.createPushToken(env.DB, { name: "laptop", tokenHash: await sha256Hex("tok"), repoIds: [], allRepos: true }, 1);
  const priv = (await repos.findRepoByName(env.DB, "priv"))!;
  await hooks.createWebhook(env.DB, { repoId: priv.id, url: "https://hooks.test/build", branch: "main", secret: "k" }, 1);
}

function report(lines: string[], sideBand: boolean) {
  const inner = lines.map((l) => encodePkt(`${l}\n`)).join("") + "0000";
  return enc.encode(sideBand ? encodePkt(`\x01${inner}`) + "0000" : inner);
}

beforeEach(async () => {
  clearArtifactsCaches();
  await setup();
  upstream = [];
  stubFetch(async (req) => {
    if (req.url.startsWith("https://hooks.test/")) { upstream.push(req); return new Response("ok"); }
    if (!req.url.startsWith("https://fake.artifacts.test/")) return undefined;
    upstream.push(req);
    const path = new URL(req.url).pathname;
    if (path.endsWith("/info/refs")) return new Response(encodePkt("# service=x\n") + "0000", { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } });
    if (path.endsWith("/git-upload-pack")) return new Response("PACKDATA", { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
    if (path.endsWith("/git-receive-pack")) {
      await req.arrayBuffer();
      return new Response(report(["unpack ok", "ok refs/heads/main", "ng refs/heads/stale stale info"], true), { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    }
    return undefined;
  });
});
afterEach(() => vi.restoreAllMocks());

const e = () => makeEnv({ ARTIFACTS: fake as unknown as Artifacts });

describe("access", () => {
  it.each([
    ["GET", "/r/pub.git/info/refs?service=git-upload-pack", {}, 200],
    ["GET", "/r/priv.git/info/refs?service=git-upload-pack", {}, 401],
    ["GET", "/r/nope.git/info/refs?service=git-upload-pack", {}, 401],
    ["GET", "/r/nope.git/info/refs?service=git-upload-pack", auth("tok"), 404],
    ["GET", "/r/priv.git/info/refs?service=git-upload-pack", auth("wrong"), 404],
    ["GET", "/r/priv.git/info/refs?service=git-upload-pack", auth("tok"), 200],
    ["GET", "/r/pub.git/info/refs?service=git-receive-pack", {}, 401],
    ["GET", "/r/pub.git/info/refs?service=git-receive-pack", auth("tok"), 200],
    ["GET", "/r/pub.git/info/refs?service=bogus", {}, 404],
    ["GET", "/r/pub.git/HEAD", {}, 404],
    ["GET", "/r/pub.git/objects/info/packs", {}, 404],
  ] as const)("%s %s → %i", async (method, path, headers, status) => {
    const { res } = await request(path, { method, headers }, e());
    expect(res.status).toBe(status);
    if (status === 401) expect(res.headers.get("www-authenticate")).toBe('Basic realm="cloudflare-git"');
  });

  it("deleted repos are 404 even with a token", async () => {
    const r = (await repos.findRepoByName(env.DB, "pub"))!;
    await repos.setDeleted(env.DB, r.id, true, 2);
    const { res } = await request("/r/pub.git/info/refs?service=git-upload-pack", { headers: auth("tok") }, e());
    expect(res.status).toBe(404);
  });
});

describe("forwarding", () => {
  it("adds a Bearer read token and forwards Git-Protocol (v2)", async () => {
    const { res } = await request("/r/pub.git/git-upload-pack", {
      method: "POST",
      headers: { "Content-Type": "application/x-git-upload-pack-request", "Git-Protocol": "version=2" },
      body: "0000",
    }, e());
    expect(await res.text()).toBe("PACKDATA");
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const up = upstream.find((r) => r.url.endsWith("/git-upload-pack"))!;
    expect(up.url).toBe("https://fake.artifacts.test/git/ns/pub.git/git-upload-pack");
    expect(up.headers.get("authorization")).toMatch(/^Bearer art_v1_read/);
    expect(up.headers.get("git-protocol")).toBe("version=2");
  });

  it("maps upstream failures to 502", async () => {
    vi.restoreAllMocks();
    stubFetch(() => new Response("boom", { status: 500 }));
    const { res } = await request("/r/pub.git/info/refs?service=git-upload-pack", {}, e());
    expect(res.status).toBe(502);
  });
});

describe("push", () => {
  const pushBody = () =>
    encodePkt(`${A} ${B} refs/heads/main\0report-status side-band-64k\n`) +
    encodePkt(`${A} ${B} refs/heads/stale\n`) +
    "0000PACK\x00\x00\x00\x02\x00\x00\x00\x00";

  it("streams the push with a write token and fires webhooks for accepted branches only", async () => {
    const { res, done } = await request("/r/priv.git/git-receive-pack", {
      method: "POST",
      headers: { ...auth("tok"), "Content-Type": "application/x-git-receive-pack-request" },
      body: pushBody(),
    }, e());
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await done();
    const up = upstream.find((r) => r.url.endsWith("/git-receive-pack"))!;
    expect(up.headers.get("authorization")).toMatch(/^Bearer art_v1_write/);
    const delivered = upstream.filter((r) => r.url.startsWith("https://hooks.test/"));
    expect(delivered).toHaveLength(1);
    expect(await delivered[0].json()).toMatchObject({ repo: "priv", branch: "main", before: A, after: B, deleted: false });
    const tok = (await tokens.listPushTokens(env.DB))[0];
    expect(tok.last_used_at).not.toBeNull();
  });

  it("forwards gzip push bodies untouched and skips webhooks", async () => {
    const { res, done } = await request("/r/priv.git/git-receive-pack", {
      method: "POST",
      headers: { ...auth("tok"), "Content-Type": "application/x-git-receive-pack-request", "Content-Encoding": "gzip" },
      body: "\x1f\x8b-not-really-gzip",
    }, e());
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await done();
    const up = upstream.find((r) => r.url.endsWith("/git-receive-pack"))!;
    expect(up.headers.get("content-encoding")).toBe("gzip");
    expect(upstream.filter((r) => r.url.startsWith("https://hooks.test/"))).toHaveLength(0);
  });

  it("rewrites a known fatal error from upstream, also for a compressed push", async () => {
    vi.restoreAllMocks();
    const fatal = encodePkt("\x03artifacts_git_receive_pack_object_too_large\n");
    stubFetch(async (req) => {
      if (!req.url.startsWith("https://fake.artifacts.test/")) return undefined;
      await req.arrayBuffer();
      return new Response(fatal, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    });
    const want = encodePkt("\x03A file in this push is over the 32 MB per-file limit. Remove it from the commits (for example with git filter-repo) and push again.\n");
    for (const [body, extra] of [[pushBody(), {}], ["\x1f\x8b-not-gzip", { "Content-Encoding": "gzip" }]] as const) {
      const { res, done } = await request("/r/priv.git/git-receive-pack", {
        method: "POST",
        headers: { ...auth("tok"), "Content-Type": "application/x-git-receive-pack-request", ...extra },
        body,
      }, e());
      expect(await res.text()).toBe(want);
      await done();
    }
  });

  it("an unparseable report fires no webhooks", async () => {
    vi.restoreAllMocks();
    upstream = [];
    stubFetch(async (req) => {
      if (req.url.startsWith("https://hooks.test/")) { upstream.push(req); return new Response("ok"); }
      await req.arrayBuffer();
      return new Response("garbage-without-pkt-lines");
    });
    const { res, done } = await request("/r/priv.git/git-receive-pack", {
      method: "POST",
      headers: { ...auth("tok"), "Content-Type": "application/x-git-receive-pack-request" },
      body: pushBody(),
    }, e());
    await res.arrayBuffer();
    await done();
    expect(upstream).toHaveLength(0);
  });

  it("fires webhooks when upstream sends headers before reading the push body", async () => {
    vi.restoreAllMocks();
    upstream = [];
    stubFetch(async (req) => {
      if (req.url.startsWith("https://hooks.test/")) { upstream.push(req); return new Response("ok"); }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await req.arrayBuffer();
          controller.enqueue(report(["unpack ok", "ok refs/heads/main"], true));
          controller.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    });
    const { res, done } = await request("/r/priv.git/git-receive-pack", {
      method: "POST",
      headers: { ...auth("tok"), "Content-Type": "application/x-git-receive-pack-request" },
      body: pushBody(),
    }, e());
    await res.arrayBuffer();
    await done();
    expect(upstream).toHaveLength(1);
    expect(await upstream[0].json()).toMatchObject({ branch: "main" });
  });

  it("ZERO_SHA delete fires a deleted event", async () => {
    vi.restoreAllMocks();
    upstream = [];
    stubFetch(async (req) => {
      if (req.url.startsWith("https://hooks.test/")) { upstream.push(req); return new Response("ok"); }
      await req.arrayBuffer();
      return new Response(report(["unpack ok", "ok refs/heads/main"], false));
    });
    const body = encodePkt(`${A} ${ZERO_SHA} refs/heads/main\0report-status delete-refs\n`) + "0000";
    const { res, done } = await request("/r/priv.git/git-receive-pack", { method: "POST", headers: auth("tok"), body }, e());
    await res.arrayBuffer();
    await done();
    expect(await upstream[0].json()).toMatchObject({ branch: "main", deleted: true, after: ZERO_SHA });
  });
});

describe("old names", () => {
  const rename = async (from: string, to: string) => repos.renameRepo(env.DB, (await repos.findRepoByName(env.DB, from))!.id, to, 2);
  const MOVED = "0039\x02This repository moved. Please use the new location:\n" + "0024\x02  https://git.test/r/priv2.git\n";
  const pushBody = () =>
    encodePkt(`${A} ${B} refs/heads/main\0report-status side-band-64k\n`) + "0000PACK\x00\x00\x00\x02\x00\x00\x00\x00";
  const RESULT = report(["unpack ok", "ok refs/heads/main", "ng refs/heads/stale stale info"], true); // what the default stub sends
  const push = async (path: string, body: BodyInit, extra: Record<string, string> = {}) => {
    const { res, done } = await request(path, {
      method: "POST",
      headers: { ...auth("tok"), "Content-Type": "application/x-git-receive-pack-request", ...extra },
      body,
    }, e());
    const bytes = new Uint8Array(await res.arrayBuffer());
    await done();
    return { res, bytes, text: new TextDecoder().decode(bytes) };
  };
  /** Delivers the string a few bytes at a time. */
  const fragments = (bytes: Uint8Array, n: number) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < bytes.length; i += n) {
          controller.enqueue(bytes.slice(i, i + n));
          await new Promise((r) => setTimeout(r, 0));
        }
        controller.close();
      },
    });

  it("serves fetch and push at an old name from the original storage repo, authorised as the target", async () => {
    await rename("pub", "pub2");
    await rename("priv", "priv2");
    const fetched = await request("/r/pub.git/git-upload-pack", { method: "POST", body: "0000" }, e());
    expect(await fetched.res.text()).toBe("PACKDATA");
    expect(upstream.find((r) => r.url.endsWith("/git-upload-pack"))!.url).toBe("https://fake.artifacts.test/git/ns/pub.git/git-upload-pack");
    const { res } = await request("/r/priv.git/info/refs?service=git-upload-pack", { headers: auth("tok") }, e());
    expect(res.status).toBe(200);
    const sent = pushBody();
    await push("/r/priv.git/git-receive-pack", sent);
    const up = upstream.find((r) => r.url.endsWith("/git-receive-pack"))!;
    expect(up.url).toBe("https://fake.artifacts.test/git/ns/priv.git/git-receive-pack");
    expect(up.headers.get("authorization")).toMatch(/^Bearer art_v1_write/);
    const hook = upstream.find((r) => r.url.startsWith("https://hooks.test/"))!;
    expect(await hook.json()).toMatchObject({ repo: "priv2", branch: "main" });
  });

  it("gives an alias to a private repo the same 401 and 404 as its current name", async () => {
    await rename("priv", "priv2");
    for (const [headers, status] of [[{}, 401], [auth("wrong"), 404], [auth("tok"), 200]] as const) {
      const old = await request("/r/priv.git/info/refs?service=git-upload-pack", { headers }, e());
      const cur = await request("/r/priv2.git/info/refs?service=git-upload-pack", { headers }, e());
      expect([old.res.status, cur.res.status]).toEqual([status, status]);
    }
  });

  it("a name that is no longer an alias is gone", async () => {
    await rename("priv", "priv2");
    await rename("pub", "priv"); // takes the released name
    const { res } = await request("/r/priv.git/info/refs?service=git-upload-pack", { headers: auth("tok") }, e());
    expect(res.status).toBe(200);
    expect(upstream.at(-1)!.url).toContain("/git/ns/pub.git/");
  });

  it("a side-band push to an old name gets the moved notice, then the upstream bytes unchanged", async () => {
    await rename("priv", "priv2");
    const { text, bytes } = await push("/r/priv.git/git-receive-pack", pushBody());
    expect(text).toBe(MOVED + new TextDecoder().decode(RESULT));
    expect(bytes.length).toBe(MOVED.length + RESULT.length);
    expect(upstream.filter((r) => r.url.startsWith("https://hooks.test/"))).toHaveLength(1);
  });

  it("adds the notice when upstream sends headers early, and when everything arrives in fragments", async () => {
    await rename("priv", "priv2");
    for (const mode of ["early", "fragments"]) {
      vi.restoreAllMocks();
      upstream = [];
      stubFetch(async (req) => {
        if (req.url.startsWith("https://hooks.test/")) { upstream.push(req); return new Response("ok"); }
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            await req.arrayBuffer();
            if (mode === "early") controller.enqueue(RESULT);
            else for (let i = 0; i < RESULT.length; i += 5) controller.enqueue(RESULT.slice(i, i + 5));
            controller.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
      });
      const sent = enc.encode(pushBody());
      const { text } = await push("/r/priv.git/git-receive-pack", mode === "early" ? pushBody() : fragments(sent, 7));
      expect(text).toBe(MOVED + new TextDecoder().decode(RESULT));
      expect(upstream.filter((r) => r.url.startsWith("https://hooks.test/"))).toHaveLength(1);
    }
  });

  it("adds no notice for the current name, without side-band, or for a compressed push", async () => {
    await rename("priv", "priv2");
    const plain = new TextDecoder().decode(RESULT);
    expect((await push("/r/priv2.git/git-receive-pack", pushBody())).text).toBe(plain);
    const noBand = encodePkt(`${A} ${B} refs/heads/main\0report-status\n`) + "0000PACK";
    expect((await push("/r/priv.git/git-receive-pack", noBand)).text).toBe(plain);
    expect((await push("/r/priv.git/git-receive-pack", "\x1f\x8b-not-gzip", { "Content-Encoding": "gzip" })).text).toBe(plain);
    const fetched = await request("/r/priv.git/git-upload-pack", { method: "POST", headers: auth("tok"), body: "0000" }, e());
    expect(await fetched.res.text()).toBe("PACKDATA");
  });
});

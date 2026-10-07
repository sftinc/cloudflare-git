import { vi } from "vitest";
import type { FakeArtifacts } from "./fake-artifacts";
import { fakeHash } from "./fake-artifacts";

const enc = new TextEncoder();

function pkt(s: string): string {
  return (s.length + 4).toString(16).padStart(4, "0") + s;
}

/** v1 upload-pack ref advertisement. refs: full ref name -> sha. */
export function refAdvertisement(refs: Record<string, string>, head: string | null): Uint8Array {
  const caps = `multi_ack side-band-64k ofs-delta${head ? ` symref=HEAD:refs/heads/${head}` : ""} agent=git/fake`;
  let body = pkt("# service=git-upload-pack\n") + "0000";
  const entries = Object.entries(refs);
  if (entries.length === 0) body += pkt(`${"0".repeat(40)} capabilities^{}\0${caps}\n`);
  entries.forEach(([name, sha], i) => {
    body += pkt(i === 0 ? `${sha} ${name}\0${caps}\n` : `${sha} ${name}\n`);
  });
  return enc.encode(body + "0000");
}

type Handler = (req: Request) => Response | Promise<Response> | undefined | Promise<Response | undefined>;

/** Replaces global fetch. Unhandled requests throw so tests notice. */
export function stubFetch(handler: Handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const res = await handler(req);
    if (!res) throw new Error(`unexpected fetch ${req.method} ${req.url}`);
    return res;
  });
}

/** Serves info/refs for every FakeArtifacts repo; `extra` handles anything else. */
export function stubArtifactsGit(fake: FakeArtifacts, extra?: Handler) {
  return stubFetch(async (req) => {
    const url = new URL(req.url);
    const m = /^\/git\/ns\/([^/]+)\.git\/info\/refs$/.exec(url.pathname);
    if (url.host === "fake.artifacts.test" && m && url.searchParams.get("service") === "git-upload-pack") {
      const r = fake.repos.get(m[1]);
      if (!r) return new Response("not found", { status: 404 });
      const refs: Record<string, string> = {};
      for (const b of r.commits.keys()) if (!b.startsWith("refs/tags/")) refs[`refs/heads/${b}`] = fakeHash(`commit:${b}:0`);
      for (const t of r.tags) {
        refs[`refs/tags/${t}`] = fakeHash(`tag:${t}`);
        refs[`refs/tags/${t}^{}`] = fakeHash(`commit:${t}`); // annotated tags are advertised twice; this peeled hash matches no fake commit
      }
      for (const [t, annotated] of r.tagged) {
        const commit = fakeHash(`commit:refs/tags/${t}:0`);
        refs[`refs/tags/${t}`] = annotated ? fakeHash(`tag:${t}`) : commit; // a lightweight tag points at the commit itself
        if (annotated) refs[`refs/tags/${t}^{}`] = commit;
      }
      // Artifacts advertises HEAD's symref even when that branch has never been pushed.
      return new Response(refAdvertisement(refs, r.defaultBranch), {
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      });
    }
    return extra?.(req);
  });
}

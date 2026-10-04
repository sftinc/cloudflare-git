import { describe, expect, it } from "vitest";
import { CommandParser, PktReader, ReportParser, ZERO_SHA, encodePkt, parseRefAdvertisement, tap } from "../src/git/pktline";
import { pushFixtures } from "./fixtures/git/pushes";
import { refAdvertisement } from "./helpers/git-http";

const enc = new TextEncoder();
const A = "a".repeat(40), B = "b".repeat(40);

function b64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Splits bytes into chunks of the given sizes (cycling). */
function chunks(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0, i = 0; off < bytes.length; i++) {
    const n = sizes[i % sizes.length];
    out.push(bytes.slice(off, off + n));
    off += n;
  }
  return out;
}

describe("PktReader", () => {
  it("parses data, flush and partial lines across chunks", () => {
    const r = new PktReader();
    const bytes = enc.encode(encodePkt("hello\n") + "0000");
    const got = chunks(bytes, [3]).flatMap((c) => r.push(c));
    expect(got.map((p) => p.kind)).toEqual(["data", "flush"]);
  });
  it("stops at flush when asked, leaving binary data unread", () => {
    const r = new PktReader();
    const got = r.push(enc.encode(encodePkt("x\n") + "0000PACK\x00\x00\x00\x02"), true);
    expect(got.map((p) => p.kind)).toEqual(["data", "flush"]);
  });
  it("throws on a malformed length", () => {
    expect(() => new PktReader().push(enc.encode("zzzzabc"))).toThrow();
  });
});

describe("CommandParser", () => {
  it("parses commands and capabilities, then stops", () => {
    const p = new CommandParser();
    const body = encodePkt(`${ZERO_SHA} ${A} refs/heads/new\0report-status side-band-64k agent=git/2\n`) +
      encodePkt(`${A} ${B} refs/heads/main\n`) + "0000" + "PACK";
    const doneAt = chunks(enc.encode(body), [1]).findIndex((c) => p.push(c));
    expect(doneAt).toBeGreaterThan(0);
    expect(p.capabilities).toContain("side-band-64k");
    expect(p.commands).toEqual([
      { oldSha: ZERO_SHA, newSha: A, ref: "refs/heads/new" },
      { oldSha: A, newSha: B, ref: "refs/heads/main" },
    ]);
  });
});

describe("ReportParser", () => {
  it("reads plain report-status", () => {
    const p = new ReportParser(false);
    p.push(enc.encode(encodePkt("unpack ok\n") + encodePkt("ok refs/heads/a\n") + encodePkt("ng refs/heads/b stale info\n") + "0000"));
    expect(p.done).toBe(true);
    expect(p.unpackOk).toBe(true);
    expect(p.results).toEqual([{ ref: "refs/heads/a", ok: true }, { ref: "refs/heads/b", ok: false, reason: "stale info" }]);
  });
  it("a band-3 error with no report-status yields no accepted refs (spike: blob over 32 MB)", () => {
    const p = new ReportParser(true);
    p.push(enc.encode(encodePkt("\x03artifacts_git_receive_pack_object_too_large\n") + "0000"));
    expect(p.results.filter((r) => r.ok)).toEqual([]);
  });
  it("reads report-status inside side-band channel 1 and ignores progress", () => {
    const inner = encodePkt("unpack ok\n") + encodePkt("ok refs/heads/a\n") + "0000";
    const body = encodePkt("\x02progress...\n") + encodePkt("\x01" + inner) + "0000";
    const p = new ReportParser(true);
    chunks(enc.encode(body), [2, 5]).forEach((c) => p.push(c));
    expect(p.done).toBe(true);
    expect(p.results).toEqual([{ ref: "refs/heads/a", ok: true }]);
  });
});

describe("real Artifacts pushes (Task 0 fixtures)", () => {
  for (const f of pushFixtures) {
    for (const sizes of [[1], [7, 3, 1000], [65536]]) {
      it(`${f.name} in chunks of ${sizes.join(",")}`, () => {
        const cp = new CommandParser();
        chunks(b64(f.request), sizes).some((c) => cp.push(c));
        expect(cp.commands).toEqual(f.expectCommands);
        const rp = new ReportParser(f.sideBand);
        chunks(b64(f.response), sizes).some((c) => rp.push(c));
        expect(rp.done).toBe(true);
        expect(rp.results.map(({ ref, ok }) => ({ ref, ok }))).toEqual(f.expectResults);
      });
    }
  }
});

describe("parseRefAdvertisement", () => {
  it("returns refs and the HEAD branch", () => {
    const { refs, head } = parseRefAdvertisement(refAdvertisement({ "refs/heads/main": A, "refs/heads/feature/x": B, "refs/tags/v1": A }, "main"));
    expect(head).toBe("main");
    expect([...refs.keys()]).toEqual(["refs/heads/main", "refs/heads/feature/x", "refs/tags/v1"]);
  });
  it("handles an empty repo", () => {
    const { refs, head } = parseRefAdvertisement(refAdvertisement({}, null));
    expect(refs.size).toBe(0);
    expect(head).toBeNull();
  });
});

describe("tap", () => {
  it("forwards every byte unchanged and stops calling back once told to", async () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536)); // 64 KiB cap per call
    let calls = 0, ended = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks(bytes, [1, 999, 4096])) c.enqueue(ch); c.close(); },
    });
    const out = source.pipeThrough(tap(() => ++calls >= 3, () => { ended = true; }));
    const got = new Uint8Array(await new Response(out).arrayBuffer());
    expect(got).toEqual(bytes);
    expect(calls).toBe(3);
    expect(ended).toBe(true);
  });
  it("keeps forwarding if the callback throws", async () => {
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("ab")); c.enqueue(enc.encode("cd")); c.close(); } });
    const out = source.pipeThrough(tap(() => { throw new Error("boom"); }));
    expect(await new Response(out).text()).toBe("abcd");
  });
});

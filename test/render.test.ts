import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render/markdown";
import { highlightCode } from "../src/render/highlight";
import { blobHref, decodePath, encodePath, resolveRelative, splitRefPath, treeHref } from "../src/render/paths";

const ctx = { repo: "site", branch: "feature/x", dir: "docs" };

describe("markdown", () => {
  it("escapes raw HTML", () => {
    const out = renderMarkdown("<script>alert(1)</script>\n\n<b>hi</b>", ctx);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
  it("drops javascript: and data: links", () => {
    const out = renderMarkdown("[x](javascript:alert(1)) [y](data:text/html,hi)", ctx);
    expect(out).not.toMatch(/href="(javascript|data):/);
  });
  it("rewrites relative links to blob URLs and keeps absolute ones", () => {
    const out = renderMarkdown("[a](guide.md) [b](../README.md#top) [c](/src/x.ts) [d](https://example.com) [e](#anchor)", ctx);
    expect(out).toContain('href="/site/blob/feature/x/docs/guide.md"');
    expect(out).toContain('href="/site/blob/feature/x/README.md#top"');
    expect(out).toContain('href="/site/blob/feature/x/src/x.ts"');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="#anchor"');
  });
  it("renders images as alt text plus a link, never <img>", () => {
    const out = renderMarkdown("![Logo](img/logo.png)", ctx);
    expect(out).not.toContain("<img");
    expect(out).toContain('href="/site/blob/feature/x/docs/img/logo.png"');
    expect(out).toContain("Logo");
  });
});

describe("highlight", () => {
  it("highlights by extension and escapes unknown types", () => {
    expect(highlightCode("const a = 1;", "a.ts")).toContain("hljs-keyword");
    expect(highlightCode("<b>", "notes.unknownext")).toBe("&lt;b&gt;");
  });
});

describe("paths", () => {
  it("encodes each segment", () => {
    expect(encodePath("docs/my file #1?.md")).toBe("docs/my%20file%20%231%3F.md");
    expect(blobHref("site", "feature/x", "a b.txt")).toBe("/site/blob/feature/x/a%20b.txt");
    expect(treeHref("site", "main")).toBe("/site/tree/main");
    expect(decodePath("docs/%E2%9C%93%20ok")).toBe("docs/✓ ok");
    expect(decodePath("bad%E0%A4%A")).toBeNull();
  });
  it("picks the longest matching branch", () => {
    expect(splitRefPath("feature/x/src/a.ts", ["feature", "feature/x", "main"])).toEqual({ branch: "feature/x", path: "src/a.ts" });
    expect(splitRefPath("main", ["main"])).toEqual({ branch: "main", path: "" });
    expect(splitRefPath("nope/a", ["main"])).toBeNull();
  });
  it("resolves relative paths inside the repo only", () => {
    expect(resolveRelative("docs", "./a.md")).toBe("docs/a.md");
    expect(resolveRelative("docs/x", "../../b.md")).toBe("b.md");
    expect(resolveRelative("docs", "/c.md")).toBe("c.md");
    expect(resolveRelative("", "../../escape.md")).toBeNull();
  });
});

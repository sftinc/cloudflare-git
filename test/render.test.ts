import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/render/markdown";
import { highlightCode } from "../src/render/highlight";
import { blobHref, decodePath, encodePath, imageType, resolveRelative, splitRefPath, treeHref } from "../src/render/paths";
import type { Ref } from "../src/artifacts";

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
    expect(out).toContain('href="/r/site/blob/feature/x/docs/guide.md"');
    expect(out).toContain('href="/r/site/blob/feature/x/README.md#top"');
    expect(out).toContain('href="/r/site/blob/feature/x/src/x.ts"');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="#anchor"');
  });
  it("renders a relative repo image as <img> of the raw file, and everything else as alt text plus a link", () => {
    const out = renderMarkdown("![Logo](img/logo.png) ![Up](../../x.png) ![Ext](https://example.com/a.png) ![Vec](v.svg) ![Doc](notes.txt) ![Frag](a.png#top) ![Q](a.png?raw=true)", ctx);
    expect(out).toContain('<img src="/r/site/blob/feature/x/docs/img/logo.png?raw" alt="Logo">');
    expect(out).toContain('<a class="md-image" href="#">[image: Up]</a>'); // escapes the repo
    expect(out).toContain('<a class="md-image" href="https://example.com/a.png">[image: Ext]</a>');
    expect(out).toContain('<a class="md-image" href="/r/site/blob/feature/x/docs/v.svg">[image: Vec]</a>');
    expect(out).toContain('<a class="md-image" href="/r/site/blob/feature/x/docs/notes.txt">[image: Doc]</a>');
    expect(out).toContain('<img src="/r/site/blob/feature/x/docs/a.png?raw" alt="Frag">'); // the fragment is dropped
    expect(out).toContain("[image: Q]"); // a query string makes it no image type: a link
    expect(out.match(/<img /g)).toHaveLength(2);
  });
  it("aligns table columns with classes, not inline styles (CSP blocks style attributes)", () => {
    const out = renderMarkdown("| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |", ctx);
    expect(out).not.toContain("style=");
    expect(out).toContain('<th class="align-left">a</th>');
    expect(out).toContain('<td class="align-center">2</td>');
    expect(out).toContain('<td class="align-right">3</td>');
  });
});

describe("highlight", () => {
  it("highlights by extension and escapes unknown types", () => {
    expect(highlightCode("const a = 1;", "a.ts")).toContain("hljs-keyword");
    expect(highlightCode("<b>", "notes.unknownext")).toBe("&lt;b&gt;");
  });
});

describe("paths", () => {
  it("knows the image types by extension, case-insensitively", () => {
    expect(imageType("a.png")).toBe("image/png");
    expect(imageType("A.JPG")).toBe("image/jpeg");
    expect(imageType("a.jpeg")).toBe("image/jpeg");
    expect(imageType("dir.x/a.GIF")).toBe("image/gif");
    expect(imageType("a.webp")).toBe("image/webp");
    for (const name of ["a.svg", "png", "a.png.txt", "x.constructor", "x.toString", ""]) expect(imageType(name)).toBeNull();
  });
  it("encodes each segment", () => {
    expect(encodePath("docs/my file #1?.md")).toBe("docs/my%20file%20%231%3F.md");
    expect(blobHref("site", "feature/x", "a b.txt")).toBe("/r/site/blob/feature/x/a%20b.txt");
    expect(treeHref("site", "main")).toBe("/r/site/tree/main");
    expect(decodePath("docs/%E2%9C%93%20ok")).toBe("docs/✓ ok");
    expect(decodePath("bad%E0%A4%A")).toBeNull();
  });
  it("picks the longest matching ref, and a branch over a tag of the same name", () => {
    const sha = "a".repeat(40);
    const b = (name: string): Ref => ({ name, kind: "branch", sha });
    const t = (name: string): Ref => ({ name, kind: "tag", sha });
    const refs = [b("feature"), b("feature/x"), b("main"), t("main"), t("rel/1.0")]; // branches first, as the routes pass them
    expect(splitRefPath("feature/x/src/a.ts", refs)).toEqual({ ref: refs[1], path: "src/a.ts" });
    expect(splitRefPath("main", refs)).toEqual({ ref: refs[2], path: "" });
    expect(splitRefPath("rel/1.0/docs/", refs)).toEqual({ ref: refs[4], path: "docs" });
    expect(splitRefPath("nope/a", refs)).toBeNull();
  });
  it("resolves relative paths inside the repo only", () => {
    expect(resolveRelative("docs", "./a.md")).toBe("docs/a.md");
    expect(resolveRelative("docs/x", "../../b.md")).toBe("b.md");
    expect(resolveRelative("docs", "/c.md")).toBe("c.md");
    expect(resolveRelative("", "../../escape.md")).toBeNull();
  });
});

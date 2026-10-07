import MarkdownIt from "markdown-it";
import { blobHref, imageType, resolveRelative } from "./paths";

export type MdContext = { repo: string; branch: string; dir: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const md = new MarkdownIt({ html: false, linkify: true });

md.validateLink = (url) => {
  const u = url.trim().toLowerCase();
  return !SCHEME.test(u) || /^(https?|mailto):/.test(u);
};

// markdown-it aligns table cells with style="text-align:…", which the CSP blocks; use classes instead.
md.core.ruler.push("align_classes", (state) => {
  for (const t of state.tokens) {
    if (t.type !== "th_open" && t.type !== "td_open") continue;
    const m = /^text-align:(left|center|right)$/.exec(String(t.attrGet("style")));
    if (!m) continue;
    t.attrs = t.attrs!.filter(([k]) => k !== "style");
    t.attrJoin("class", `align-${m[1]}`);
  }
});

function rewrite(href: string, ctx: MdContext): string {
  if (SCHEME.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const hashAt = href.indexOf("#");
  const pathPart = hashAt < 0 ? href : href.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  let decoded: string;
  try {
    decoded = decodeURI(pathPart);
  } catch {
    return "#";
  }
  const resolved = resolveRelative(ctx.dir, decoded);
  return resolved === null || resolved === "" ? "#" : blobHref(ctx.repo, ctx.branch, resolved) + hash;
}

md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const href = t.attrGet("href")?.toString();
  if (href) {
    t.attrSet("href", rewrite(href, env as MdContext));
    if (/^https?:/i.test(href)) t.attrSet("rel", "nofollow noopener");
  }
  return self.renderToken(tokens, idx, opts);
};

// A relative image that resolves inside the repo becomes an <img> of its raw file (same origin, so private repos work);
// anything else (external, SVG, escaping path, other types) is alt text plus a link.
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const ctx = env as MdContext;
  const alt = self.renderInlineAsText(t.children ?? [], opts, env) || "image";
  const href = rewrite(String(t.attrGet("src") ?? ""), ctx);
  const file = href.split("#")[0];
  if (file.startsWith(blobHref(ctx.repo, ctx.branch, "")) && imageType(file)) {
    return `<img src="${md.utils.escapeHtml(file)}?raw" alt="${md.utils.escapeHtml(alt)}">`;
  }
  return `<a class="md-image" href="${md.utils.escapeHtml(href)}">[image: ${md.utils.escapeHtml(alt)}]</a>`;
};

export function renderMarkdown(src: string, ctx: MdContext): string {
  return md.render(src, ctx);
}

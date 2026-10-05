export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function decodePath(raw: string): string | null {
  try {
    return raw.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

/** Branch names may contain "/", so the longest known branch that prefixes the path wins. */
export function splitRefPath(rest: string, branches: string[]): { branch: string; path: string } | null {
  for (const b of [...branches].sort((x, y) => y.length - x.length)) {
    if (rest === b) return { branch: b, path: "" };
    if (rest.startsWith(`${b}/`)) return { branch: b, path: rest.slice(b.length + 1).replace(/\/+$/, "") };
  }
  return null;
}

/** Resolves a markdown link target against a directory; null if it escapes the repo root. */
export function resolveRelative(dir: string, target: string): string | null {
  const parts = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Every repo lives under /r/, so repo names never collide with app routes. */
export const repoHref = (repo: string) => `/r/${repo}`;
export const cloneUrl = (origin: string, repo: string) => `${origin}/r/${repo}.git`;
export const treeHref = (repo: string, branch: string, path = "") =>
  `${repoHref(repo)}/tree/${encodePath(branch)}${path ? `/${encodePath(path)}` : ""}`;
export const blobHref = (repo: string, branch: string, path: string) => `${repoHref(repo)}/blob/${encodePath(branch)}/${encodePath(path)}`;
export const commitsHref = (repo: string, branch: string) => `${repoHref(repo)}/commits/${encodePath(branch)}`;

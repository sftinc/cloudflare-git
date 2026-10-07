import type { Ref } from "../artifacts";
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

/** Ref names may contain "/", so the longest known ref that prefixes the path wins. `refs` lists branches before tags, so on an identical name the (stable) sort keeps the branch first. */
export function splitRefPath(rest: string, refs: Ref[]): { ref: Ref; path: string } | null {
  for (const r of [...refs].sort((x, y) => y.name.length - x.name.length)) {
    if (rest === r.name) return { ref: r, path: "" };
    if (rest.startsWith(`${r.name}/`)) return { ref: r, path: rest.slice(r.name.length + 1).replace(/\/+$/, "") };
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
/**
 * Saves a password for this host in git's credential store (Keychain on macOS, Git Credential Manager on Windows).
 * One line that runs the same in zsh, bash, PowerShell and cmd; no space before "|" or cmd adds it to the password.
 */
export function gitLoginCommand(origin: string, password: string) {
  const u = new URL(origin);
  return `echo url=${u.protocol}//x:${password}@${u.host}|git credential approve`;
}
export const treeHref = (repo: string, branch: string, path = "") =>
  `${repoHref(repo)}/tree/${encodePath(branch)}${path ? `/${encodePath(path)}` : ""}`;
export const blobHref = (repo: string, branch: string, path: string) => `${repoHref(repo)}/blob/${encodePath(branch)}/${encodePath(path)}`;
export const commitsHref = (repo: string, branch: string) => `${repoHref(repo)}/commits/${encodePath(branch)}`;

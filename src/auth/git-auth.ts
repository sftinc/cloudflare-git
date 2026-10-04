import { sha256Hex } from "../lib/crypto";
import { inviteCoversRepoByPassword } from "../db/invites";
import type { RepoRow } from "../db/repos";
import { findValidPushTokenId } from "../db/tokens";

export type GitDecision = { kind: "allow"; pushTokenId?: string } | { kind: "unauthorized" } | { kind: "notfound" };

export function basicPassword(header: string | undefined): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(":");
    return colon >= 0 && colon < decoded.length - 1 ? decoded.slice(colon + 1) : null;
  } catch {
    return null;
  }
}

/**
 * Spec §4. No credentials → 401 for any name; wrong credentials or no access → 404,
 * except a failed push to a public repo → 401, so git drops the bad stored credential
 * (the repo's existence is public anyway).
 */
export async function decideGitAccess(
  db: D1Database,
  repo: RepoRow | null,
  password: string | null,
  op: "fetch" | "push",
  now: number,
): Promise<GitDecision> {
  if (op === "fetch" && repo && repo.public_at !== null) return { kind: "allow" };
  if (!password) return { kind: "unauthorized" };
  if (!repo) return { kind: "notfound" };
  const hash = await sha256Hex(password);
  const tokenId = await findValidPushTokenId(db, hash, repo.id);
  if (tokenId) return { kind: "allow", pushTokenId: tokenId };
  if (op === "fetch" && (await inviteCoversRepoByPassword(db, hash, repo.id, now))) return { kind: "allow" };
  return repo.public_at !== null ? { kind: "unauthorized" } : { kind: "notfound" };
}

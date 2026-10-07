import { sha256Hex } from "../lib/crypto";
import { inviteCoversRepoByPassword, isValidInvitePassword } from "../db/invites";
import type { RepoRow } from "../db/repos";
import { findValidPushTokenId, isValidPushToken } from "../db/tokens";

export type GitDecision = { kind: "allow"; pushTokenId?: string } | { kind: "unauthorized" } | { kind: "forbidden" } | { kind: "notfound" };

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
 * Spec §7. git erases a saved password only on a 401, so a credential that is not valid anywhere
 * gets 401. A valid one without access to this repo (or with no such repo) gets 404; neither answer
 * depends on whether the repo exists. An invite password pushing to a repo it covers gets 403.
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
  const hash = await sha256Hex(password);
  if (repo) {
    const tokenId = await findValidPushTokenId(db, hash, repo.id, now);
    if (tokenId) return { kind: "allow", pushTokenId: tokenId };
    if (await inviteCoversRepoByPassword(db, hash, repo.id, now)) return op === "fetch" ? { kind: "allow" } : { kind: "forbidden" };
  }
  const valid = (await isValidPushToken(db, hash, now)) || (await isValidInvitePassword(db, hash, now));
  return valid ? { kind: "notfound" } : { kind: "unauthorized" };
}

import { uuidv7 } from "../lib/ids";

export type PushTokenRow = {
  id: string;
  name: string;
  token_hash: string;
  expires_at: number | null;
  all_repos_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  deleted_at: number | null;
};

export async function createPushToken(db: D1Database, t: { name: string; tokenHash: string; repoIds: string[]; allRepos?: boolean; expiresAt?: number | null }, now: number) {
  const id = uuidv7(now);
  await db.batch([
    db.prepare("INSERT INTO push_tokens (id, name, token_hash, created_at, updated_at, expires_at, all_repos_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, t.name, t.tokenHash, now, now, t.expiresAt ?? null, t.allRepos ? now : null),
    ...(t.allRepos ? [] : t.repoIds).map((repoId) =>
      db.prepare("INSERT INTO push_token_repos (push_token_id, repo_id, created_at) VALUES (?, ?, ?)").bind(id, repoId, now),
    ),
  ]);
  return id;
}

export async function findValidPushTokenId(db: D1Database, tokenHash: string, repoId: string, now: number) {
  const row = await db
    .prepare(
      `SELECT t.id FROM push_tokens t
       WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND t.deleted_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?3)
         AND (t.all_repos_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM push_token_repos r WHERE r.push_token_id = t.id AND r.repo_id = ?2 AND r.deleted_at IS NULL))`,
    )
    .bind(tokenHash, repoId, now)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function touchPushToken(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE push_tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

export async function listPushTokens(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT t.*, group_concat(rp.name, ', ') AS repo_names FROM push_tokens t
       LEFT JOIN push_token_repos r ON r.push_token_id = t.id AND r.deleted_at IS NULL
       LEFT JOIN repos rp ON rp.id = r.repo_id
       WHERE t.deleted_at IS NULL GROUP BY t.id ORDER BY t.created_at DESC`,
    )
    .all<PushTokenRow & { repo_names: string | null }>();
  return results;
}

export async function revokePushToken(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE push_tokens SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2 AND revoked_at IS NULL").bind(now, id).run();
}

export async function deletePushToken(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE push_tokens SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now, id).run();
}

/** A token that is not revoked, deleted or expired, whatever repos it covers. */
export async function isValidPushToken(db: D1Database, tokenHash: string, now: number) {
  const row = await db
    .prepare("SELECT 1 AS ok FROM push_tokens WHERE token_hash = ?1 AND revoked_at IS NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)")
    .bind(tokenHash, now)
    .first();
  return row !== null;
}

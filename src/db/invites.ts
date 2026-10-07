import { uuidv7 } from "../lib/ids";
import type { RepoRow } from "./repos";

export type InviteRow = {
  id: string;
  label: string;
  code_hash: string;
  clone_password_hash: string | null;
  access_ms: number | null;
  redeem_by_at: number;
  all_repos_at: number | null;
  created_at: number;
  updated_at: number;
  redeemed_at: number | null;
  access_expires_at: number | null;
  revoked_at: number | null;
  deleted_at: number | null;
};

const VALID = `i.deleted_at IS NULL AND i.revoked_at IS NULL AND i.redeemed_at IS NOT NULL
  AND (i.access_expires_at IS NULL OR i.access_expires_at > ?)`;
/** Invite i covers repo r: it was made for all repos, or it lists r. */
const COVERS = `(i.all_repos_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM invite_repos ir WHERE ir.invite_id = i.id AND ir.repo_id = r.id AND ir.deleted_at IS NULL))`;

export async function createInvite(
  db: D1Database,
  inv: { label: string; codeHash: string; accessMs: number | null; redeemByAt: number; repoIds: string[]; allRepos?: boolean },
  now: number,
) {
  const id = uuidv7(now);
  await db.batch([
    db
      .prepare("INSERT INTO invites (id, label, code_hash, access_ms, redeem_by_at, created_at, updated_at, all_repos_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, inv.label, inv.codeHash, inv.accessMs, inv.redeemByAt, now, now, inv.allRepos ? now : null),
    ...(inv.allRepos ? [] : inv.repoIds).map((repoId) =>
      db.prepare("INSERT INTO invite_repos (invite_id, repo_id, created_at) VALUES (?, ?, ?)").bind(id, repoId, now),
    ),
  ]);
  return id;
}

export function findInviteByCodeHash(db: D1Database, hash: string) {
  return db.prepare("SELECT * FROM invites WHERE code_hash = ? AND deleted_at IS NULL").bind(hash).first<InviteRow>();
}

export function isRedeemable(inv: InviteRow, now: number) {
  return inv.redeemed_at === null && inv.revoked_at === null && inv.deleted_at === null && now < inv.redeem_by_at;
}

/** Single conditional update, so two simultaneous redemptions cannot both succeed. */
export async function redeemInvite(db: D1Database, id: string, clonePasswordHash: string, now: number) {
  const res = await db
    .prepare(
      `UPDATE invites SET redeemed_at = ?1,
         access_expires_at = CASE WHEN access_ms IS NULL THEN NULL ELSE ?1 + access_ms END,
         clone_password_hash = ?2, updated_at = ?1
       WHERE id = ?3 AND redeemed_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL AND redeem_by_at > ?1`,
    )
    .bind(now, clonePasswordHash, id)
    .run();
  return res.meta.changes === 1;
}

export async function reposForInvite(db: D1Database, inviteId: string) {
  const { results } = await db
    .prepare(
      `SELECT r.* FROM repos r JOIN invites i ON i.id = ?
       WHERE r.deleted_at IS NULL AND r.provisioned_at IS NOT NULL AND ${COVERS}
       ORDER BY r.name`,
    )
    .bind(inviteId)
    .all<RepoRow>();
  return results;
}

export async function coveredRepoIds(db: D1Database, inviteIds: string[], now: number) {
  if (inviteIds.length === 0) return new Set<string>();
  const marks = inviteIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT DISTINCT r.id AS repo_id FROM repos r JOIN invites i ON i.id IN (${marks}) WHERE ${VALID} AND ${COVERS}`)
    .bind(...inviteIds, now)
    .all<{ repo_id: string }>();
  return new Set(results.map((r) => r.repo_id));
}

export async function inviteCoversRepoByPassword(db: D1Database, passwordHash: string, repoId: string, now: number) {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM invites i JOIN repos r ON r.id = ? WHERE i.clone_password_hash = ? AND ${VALID} AND ${COVERS}`)
    .bind(repoId, passwordHash, now)
    .first();
  return row !== null;
}

/** A redeemed invite's clone password that is not revoked, deleted or expired, whatever repos it covers. */
export async function isValidInvitePassword(db: D1Database, passwordHash: string, now: number) {
  const row = await db.prepare(`SELECT 1 AS ok FROM invites i WHERE i.clone_password_hash = ? AND ${VALID}`).bind(passwordHash, now).first();
  return row !== null;
}

export async function listInvites(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT i.*, COALESCE(group_concat(r.name, ', '), '') AS repo_names FROM invites i
       LEFT JOIN invite_repos ir ON ir.invite_id = i.id AND ir.deleted_at IS NULL
       LEFT JOIN repos r ON r.id = ir.repo_id
       WHERE i.deleted_at IS NULL GROUP BY i.id ORDER BY i.created_at DESC`,
    )
    .all<InviteRow & { repo_names: string }>();
  return results;
}

/** Revoking twice keeps the first time. False if the invite doesn't exist or is deleted. */
export async function revokeInvite(db: D1Database, id: string, now: number) {
  const res = await db
    .prepare("UPDATE invites SET revoked_at = COALESCE(revoked_at, ?1), updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL")
    .bind(now, id)
    .run();
  return res.meta.changes > 0;
}

export async function deleteInvite(db: D1Database, id: string, now: number) {
  const res = await db.prepare("UPDATE invites SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL").bind(now, id).run();
  return res.meta.changes > 0;
}

export function inviteStatus(inv: InviteRow, now: number): "waiting" | "active" | "expired" | "revoked" {
  if (inv.revoked_at !== null) return "revoked";
  if (inv.redeemed_at === null) return inv.redeem_by_at > now ? "waiting" : "expired";
  return inv.access_expires_at === null || inv.access_expires_at > now ? "active" : "expired";
}

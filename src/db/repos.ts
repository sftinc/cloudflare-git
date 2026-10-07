import { uuidv7 } from "../lib/ids";

export type RepoRow = {
  id: string;
  name: string;
  storage_name: string;
  description: string | null;
  public_at: number | null;
  created_at: number;
  updated_at: number;
  provisioned_at: number | null;
  deleted_at: number | null;
};

// New repos keep their files under their id, so no name collides with storage. If Artifacts rejected UUIDs: `r${id.replaceAll("-", "")}`.
const storageNameFor = (id: string) => id;

export function findRepoByName(db: D1Database, name: string) {
  return db.prepare("SELECT * FROM repos WHERE name = ?").bind(name).first<RepoRow>();
}

export function findRepoById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM repos WHERE id = ?").bind(id).first<RepoRow>();
}

export function findLiveRepo(db: D1Database, name: string) {
  return db
    .prepare("SELECT * FROM repos WHERE name = ? AND deleted_at IS NULL AND provisioned_at IS NOT NULL")
    .bind(name)
    .first<RepoRow>();
}

/** The live repo that a live alias (a name the repo gave up in a rename) points at. */
export function findLiveAlias(db: D1Database, name: string) {
  return db
    .prepare(
      `SELECT r.* FROM repo_aliases a JOIN repos r ON r.id = a.repo_id
       WHERE a.name = ? AND a.deleted_at IS NULL AND r.deleted_at IS NULL AND r.provisioned_at IS NOT NULL`,
    )
    .bind(name)
    .first<RepoRow>();
}

/** The live alias with this name, whatever state its repo is in, and that repo's current name. */
export function findAlias(db: D1Database, name: string) {
  return db
    .prepare("SELECT a.repo_id, r.name AS repo_name FROM repo_aliases a JOIN repos r ON r.id = a.repo_id WHERE a.name = ? AND a.deleted_at IS NULL")
    .bind(name)
    .first<{ repo_id: string; repo_name: string }>();
}

export async function listLiveRepos(db: D1Database) {
  const { results } = await db
    .prepare("SELECT * FROM repos WHERE deleted_at IS NULL AND provisioned_at IS NOT NULL ORDER BY name")
    .all<RepoRow>();
  return results;
}

/** Every repo except never-created rows that were given up (retired). */
export async function listReposForAdmin(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM repos WHERE deleted_at IS NULL OR provisioned_at IS NOT NULL ORDER BY name").all<RepoRow>();
  return results;
}

/** With takeAliasFrom, the same batch releases that repo's old name r.name, if it still holds it. */
export async function insertRepo(db: D1Database, r: { name: string; description: string | null }, now: number, takeAliasFrom: string | null = null) {
  const id = uuidv7(now);
  const row: RepoRow = { id, name: r.name, storage_name: storageNameFor(id), description: r.description, public_at: null, provisioned_at: null, created_at: now, updated_at: now, deleted_at: null };
  await db.batch([
    ...(takeAliasFrom
      ? [db.prepare("UPDATE repo_aliases SET deleted_at = ?1 WHERE name = ?2 AND repo_id = ?3 AND deleted_at IS NULL").bind(now, r.name, takeAliasFrom)]
      : []),
    db
      .prepare("INSERT INTO repos (id, name, storage_name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.name, row.storage_name, row.description, now, now),
  ]);
  return row;
}

/** A retired row (deleted while never created) is never marked provisioned. */
export async function markProvisioned(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE repos SET provisioned_at = ?1, updated_at = ?1 WHERE id = ?2 AND provisioned_at IS NULL AND deleted_at IS NULL").bind(now, id).run();
}

/** Gives a never-created row's name back: '~<id>' can't be typed, so it can't collide. Returns whether it retired the row. */
export async function retireRepo(db: D1Database, id: string, now: number) {
  const res = await db
    .prepare("UPDATE repos SET name = '~' || id, deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND provisioned_at IS NULL AND deleted_at IS NULL")
    .bind(now, id)
    .run();
  return res.meta.changes > 0;
}

export async function setPublic(db: D1Database, id: string, isPublic: boolean, now: number) {
  await db.prepare("UPDATE repos SET public_at = ?1, updated_at = ?2 WHERE id = ?3").bind(isPublic ? now : null, now, id).run();
}

export async function setDescription(db: D1Database, id: string, description: string | null, now: number) {
  await db.prepare("UPDATE repos SET description = ?1, updated_at = ?2 WHERE id = ?3").bind(description, now, id).run();
}

export async function setDeleted(db: D1Database, id: string, deleted: boolean, now: number) {
  await db.prepare("UPDATE repos SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3").bind(deleted ? now : null, now, id).run();
}

/**
 * Renames a repo and keeps its old name as an alias. Every statement is guarded by the repo's
 * current state, so a stale request or a racing delete changes nothing. The new name may be one of
 * this repo's own old names, or one of takeAliasFrom's; any other repo's live old name blocks it.
 * Returns whether it renamed. Throws if another repo took the name meanwhile (unique index); D1 rolls the batch back.
 */
export async function renameRepo(db: D1Database, id: string, newName: string, now: number, takeAliasFrom: string | null = null) {
  const current = "id = ?1 AND deleted_at IS NULL AND provisioned_at IS NOT NULL AND name <> ?2";
  const eligible = `${current} AND NOT EXISTS (SELECT 1 FROM repo_aliases WHERE name = ?2 AND deleted_at IS NULL)`;
  const [, , renamed] = await db.batch([
    db
      .prepare(`UPDATE repo_aliases SET deleted_at = ?3 WHERE name = ?2 AND deleted_at IS NULL AND repo_id IN (?1, ?4) AND EXISTS (SELECT 1 FROM repos WHERE ${current})`)
      .bind(id, newName, now, takeAliasFrom),
    db
      .prepare(`INSERT INTO repo_aliases (id, repo_id, name, created_at) SELECT ?4, id, name, ?3 FROM repos WHERE ${eligible}`)
      .bind(id, newName, now, uuidv7(now)),
    db.prepare(`UPDATE repos SET name = ?2, updated_at = ?3 WHERE ${eligible}`).bind(id, newName, now),
  ]);
  return renamed.meta.changes > 0;
}

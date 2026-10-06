import { uuidv7 } from "../lib/ids";

export type RepoRow = {
  id: string;
  name: string;
  description: string | null;
  public_at: number | null;
  created_at: number;
  updated_at: number;
  provisioned_at: number | null;
  deleted_at: number | null;
};

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

export async function listLiveRepos(db: D1Database) {
  const { results } = await db
    .prepare("SELECT * FROM repos WHERE deleted_at IS NULL AND provisioned_at IS NOT NULL ORDER BY name")
    .all<RepoRow>();
  return results;
}

export async function listReposForAdmin(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM repos ORDER BY name").all<RepoRow>();
  return results;
}

export async function insertRepo(db: D1Database, r: { name: string; description: string | null }, now: number) {
  const row: RepoRow = { id: uuidv7(now), name: r.name, description: r.description, public_at: null, provisioned_at: null, created_at: now, updated_at: now, deleted_at: null };
  await db
    .prepare("INSERT INTO repos (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.name, row.description, now, now)
    .run();
  return row;
}

export async function markProvisioned(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE repos SET provisioned_at = ?1, updated_at = ?1 WHERE id = ?2 AND provisioned_at IS NULL").bind(now, id).run();
}

export async function setPublic(db: D1Database, id: string, isPublic: boolean, now: number) {
  await db.prepare("UPDATE repos SET public_at = ?1, updated_at = ?2 WHERE id = ?3").bind(isPublic ? now : null, now, id).run();
}

export async function setDeleted(db: D1Database, id: string, deleted: boolean, now: number) {
  await db.prepare("UPDATE repos SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3").bind(deleted ? now : null, now, id).run();
}

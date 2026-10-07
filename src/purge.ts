import { artifactsErrorCode } from "./artifacts";

export const DAY_MS = 86_400_000;

/** Spec §2: RESTORE_DAYS as whole days, 0 or more. Missing or anything else ("abc", "-1", "1.5") means 30. */
export function restoreDays(env: { RESTORE_DAYS?: string }) {
  const v = env.RESTORE_DAYS;
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : 30;
}

/**
 * Spec §2: deletes the storage of repos deleted more than `days` days + 24 hours ago, at most 50
 * per run, oldest first, then marks them purged and frees their names, aliases and grants. Storage
 * already gone counts as done; any other error leaves the row for the next run. Returns how many it purged.
 */
export async function purgeDeletedRepos(db: D1Database, art: Artifacts, days: number, now: number) {
  const { results } = await db
    .prepare("SELECT id, storage_name FROM repos WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND purged_at IS NULL ORDER BY deleted_at LIMIT 50")
    .bind(now - (days + 1) * DAY_MS)
    .all<{ id: string; storage_name: string }>();
  let count = 0;
  for (const r of results) {
    try {
      await art.delete(r.storage_name); // false: already gone
    } catch (err) {
      const code = artifactsErrorCode(err);
      if (code !== "NOT_FOUND") {
        console.error(JSON.stringify({ msg: "purge failed", repo: r.id, code }));
        continue;
      }
    }
    // Every statement checks the repo is still deleted and unpurged; the repo update goes last so the
    // earlier checks still see it unpurged. A repo restored meanwhile is left alone.
    const eligible = "EXISTS (SELECT 1 FROM repos WHERE id = ?1 AND deleted_at IS NOT NULL AND purged_at IS NULL)";
    let repo;
    try {
      [, , , repo] = await db.batch([
        db.prepare(`UPDATE repo_aliases SET deleted_at = ?2 WHERE repo_id = ?1 AND deleted_at IS NULL AND ${eligible}`).bind(r.id, now),
        db.prepare(`UPDATE invite_repos SET deleted_at = ?2 WHERE repo_id = ?1 AND deleted_at IS NULL AND ${eligible}`).bind(r.id, now),
        db.prepare(`UPDATE push_token_repos SET deleted_at = ?2 WHERE repo_id = ?1 AND deleted_at IS NULL AND ${eligible}`).bind(r.id, now),
        db.prepare("UPDATE repos SET purged_at = ?2, name = '~' || id WHERE id = ?1 AND deleted_at IS NOT NULL AND purged_at IS NULL").bind(r.id, now),
      ]);
    } catch (err) {
      console.error(JSON.stringify({ msg: "purge failed", repo: r.id, code: "D1", error: String(err) }));
      continue; // the row stays unpurged; the next run retries it
    }
    if (repo.meta.changes > 0) count++;
  }
  if (count > 0) console.log(JSON.stringify({ msg: "purged", count }));
  return count;
}

import { uuidv7 } from "../lib/ids";

export type WebhookRow = {
  id: string;
  repo_id: string;
  url: string;
  branch: string | null;
  secret: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export async function createWebhook(db: D1Database, w: { repoId: string; url: string; branch: string | null; secret: string }, now: number) {
  const id = uuidv7(now);
  await db
    .prepare("INSERT INTO webhooks (id, repo_id, url, branch, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, w.repoId, w.url, w.branch, w.secret, now, now)
    .run();
  return id;
}

export async function listWebhooks(db: D1Database, repoId: string) {
  const { results } = await db
    .prepare("SELECT * FROM webhooks WHERE repo_id = ? AND deleted_at IS NULL ORDER BY created_at")
    .bind(repoId)
    .all<WebhookRow>();
  return results;
}

export async function matchingWebhooks(db: D1Database, repoId: string, branch: string) {
  const { results } = await db
    .prepare("SELECT * FROM webhooks WHERE repo_id = ? AND deleted_at IS NULL AND (branch IS NULL OR branch = ?)")
    .bind(repoId, branch)
    .all<WebhookRow>();
  return results;
}

export async function deleteWebhook(db: D1Database, id: string, now: number) {
  await db.prepare("UPDATE webhooks SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2").bind(now, id).run();
}

import { ZERO_SHA, type RefCommand, type RefResult } from "./git/pktline";
import { hmacHex } from "./lib/crypto";
import { uuidv7 } from "./lib/ids";
import type { RepoRow } from "./db/repos";
import { matchingWebhooks, type WebhookRow } from "./db/webhooks";

export type PushEvent = { repo: string; branch: string; before: string; after: string; deleted: boolean; pushed_at: number };

export function pushEventsFrom(repo: string, commands: RefCommand[], results: RefResult[], now: number): PushEvent[] {
  const accepted = new Set(results.filter((r) => r.ok).map((r) => r.ref));
  return commands
    .filter((c) => c.ref.startsWith("refs/heads/") && accepted.has(c.ref))
    .map((c) => ({
      repo,
      branch: c.ref.slice("refs/heads/".length),
      before: c.oldSha,
      after: c.newSha,
      deleted: c.newSha === ZERO_SHA,
      pushed_at: now,
    }));
}

export async function signature(secret: string, body: string) {
  return `sha256=${await hmacHex(secret, body)}`;
}

async function deliverOne(hook: WebhookRow, event: PushEvent) {
  const body = JSON.stringify(event);
  const started = Date.now();
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature-256": await signature(hook.secret, body), "X-Delivery-Id": uuidv7() },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    console.log(JSON.stringify({ msg: "webhook delivered", webhook: hook.id, url: hook.url, status: res.status, ms: Date.now() - started }));
  } catch (err) {
    console.warn(JSON.stringify({ msg: "webhook failed", webhook: hook.id, url: hook.url, error: String(err), ms: Date.now() - started }));
  }
}

/** No retries (spec §8); failures are logged and never affect the push. */
export async function deliverWebhooks(db: D1Database, repo: RepoRow, events: PushEvent[]) {
  await Promise.all(
    events.map(async (event) => {
      const hooks = await matchingWebhooks(db, repo.id, event.branch);
      await Promise.all(hooks.map((h) => deliverOne(h, event)));
    }),
  );
}

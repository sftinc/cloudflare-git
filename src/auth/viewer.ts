import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../index";
import { verifyAccessJwt } from "./access-jwt";
import { readInviteIds } from "./invite-cookie";
import { coveredRepoIds } from "../db/invites";
import { listLiveRepos, type RepoRow } from "../db/repos";

export type Viewer = { owner: boolean; inviteIds: string[] };

export async function isOwnerRequest(c: Context<AppEnv>): Promise<boolean> {
  const token = c.req.header("cf-access-jwt-assertion") ?? getCookie(c, "CF_Authorization");
  if (!token) return false;
  try {
    return await verifyAccessJwt(token, c.env);
  } catch (err) {
    console.warn(JSON.stringify({ msg: "access verify failed", error: String(err) }));
    return false;
  }
}

export async function getViewer(c: Context<AppEnv>): Promise<Viewer> {
  return { owner: await isOwnerRequest(c), inviteIds: await readInviteIds(c) };
}

export async function canView(db: D1Database, viewer: Viewer, repo: RepoRow, now: number) {
  if (repo.public_at !== null || viewer.owner) return true;
  return (await coveredRepoIds(db, viewer.inviteIds, now)).has(repo.id);
}

export async function visibleRepos(db: D1Database, viewer: Viewer, now: number) {
  const all = await listLiveRepos(db);
  if (viewer.owner) return all;
  const covered = await coveredRepoIds(db, viewer.inviteIds, now);
  return all.filter((r) => r.public_at !== null || covered.has(r.id));
}

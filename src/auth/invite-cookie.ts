import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../index";
import { hmacHex, timingSafeEqual } from "../lib/crypto";

export const INVITE_COOKIE = "cg_invites";
const MAX_IDS = 50;

/** Invite ids from a correctly signed cookie; anything else is treated as none. */
export async function readInviteIds(c: Context<AppEnv>): Promise<string[]> {
  const raw = getCookie(c, INVITE_COOKIE);
  if (!raw) return [];
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return [];
  const ids = raw.slice(0, dot);
  const expected = await hmacHex(c.env.COOKIE_SECRET, ids);
  if (!timingSafeEqual(raw.slice(dot + 1), expected)) return [];
  return ids.split(",").filter(Boolean).slice(0, MAX_IDS);
}

export async function writeInviteIds(c: Context<AppEnv>, ids: string[]) {
  const value = ids.slice(-MAX_IDS).join(",");
  setCookie(c, INVITE_COOKIE, `${value}.${await hmacHex(c.env.COOKIE_SECRET, value)}`, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 400 * 24 * 60 * 60,
  });
}

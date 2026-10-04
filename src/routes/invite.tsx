import { Hono } from "hono";
import type { AppEnv } from "../index";
import { readInviteIds, writeInviteIds } from "../auth/invite-cookie";
import { findInviteByCodeHash, isRedeemable, redeemInvite, reposForInvite } from "../db/invites";
import { randomSecret, sha256Hex } from "../lib/crypto";
import { page } from "../views/layout";
import { InviteInvalid } from "../views/errors";
import { InviteAccepted, InviteConfirm, cloneUrlWithPassword } from "../views/invite";

export const inviteRoutes = new Hono<AppEnv>();

inviteRoutes.get("/:code", async (c) => {
  const inv = await findInviteByCodeHash(c.env.DB, await sha256Hex(c.req.param("code")));
  if (!inv || !isRedeemable(inv, Date.now())) return page(c, "Invite not valid", <InviteInvalid />, 404);
  const repos = await reposForInvite(c.env.DB, inv.id);
  return page(c, "You're invited", <InviteConfirm label={inv.label} repos={repos} accessMs={inv.access_ms} action={`/invite/${encodeURIComponent(c.req.param("code"))}`} />);
});

// POST redeems, so link previews in chat apps can't use up the invite.
inviteRoutes.post("/:code", async (c) => {
  if (c.req.header("origin") !== c.env.SITE_ORIGIN) return c.text("Forbidden", 403);
  const now = Date.now();
  const inv = await findInviteByCodeHash(c.env.DB, await sha256Hex(c.req.param("code")));
  const password = randomSecret();
  if (!inv || !isRedeemable(inv, now) || !(await redeemInvite(c.env.DB, inv.id, await sha256Hex(password), now))) {
    return page(c, "Invite not valid", <InviteInvalid />, 404);
  }
  await writeInviteIds(c, [...new Set([...(await readInviteIds(c)), inv.id])]);
  const repos = await reposForInvite(c.env.DB, inv.id);
  const urls = Object.fromEntries(repos.map((r) => [r.name, cloneUrlWithPassword(c.env.SITE_ORIGIN, r.name, password)]));
  return page(c, "Invite accepted", <InviteAccepted repos={repos} urls={urls} />);
});

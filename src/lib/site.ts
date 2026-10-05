import type { Context } from "hono";
import type { AppEnv } from "../index";

/** SITE_ORIGIN when set, else the origin the request came in on. */
export const siteOrigin = (c: Context<AppEnv>) => c.env.SITE_ORIGIN || new URL(c.req.url).origin;

/** Access is configured only when both vars are set; without it nobody can log in. */
export const accessConfigured = (env: Env) => !!env.ACCESS_TEAM_DOMAIN && !!env.ACCESS_AUD;

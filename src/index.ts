import { Hono } from "hono";
import { inviteRoutes } from "./routes/invite";
import { gitRoutes } from "./routes/git";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";
import { handleError, notFoundPage } from "./routes/errors";

export type AppEnv = { Bindings: Env };

/** LOGO_URL's origin when it is an https URL on another host, so the CSP lets it load. */
function logoOrigin(env: Env) {
  if (!env.LOGO_URL || !URL.canParse(env.LOGO_URL)) return "";
  const u = new URL(env.LOGO_URL);
  return u.protocol === "https:" ? ` ${u.origin}` : "";
}

const csp = (env: Env) =>
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'${logoOrigin(env)}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    c.res.headers.set("Content-Security-Policy", csp(c.env));
    c.res.headers.set("X-Frame-Options", "DENY");
  }
});

app.route("/", gitRoutes);
app.route("/admin", adminRoutes);
app.route("/invite", inviteRoutes);
app.route("/", publicRoutes);
app.notFound(notFoundPage);
app.onError(handleError);

export default app;

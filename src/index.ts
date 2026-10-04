import { Hono } from "hono";
import { gitRoutes } from "./routes/git";
import { publicRoutes } from "./routes/public";
import { handleError, notFoundPage } from "./routes/errors";

export type AppEnv = { Bindings: Env };

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    c.res.headers.set("Content-Security-Policy", CSP);
    c.res.headers.set("X-Frame-Options", "DENY");
  }
});

app.route("/", gitRoutes);
// Task 11: app.route("/admin", adminRoutes);
// Task 10: app.route("/invite", inviteRoutes);
app.route("/", publicRoutes);
app.notFound(notFoundPage);
app.onError(handleError);

export default app;

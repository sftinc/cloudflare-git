import { Hono } from "hono";
import { gitRoutes } from "./routes/git";

export type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();
app.route("/", gitRoutes);
app.notFound((c) => c.text("Not found", 404));

export default app;

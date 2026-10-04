import { Hono } from "hono";

export type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();
app.notFound((c) => c.text("Not found", 404));

export default app;

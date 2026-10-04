import type { Context } from "hono";
import type { AppEnv } from "../index";
import { UpstreamError, artifactsErrorCode } from "../artifacts";
import { page } from "../views/layout";
import { NotFound, ServerError, StorageUnavailable } from "../views/errors";

const isGitPath = (path: string) => /^\/[^/]+\.git(\/|$)/.test(path);

export function notFoundPage(c: Context<AppEnv>) {
  if (isGitPath(c.req.path)) return c.text("Not found", 404);
  return page(c, "Not found", <NotFound />, 404, { admin: c.req.path.startsWith("/admin") });
}

export function handleError(err: Error, c: Context<AppEnv>) {
  const code = artifactsErrorCode(err);
  const upstream = code !== null || err instanceof UpstreamError;
  console.error(JSON.stringify({ msg: "request failed", ray: c.req.header("cf-ray") ?? null, path: c.req.path, code, error: String(err), stack: err.stack }));
  if (isGitPath(c.req.path)) return c.text(upstream ? "Storage unavailable" : "Internal error", upstream ? 502 : 500);
  return upstream ? page(c, "Storage unavailable", <StorageUnavailable />, 502) : page(c, "Something went wrong", <ServerError />, 500);
}

import { Hono, type Context } from "hono";
import type { AppEnv } from "../index";
import { forgetRepoAccess, getRepoAccess } from "../artifacts";
import { basicPassword, decideGitAccess } from "../auth/git-auth";
import { findLiveRepo } from "../db/repos";
import { touchPushToken } from "../db/tokens";
import { CommandParser, ReportParser, tap } from "../git/pktline";
import { deliverWebhooks, pushEventsFrom } from "../webhooks";

type Service = "git-upload-pack" | "git-receive-pack";

const REPO = "/:repo{[a-z0-9][a-z0-9-]*\\.git}";
const FORWARD = ["content-type", "accept", "git-protocol", "content-encoding", "user-agent"];

export const gitRoutes = new Hono<AppEnv>();

gitRoutes.get(`${REPO}/info/refs`, async (c) => {
  const service = c.req.query("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return c.text("Not found", 404);
  return proxy(c, service, `info/refs?service=${service}`);
});
gitRoutes.post(`${REPO}/git-upload-pack`, (c) => proxy(c, "git-upload-pack", "git-upload-pack"));
gitRoutes.post(`${REPO}/git-receive-pack`, (c) => proxy(c, "git-receive-pack", "git-receive-pack"));
gitRoutes.all(`${REPO}/*`, (c) => c.text("Not found", 404));

async function proxy(c: Context<AppEnv>, service: Service, upstreamPath: string) {
  const now = Date.now();
  const name = c.req.param("repo")!.slice(0, -".git".length);
  const repo = await findLiveRepo(c.env.DB, name);
  const op = service === "git-receive-pack" ? "push" : "fetch";
  const decision = await decideGitAccess(c.env.DB, repo, basicPassword(c.req.header("authorization")), op, now);
  if (decision.kind === "unauthorized") {
    return c.text("Authentication required", 401, { "WWW-Authenticate": 'Basic realm="cloudflare-git"' });
  }
  if (decision.kind === "notfound" || !repo) return c.text("Repository not found", 404);
  if (decision.pushTokenId) c.executionCtx.waitUntil(touchPushToken(c.env.DB, decision.pushTokenId, now));

  const { remote, token } = await getRepoAccess(c.env.ARTIFACTS, repo.name, op === "push" ? "write" : "read");
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  for (const h of FORWARD) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }

  const isPush = service === "git-receive-pack" && c.req.method === "POST";
  const commands = new CommandParser();
  let body = c.req.raw.body;
  // A compressed push is forwarded untouched; parsing (and so webhooks) is skipped.
  const parsePush = isPush && body !== null && !c.req.header("content-encoding");
  if (parsePush && body) body = body.pipeThrough(tap((chunk) => commands.push(chunk)));

  const upstream = await fetch(`${remote}/${upstreamPath}`, { method: c.req.method, headers, body });
  if (!upstream.ok) {
    // 401/403 means our minted token is bad or expired (spike): drop it so the next request mints a new one.
    if (upstream.status === 401 || upstream.status === 403) forgetRepoAccess(repo.name);
    console.error(JSON.stringify({ msg: "artifacts git error", ray: c.req.header("cf-ray"), repo: repo.name, service, status: upstream.status }));
    return c.text("Storage unavailable", 502);
  }
  const resHeaders = { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": "no-cache" };
  if (!parsePush || !upstream.body) return new Response(upstream.body, { headers: resHeaders });

  // Upstream may send headers before it has read the push body, so wait for the
  // first response chunk (the report comes after the whole push) to read the commands.
  let report: ReportParser | null = null;
  let ended!: () => void;
  const finished = new Promise<void>((resolve) => (ended = resolve));
  const out = upstream.body.pipeThrough(
    tap((chunk) => {
      if (!report) {
        if (!commands.done) return true;
        report = new ReportParser(commands.capabilities.some((cap) => cap === "side-band-64k" || cap === "side-band"));
      }
      return report.push(chunk);
    }, ended),
  );
  c.executionCtx.waitUntil(
    finished.then(() => {
      if (!report?.done) {
        const msg = report ? "report-status not parsed; webhooks skipped" : "push commands not parsed; webhooks skipped";
        console.warn(JSON.stringify({ msg, repo: repo.name }));
        return;
      }
      return deliverWebhooks(c.env.DB, repo, pushEventsFrom(repo.name, commands.commands, report.results, Date.now()));
    }),
  );
  return new Response(out, { headers: resHeaders });
}

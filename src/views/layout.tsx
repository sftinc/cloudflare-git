import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AppEnv } from "../index";
import { isOwnerRequest } from "../auth/viewer";
import { accessConfigured } from "../lib/site";
import { LogIn, LogOut, Monitor, Moon, Plus, Settings, Sun, User } from "./icons";

function ThemeSwitch() {
  return (
    <>
      <div class="theme-seg" role="group" aria-label="Theme">
        <button type="button" data-theme-set="auto" aria-pressed="true" aria-label="Auto (match system)" title="Auto (match system)"><Monitor /></button>
        <button type="button" data-theme-set="light" aria-pressed="false" aria-label="Light" title="Light"><Sun /></button>
        <button type="button" data-theme-set="dark" aria-pressed="false" aria-label="Dark" title="Dark"><Moon /></button>
      </div>
      <button type="button" class="theme-cycle btn icon-btn" data-theme-cycle aria-label="Change theme" title="Change theme">
        <Monitor class="i-auto" /><Sun class="i-light" /><Moon class="i-dark" />
      </button>
    </>
  );
}

type AdminSection = "repos" | "invites" | "tokens";

export function Layout(props: { title: string; env: Env; admin?: boolean; section?: AdminSection; owner?: boolean; children?: Child }) {
  const { env, owner } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="icon" href="/static/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/static/style.css" />
        <script src="/static/theme.js"></script>
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <header class="site">
          <div class="wrap">
            <a href="/" class="brand">
              <img src={env.LOGO_URL || "/static/favicon.svg"} alt="" width="28" height="28" />
              <span>{env.SITE_TITLE || "Cloudflare Git"}</span>
            </a>
            {props.admin && (
              <nav class="admin-nav">
                <a href="/admin/repos" aria-current={props.section === "repos" ? "page" : undefined}>Repos</a>
                <a href="/admin/invites" aria-current={props.section === "invites" ? "page" : undefined}>Invites</a>
                <a href="/admin/tokens" aria-current={props.section === "tokens" ? "page" : undefined}>Push tokens</a>
              </nav>
            )}
            <div class="site-actions">
              {owner && (
                <a href="/admin/repos/new" class="btn primary icon-btn" aria-label="New repo" title="New repo">
                  <Plus /><span class="label">New</span>
                </a>
              )}
              <ThemeSwitch />
              {accessConfigured(env) && (owner && props.admin ? (
                <a href="/cdn-cgi/access/logout" class="btn icon-btn" aria-label="Log out" title="Log out">
                  <LogOut /><span class="label">Log out</span>
                </a>
              ) : owner ? (
                <details class="menu">
                  <summary class="btn icon-btn" aria-label="Account" title="Account">
                    <User /><span class="label">Account</span>
                  </summary>
                  <ul>
                    <li><a href="/admin/repos"><Settings /> Admin</a></li>
                    <li><a href="/cdn-cgi/access/logout"><LogOut /> Log out</a></li>
                  </ul>
                </details>
              ) : (
                <a href="/admin" class="btn icon-btn" aria-label="Log in" title="Log in">
                  <LogIn /><span class="label">Log in</span>
                </a>
              ))}
            </div>
          </div>
        </header>
        <main class={props.admin ? "wrap admin" : "wrap"}>{props.children}</main>
        <footer class="site">
          <div class="wrap">
            <span>{env.COMPANY_NAME && `© ${new Date().getFullYear()} ${env.COMPANY_NAME}`}</span>
            <span>Powered by Cloudflare Git</span>
          </div>
        </footer>
      </body>
    </html>
  );
}

export async function page(c: Context<AppEnv>, title: string, body: Child, status = 200, opts: { admin?: boolean } = {}) {
  const owner = opts.admin || (await isOwnerRequest(c));
  const section = opts.admin ? (/^\/admin\/(repos|invites|tokens)\b/.exec(c.req.path)?.[1] as AdminSection | undefined) : undefined;
  return c.html(
    <>
      {raw("<!doctype html>")}
      <Layout title={title} env={c.env} admin={opts.admin} section={section} owner={owner}>
        {body}
      </Layout>
    </>,
    status as 200,
  );
}

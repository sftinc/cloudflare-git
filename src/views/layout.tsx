import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AppEnv } from "../index";
import { isOwnerRequest } from "../auth/viewer";
import { accessConfigured } from "../lib/site";
import { LogIn, LogOut, Monitor, Moon, Plus, Sun } from "./icons";

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

export function Layout(props: { title: string; env: Env; admin?: boolean; owner?: boolean; children?: Child }) {
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
            <a href={props.admin ? "/admin" : "/"} class="brand">
              <img src={env.LOGO_URL || "/static/favicon.svg"} alt="" width="28" height="28" />
              <span>{env.SITE_TITLE || "Cloudflare Git"}</span>
            </a>
            {props.admin && (
              <nav class="admin-nav">
                <a href="/admin">Repos</a>
                <a href="/admin/invites">Invites</a>
                <a href="/admin/tokens">Push tokens</a>
                <a href="/">Public site</a>
              </nav>
            )}
            <div class="site-actions">
              {owner && (
                <a href="/admin#new" class="btn primary icon-btn" aria-label="New repository" title="New repository">
                  <Plus /><span class="label">New</span>
                </a>
              )}
              <ThemeSwitch />
              {accessConfigured(env) && (owner ? (
                <a href="/cdn-cgi/access/logout" class="btn icon-btn" aria-label="Log out" title="Log out">
                  <LogOut /><span class="label">Log out</span>
                </a>
              ) : (
                <a href="/admin" class="btn icon-btn" aria-label="Log in" title="Log in">
                  <LogIn /><span class="label">Log in</span>
                </a>
              ))}
            </div>
          </div>
        </header>
        <main class="wrap">{props.children}</main>
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
  return c.html(
    <>
      {raw("<!doctype html>")}
      <Layout title={title} env={c.env} admin={opts.admin} owner={owner}>
        {body}
      </Layout>
    </>,
    status as 200,
  );
}

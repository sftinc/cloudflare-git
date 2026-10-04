import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";

export function Layout(props: { title: string; admin?: boolean; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/static/style.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <header class="site">
          <div class="wrap">
            <a href={props.admin ? "/admin" : "/"} class="brand">
              <span class="brand-mark" aria-hidden="true">⎇</span> git
            </a>
            {props.admin && (
              <nav class="admin-nav">
                <a href="/admin">Repos</a>
                <a href="/admin/invites">Invites</a>
                <a href="/admin/tokens">Push tokens</a>
                <a href="/">Public site</a>
              </nav>
            )}
          </div>
        </header>
        <main class="wrap">{props.children}</main>
      </body>
    </html>
  );
}

export function page(c: Context, title: string, body: Child, status = 200, opts: { admin?: boolean } = {}) {
  return c.html(
    <>
      {raw("<!doctype html>")}
      <Layout title={title} admin={opts.admin}>
        {body}
      </Layout>
    </>,
    status as 200,
  );
}

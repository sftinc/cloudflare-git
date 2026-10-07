# cloudflare-git

A personal git host that runs as one Cloudflare Worker. Repositories live in
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/); the Worker proxies git's
smart-HTTP protocol, serves a small read-only web UI, and keeps its own state (repos, invites,
push tokens, webhooks) in D1. The admin pages sit behind Cloudflare Access, so only you can
manage anything.

- Browse repos: files, branches, commits, rendered Markdown and highlighted code
- Public repos anyone can clone; private repos only you (and people you invite) can see
- `git clone` / `git push` over HTTPS through your own domain, with push tokens
- One-time invite links that give someone read access to chosen private repos
- Import a public repo from a URL
- Signed push webhooks (`X-Signature-256`)
- Strict CSP, no inline scripts or styles, raw files served safely

## Requirements

- A Cloudflare account on the **Workers Paid** plan (Artifacts needs it)
- Wrangler **4.147** or later (installed locally by `npm install`)
- Node **24**

## Local development

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc   # your config; gitignored
cp .dev.vars.example .dev.vars        # set COOKIE_SECRET to a long random string
npm run db:migrate:local
npm run dev                           # http://localhost:8787
```

**Artifacts is always remote, even in dev.** `wrangler dev` talks to the real Artifacts
namespace `cloudflare-git-dev` in your account (run `npx wrangler login` first). D1 is local.

`/admin` checks a Cloudflare Access JWT on every request. Locally there is no Access, so put a
JWKS in `ACCESS_JWKS` in `.dev.vars` and send a JWT signed with that key in the
`Cf-Access-Jwt-Assertion` header (issuer `https://dev.cloudflareaccess.com`, audience `dev-aud`,
matching `wrangler.jsonc`). `scripts/e2e.mjs` shows how to make the
key pair and mint the token.

## Tests

```sh
npm test         # unit and integration tests; no network
npm run typecheck
npm run e2e      # real Artifacts: needs `wrangler login`
```

`npm run e2e` starts `wrangler dev` with its own local state in `.e2e/`, creates
`e2e-*` repos in the `cloudflare-git-dev` namespace, pushes and clones with real `git`, checks
webhooks and invites, imports `octocat/Hello-World`, takes screenshots of every page with
headless Chrome (`.e2e/screenshots/`), and deletes its repos at the end. It never touches your
`.dev.vars` or local D1 data. It needs Google Chrome at the standard macOS path and ports
8787, 8799 and 9333 free.

## Deploy

1. If you haven't already, `cp wrangler.example.jsonc wrangler.jsonc` (gitignored, so your hostname and IDs stay out of the repo). Create the database and put its id in `env.production.d1_databases` in `wrangler.jsonc`:
   ```sh
   npx wrangler d1 create cloudflare-git
   ```
2. In `env.production` set `SITE_ORIGIN` (e.g. `https://git.example.com`), and the
   custom domain in `routes`. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` come from the next section.
   `env.production` also sets `workers_dev: false` and `preview_urls: false`, so the Worker answers
   only on the custom domain. Access guards only `git.example.com/admin`; the `workers.dev` and
   preview URLs would be unguarded paths to the same Worker (it still verifies the JWT regardless).
   `SITE_ORIGIN` is optional: without it, URLs use the origin each request came in on.
   Optional vars, all safe to leave out:

   | Var | Default when unset or blank |
   |---|---|
   | `SITE_TITLE` | "Cloudflare Git" |
   | `LOGO_URL` | The built-in logo. An https URL on another host is added to the page's CSP `img-src`. |
   | `COMPANY_NAME` | No "© year name" line in the footer |
   | `RESTORE_DAYS` | 30: a deleted repo can be restored from the admin Repos page for 30 days. A whole number of days; `0` means deleted repos can't be restored. 24 hours after the window ends, an hourly cron (`triggers` in `env.production`) deletes the repo's storage for good and frees its name. |

   Without `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` nobody can log in: the site runs public-only and
   logs a warning.
3. Apply migrations, set the cookie secret, deploy:
   ```sh
   npx wrangler d1 migrations apply DB --remote --env production
   npx wrangler secret put COOKIE_SECRET --env production
   npm run deploy
   ```

### Cloudflare Access

In Zero Trust, create a **self-hosted application** for `git.example.com/admin` with a policy
that allows only your own email (or a group of admins), never "everyone". The policy is the only
gate: the Worker verifies the JWT's signature, issuer, audience and expiry, but not who the user is. Copy the application's **AUD tag** into `ACCESS_AUD` and your team
domain (`<team>.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`, then deploy again.

The Worker verifies the Access JWT itself; it does not trust the edge alone. On public pages it
also reads the `CF_Authorization` cookie, so when you are logged in to Access you see your
private repos on the home page and can browse them. That only works if the browser sends the
cookie to `/` as well as `/admin` (spec §14 item 5). Check it after deploying: open `/admin`,
then `/`. If your private repos don't show up, the cookie is scoped to `/admin`; give yourself an
invite instead (below).

### First steps after deploying

1. Open `https://git.example.com/admin` and log in through Access.
2. In **Push tokens**, create a token and copy it now (it is shown once).
3. Bring in a repo: **Import** for a public repo, or create an empty repo and push it
   (see [Moving repos in](#moving-repos-in)). Git asks for a username (anything) and a password
   (the token).
4. Still logged in, open `https://git.example.com/`. If your private repos are listed, the Access
   cookie reaches the public pages; if not, see the note above.

## Moving repos in

**Public repos: Import.** In `/admin/repos/new`, choose **Import**. It copies the source's default
branch (or the one branch you name) and **no tags** — that's how Artifacts import works.

**Private repos, or every branch and tag: push them all.** Create an empty repo in `/admin/repos/new` with
the same default branch as the source, then:

```sh
git clone --mirror https://github.com/you/project.git
cd project.git
git push https://git.example.com/r/project.git --all
git push https://git.example.com/r/project.git --tags
```

Don't use `git push --mirror`: a GitHub mirror also holds `refs/pull/*`, and Artifacts applies a
push atomically, so one rejected ref fails the whole push.

If the repo is over 100 MB, push to the "Direct push URL" from the repo's admin page instead
(valid for one hour; webhooks don't fire for direct pushes).

## Pushing

Create a push token in `/admin/tokens` (optionally limited to some repos), then:

```sh
git remote add origin https://git.example.com/r/project.git
git push -u origin main
```

The first push asks for a username and password: any username, the token as the password. On a
Mac the keychain remembers it.

In CI, store the token as `GIT_PUSH_TOKEN` and use a credential helper. This sets it globally,
so use it **for CI runners only**, never on your own machine:

```sh
git config --global credential.helper '!f() { echo username=x; echo password=$GIT_PUSH_TOKEN; }; f'
git push https://git.example.com/r/project.git HEAD:main
```

## Sharing

- **Public repos**: share `https://git.example.com/r/<name>`; anyone can browse and clone.
- **Private repos**: create an invite in `/admin/invites`, choose the repos, how long the link
  stays open (1 hour, 24 hours, 7 days) and how long access lasts (7 days to never). The link
  works once: opening it and clicking "Accept invite" sets a browser cookie for browsing and shows
  a personal clone URL. Revoke the invite at any time to cut off both.

## Webhooks

Add a webhook on a repo's admin page (optionally for one branch). After each push that updates a
branch, the Worker POSTs one JSON body per branch:

```json
{
  "repo": "project",
  "branch": "main",
  "before": "0000000000000000000000000000000000000000",
  "after": "26a7dfbc584798aa6510b546e73ddb3a25c68c21",
  "deleted": false,
  "pushed_at": 1791150567693
}
```

`X-Signature-256` is `sha256=` plus the hex HMAC-SHA256 of the raw body with the webhook's secret
(under **Show secret** in the repo's webhook list). There are no retries; the repo's admin page shows each hook's latest delivery result. Verify it like this:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c)).on("end", () => {
    const body = Buffer.concat(chunks); // HMAC the raw bytes, before any parsing
    const want = Buffer.from("sha256=" + createHmac("sha256", process.env.WEBHOOK_SECRET).update(body).digest("hex"));
    const got = Buffer.from(req.headers["x-signature-256"] ?? "");
    res.statusCode = got.length === want.length && timingSafeEqual(got, want) ? 204 : 401;
    res.end();
    if (res.statusCode === 204) console.log("push", JSON.parse(body));
  });
}).listen(8080);
```

## Limits

- 100 MB per push through the site. A bigger push fails with `error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413`: push the branches one at a time (`git push origin <branch>`), or use the direct push URL
- 1 GB per repo and 32 MB per file (Artifacts limits); files over ~20 MB can't be shown in the browser
- HTTPS only: no SSH, no Git LFS
- Push options (`git push -o`) are not supported

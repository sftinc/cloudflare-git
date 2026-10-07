#!/usr/bin/env node
// End-to-end: wrangler dev (local D1, real Artifacts ns "cloudflare-git-dev"), real git, webhooks, screenshots.
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const OUT = path.join(ROOT, ".e2e");
const SHOTS = path.join(OUT, "screenshots");
const STATE = path.join(OUT, "state");
const VARS = path.join(OUT, "e2e.vars");
const WORK = path.join(OUT, "work");
const PORT = 8787;
const ORIGIN = `http://localhost:${PORT}`;
const HOOK_PORT = 8799;
const NAMESPACE = "cloudflare-git-dev";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN = Date.now().toString(36);
const NAMES = { pub: `e2e-${RUN}-site`, priv: `e2e-${RUN}-private`, imp: `e2e-${RUN}-import`, old: `e2e-${RUN}-old`, moved: `e2e-${RUN}-moved` };
const storageNames = new Set(); // new repos keep their files under their id (src/db/repos.ts), so cleanup collects ids
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
const lines = (out) => out.split("\n").map((l) => l.trimEnd());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => Buffer.from(buf).toString("base64url");
// wrangler dev drops idle keep-alive sockets; a request that lands on one fails with ECONNRESET
// before reaching the Worker. Retry that once (bodies here are strings, so they can be resent).
async function fetch(url, init) {
  try {
    return await globalThis.fetch(url, init);
  } catch (err) {
    if (err.cause?.code !== "ECONNRESET") throw err;
    return globalThis.fetch(url, init);
  }
}

// git never prompts and never touches the user's keychain, signing keys or hooks.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
const GIT_C = ["-c", "credential.helper=", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
function git(args, opts = {}) {
  return execFileSync("git", [...GIT_C, ...args], { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function gitStatus(args, opts = {}) {
  const r = spawnSync("git", [...GIT_C, ...args], { env: GIT_ENV, encoding: "utf8", ...opts });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// 1. Keys and vars
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256" };
function mintJwt() {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: "e2e", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: "https://dev.cloudflareaccess.com", aud: ["dev-aud"], email: "owner@example.com", iat, nbf: iat, exp: iat + 3600 }));
  const data = `${header}.${claims}`;
  return `${data}.${b64url(sign("RSA-SHA256", Buffer.from(data), privateKey))}`;
}
const jwt = mintJwt();

// 4. Admin helper
async function admin(method, p, form) {
  return fetch(`${ORIGIN}${p}`, {
    method,
    redirect: "manual",
    headers: {
      "Cf-Access-Jwt-Assertion": jwt,
      Origin: ORIGIN,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
}
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function secretOf(html) {
  const m = html.match(/<code id="secret">([^<]*)<\/code>/);
  if (!m) throw new Error("no <code id=\"secret\"> in page");
  return unescape(m[1]);
}
async function createRepo(name) {
  const res = await admin("POST", "/admin/repos", { name, description: `E2E ${name}`, defaultBranch: "main" });
  const id = res.status === 303 && res.headers.get("location")?.match(/^\/admin\/repos\/([^/]+)$/)?.[1];
  if (id) storageNames.add(id);
  check(`create repo ${name}`, !!id, `status ${res.status}`);
  return id;
}
async function makePublic(id) {
  const res = await admin("POST", `/admin/repos/${id}/visibility`, { public: "1" });
  check(`make ${id} public`, res.status === 303, `status ${res.status}`);
}
async function createInvite(repoId, label) {
  const res = await admin("POST", "/admin/invites", { label, repos: repoId, redeem: "24h", access: "never" });
  const html = await res.text();
  check(`create invite "${label}"`, res.status === 200, `status ${res.status}`);
  return secretOf(html);
}

// 6. Realistic local repo
function writeFiles(files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(WORK, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
}
let commitTime = Date.parse("2026-09-28T09:00:00Z") / 1000;
function commit(message) {
  commitTime += 7 * 3600;
  const date = `${commitTime} +0000`;
  git(["add", "-A"], { cwd: WORK });
  git(["commit", "-q", "-m", message], {
    cwd: WORK,
    env: { ...GIT_ENV, GIT_AUTHOR_NAME: "E2E Bot", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "E2E Bot", GIT_COMMITTER_EMAIL: "e2e@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

const README = `# Lantern

Lantern is a tiny HTTP router for Cloudflare Workers. It matches paths, extracts parameters and
keeps handlers small, so a whole API fits in one readable file.

## Features

- Path parameters like \`/users/:id\`, with typed access in handlers
- Middleware that runs before and after each route
- Zero dependencies and under 2 KB minified
- First-class \`Request\`/\`Response\` objects; nothing to learn

## Quick start

\`\`\`ts
import { Router } from "./src/router";

const router = new Router()
  .get("/", () => new Response("Hello"))
  .get("/users/:id", (_req, { id }) => Response.json({ id }));

export default { fetch: (req: Request) => router.handle(req) };
\`\`\`

## Benchmarks

| Router  | Routes | ns/match | Size   |
| ------- | -----: | -------: | ------ |
| Lantern |    100 |      210 | 1.8 KB |
| Linear  |    100 |    1,450 | 0.6 KB |
| Trie    |    100 |      180 | 6.2 KB |

Read the [guide](docs/guide.md) for routing rules, middleware and error handling.

![Architecture](docs/arch.png)
`;

const INDEX_TS = `import { Router, type Handler } from "./router";

export interface Env {
  GREETING: string;
  DB: D1Database;
}

type User = { id: string; name: string; createdAt: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const listUsers: Handler<Env> = async (_req, _params, env) => {
  const { results } = await env.DB.prepare("SELECT id, name, created_at AS createdAt FROM users ORDER BY name").all<User>();
  return json(results);
};

const getUser: Handler<Env> = async (_req, { id }, env) => {
  const user = await env.DB.prepare("SELECT id, name, created_at AS createdAt FROM users WHERE id = ?").bind(id).first<User>();
  return user ? json(user) : json({ error: "not found" }, 404);
};

const createUser: Handler<Env> = async (req, _params, env) => {
  const body = (await req.json()) as Partial<User>;
  if (!body.name || body.name.length > 80) return json({ error: "name is required (max 80 chars)" }, 400);
  const user: User = { id: crypto.randomUUID(), name: body.name, createdAt: Date.now() };
  await env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").bind(user.id, user.name, user.createdAt).run();
  return json(user, 201);
};

const router = new Router<Env>()
  .use(async (req, next) => {
    const started = Date.now();
    const res = await next();
    console.log(\`\${req.method} \${new URL(req.url).pathname} \${res.status} \${Date.now() - started}ms\`);
    return res;
  })
  .get("/", (_req, _params, env) => new Response(env.GREETING ?? "Hello from Lantern"))
  .get("/users", listUsers)
  .get("/users/:id", getUser)
  .post("/users", createUser);

export default {
  fetch: (req: Request, env: Env) => router.handle(req, env),
} satisfies ExportedHandler<Env>;
`;

const ROUTER_TS = `export type Params = Record<string, string>;
export type Handler<E> = (req: Request, params: Params, env: E) => Response | Promise<Response>;
export type Middleware = (req: Request, next: () => Promise<Response>) => Promise<Response>;

type Route<E> = { method: string; pattern: RegExp; keys: string[]; handler: Handler<E> };

/** Compiles "/users/:id" into a RegExp and the list of parameter names. */
export function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
      keys.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { pattern: new RegExp(\`^\${source}/?$\`), keys };
}

export class Router<E = unknown> {
  private routes: Route<E>[] = [];
  private middleware: Middleware[] = [];

  use(fn: Middleware) {
    this.middleware.push(fn);
    return this;
  }

  on(method: string, path: string, handler: Handler<E>) {
    this.routes.push({ method, handler, ...compile(path) });
    return this;
  }

  get = (path: string, handler: Handler<E>) => this.on("GET", path, handler);
  post = (path: string, handler: Handler<E>) => this.on("POST", path, handler);

  async handle(req: Request, env: E): Promise<Response> {
    const { pathname } = new URL(req.url);
    const dispatch = async () => {
      for (const route of this.routes) {
        const match = route.method === req.method && route.pattern.exec(pathname);
        if (!match) continue;
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
        return route.handler(req, params, env);
      }
      return new Response("Not found", { status: 404 });
    };
    const chain = this.middleware.reduceRight<() => Promise<Response>>((next, fn) => () => fn(req, next), dispatch);
    return chain();
  }
}
`;

const GUIDE_MD = `# Lantern guide

This guide covers routing rules, middleware and error handling.

## Routing rules

Routes are matched **in the order they were added**. The first route whose method and pattern
match wins, so put specific routes before general ones.

1. Static segments match exactly: \`/users\` matches only \`/users\` and \`/users/\`.
2. Parameters (\`:name\`) match one segment and are URL-decoded.
3. Anything else falls through to a plain \`404\`.

> Tip: keep route tables short. If a file grows past a screen, split it by resource.

## Middleware

Middleware wraps every route. Call \`next()\` to continue; return a response to stop early.

\`\`\`ts
router.use(async (req, next) => {
  if (!req.headers.get("authorization")) return new Response("Unauthorized", { status: 401 });
  return next();
});
\`\`\`

## Error handling

Throwing inside a handler surfaces as a \`500\`. Catch expected failures and return a typed
JSON error instead. See [the notes](my%20notes%20%231.md) for open questions.
`;

const NOTES_MD = `# Notes #1

- Should \`:id\` parameters support custom patterns like \`:id(\\\\d+)\`?
- Benchmark against a radix tree once the route table passes 1,000 entries.
`;

function buildRepo() {
  mkdirSync(WORK, { recursive: true });
  git(["init", "-q", "-b", "main"], { cwd: WORK });
  writeFiles({ ".gitignore": "node_modules/\n.wrangler/\n.dev.vars\n", "package.json": JSON.stringify({ name: "lantern", version: "0.1.0", type: "module", scripts: { dev: "wrangler dev", test: "vitest run" } }, null, 2) + "\n" });
  commit("Initial commit: package.json and .gitignore");
  writeFiles({ "src/router.ts": ROUTER_TS });
  commit("Add a small path router with parameters and middleware");
  writeFiles({ "src/index.ts": INDEX_TS, "README.md": README, "docs/arch.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), randomBytes(64)]) });
  commit("Add the users API and README");
  writeFiles({ "docs/guide.md": GUIDE_MD, "docs/my notes #1.md": NOTES_MD });
  commit("Write the routing guide and notes");
  git(["checkout", "-q", "-b", "feature/login"], { cwd: WORK });
  writeFiles({ "src/login.ts": `export async function login(req: Request): Promise<Response> {\n  const { email } = (await req.json()) as { email?: string };\n  if (!email) return new Response("email required", { status: 400 });\n  return Response.json({ ok: true, email });\n}\n` });
  commit("Add a login handler (work in progress)");
  git(["checkout", "-q", "main"], { cwd: WORK });
}

// 14. Headless Chrome over CDP
async function startChrome() {
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${path.join(OUT, "chrome-profile")}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch("http://127.0.0.1:9333/json/list")).json()).find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(`${m.error.message}`));
      else p?.resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const waitFor = (method, timeout = 30_000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        listeners.delete(l);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeout);
      const l = (m) => {
        if (m.method !== method) return;
        clearTimeout(t);
        listeners.delete(l);
        resolve(m.params);
      };
      listeners.add(l);
    });
  return { proc, ws, send, waitFor, listeners };
}

async function screenshots(ids, inviteForBrowser) {
  const chrome = await startChrome();
  const { send, waitFor, listeners } = chrome;
  const errors = [];
  let currentUrl = "";
  const expected404 = new Set([`${ORIGIN}/r/${NAMES.pub}/blob/main/nope.txt`]);
  listeners.add((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(`${currentUrl}: exception ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(`${currentUrl}: console.error ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      const e = m.params.entry;
      // The deliberate 404 page logs its own status; that is not a page error.
      if (e.source === "network" && expected404.has(e.url)) return;
      errors.push(`${currentUrl}: ${e.source} ${e.text} ${e.url ?? ""}`);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const desktop = () => send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await desktop();
  // Pin light mode: headless Chrome otherwise follows the OS appearance.
  const scheme = (value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  await scheme("light");

  let n = 0;
  const files = [];
  async function capture(name) {
    await sleep(300);
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const file = path.join(SHOTS, `${String(++n).padStart(2, "0")}-${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    files.push(file);
  }
  async function load(url) {
    currentUrl = url;
    const loaded = waitFor("Page.loadEventFired");
    await send("Page.navigate", { url });
    await loaded;
  }
  async function shot(name, url) {
    await load(url);
    await capture(name);
  }
  async function submit(expression, name) {
    const loaded = waitFor("Page.loadEventFired");
    await send("Runtime.evaluate", { expression });
    await loaded;
    await capture(name);
  }
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

  try {
    const p = `${ORIGIN}/r/${NAMES.pub}`;
    await shot("home", `${ORIGIN}/`);
    await shot("repo-home", p);
    await shot("tree-docs", `${p}/tree/main/docs`);
    await shot("file-code", `${p}/blob/main/src/index.ts`);
    await shot("file-markdown", `${p}/blob/main/docs/guide.md`);
    await shot("branch-feature", `${p}/tree/feature/login`);
    await shot("commits", `${p}/commits/main`);
    await shot("not-found", `${p}/blob/main/nope.txt`);
    await shot("invite-confirm", inviteForBrowser);
    await submit("document.querySelector('form').submit()", "invite-accepted");
    await shot("home-with-invite", `${ORIGIN}/`);
    check("browser home lists the invited private repo", (await evaluate("document.body.innerText")).includes(NAMES.priv));
    await shot("private-repo", `${ORIGIN}/r/${NAMES.priv}`);
    await shot("imported-repo", `${ORIGIN}/r/${NAMES.imp}`);

    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    for (const [name, url] of [["mobile-repo-home", p], ["mobile-file-code", `${p}/blob/main/src/index.ts`]]) {
      await shot(name, url);
      const width = await evaluate("document.documentElement.scrollWidth");
      check(`no horizontal scroll on ${name}`, width <= 390, `scrollWidth ${width}`);
    }

    await desktop();
    await scheme("dark");
    await shot("dark-repo-home", p);
    await shot("dark-file-code", `${p}/blob/main/src/index.ts`);
    await scheme("light");

    await send("Network.setExtraHTTPHeaders", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    await shot("admin-repos", `${ORIGIN}/admin/repos`);
    await shot("admin-repo", `${ORIGIN}/admin/repos/${ids.pub}`);
    await shot("admin-invites", `${ORIGIN}/admin/invites`);
    await shot("admin-tokens", `${ORIGIN}/admin/tokens`);
    await submit(
      "(() => { const f = document.querySelector('form[action=\"/admin/tokens\"]'); f.querySelector('input[name=name]').value = 'laptop'; f.querySelector('input[name=all]').checked = true; f.submit(); })()",
      "admin-token-created",
    );
    check("browser token form shows the new token", (await evaluate("!!document.querySelector('code#secret')")) === true);
    await send("Network.setExtraHTTPHeaders", { headers: {} });

    check("no script errors or CSP violations in the browser", errors.length === 0, errors.join(" | "));
  } finally {
    chrome.ws.close();
    chrome.proc.kill();
  }
  return files;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(VARS, `COOKIE_SECRET=${randomBytes(32).toString("hex")}\nACCESS_JWKS='${JSON.stringify({ keys: [jwk] })}'\n`);

  // 2. Start
  console.log("Applying migrations to .e2e/state …");
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "1" } });
  const log = createWriteStream(path.join(OUT, "wrangler.log"));
  const dev = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--persist-to", STATE, "--env-file", VARS, "--show-interactive-dev-session=false"], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  dev.stdout.pipe(log);
  dev.stderr.pipe(log);
  cleanups.push(() => {
    try {
      process.kill(-dev.pid, "SIGTERM");
    } catch {}
  });
  let up = false;
  for (const started = Date.now(); Date.now() - started < 90_000 && !up; ) {
    await sleep(1000);
    try {
      up = (await fetch(`${ORIGIN}/`)).status === 200;
    } catch {}
  }
  check("wrangler dev serves /", up);

  // 3. Webhook receiver
  const deliveries = [];
  const hookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      deliveries.push({ path: req.url, headers: req.headers, body });
      res.end("ok");
    });
  });
  await new Promise((r) => hookServer.listen(HOOK_PORT, r));
  cleanups.push(() => hookServer.close());

  // 5. Setup through admin
  check("admin rejects requests without a JWT", (await fetch(`${ORIGIN}/admin`)).status === 404);
  const tokenRes = await admin("POST", "/admin/tokens", { name: "e2e", all: "1" });
  check("create push token", tokenRes.status === 200, `status ${tokenRes.status}`);
  const pushToken = secretOf(await tokenRes.text());
  const ids = { pub: await createRepo(NAMES.pub), priv: await createRepo(NAMES.priv) };
  await makePublic(ids.pub);
  const hookRes = await admin("POST", `/admin/repos/${ids.pub}/webhooks`, { url: `http://localhost:${HOOK_PORT}/hook`, branch: "main" });
  check("add webhook", hookRes.status === 200, `status ${hookRes.status}`);
  const hookSecret = secretOf(await hookRes.text());

  // 6. Local repo
  buildRepo();
  const mainSha = git(["rev-parse", "main"], { cwd: WORK });
  const featureSha = git(["rev-parse", "feature/login"], { cwd: WORK });

  // 7. Push
  const pushUrl = (name) => `http://x:${pushToken}@localhost:${PORT}/r/${name}.git`;
  const push = gitStatus(["push", pushUrl(NAMES.pub), "main", "feature/login"], { cwd: WORK });
  check("push main and feature/login", push.code === 0, push.code === 0 ? "" : push.out);

  // 8. Webhooks
  for (const started = Date.now(); Date.now() - started < 15_000 && deliveries.length === 0; ) await sleep(250);
  await sleep(2000); // catch any extra (wrong) deliveries
  check("exactly one webhook delivery (main only)", deliveries.length === 1, `${deliveries.length} deliveries`);
  const d = deliveries[0];
  const expectedSig = "sha256=" + createHmac("sha256", hookSecret).update(d.body).digest("hex");
  check("webhook signature verifies", d.headers["x-signature-256"] === expectedSig);
  const event = JSON.parse(d.body);
  check(
    "webhook payload",
    event.repo === NAMES.pub && event.branch === "main" && event.deleted === false && /^[0-9a-f]{40}$/.test(event.after) && event.after === mainSha,
    d.body,
  );
  const hookStatus = await (await admin("GET", `/admin/repos/${ids.pub}`)).text();
  check("the repo's admin page shows the delivery", hookStatus.includes("Last delivery: 200"), hookStatus.match(/Last delivery[^<]*|No deliveries yet/)?.[0] ?? "");

  // 9. Public clone
  const clonePub = gitStatus(["clone", "-q", `${ORIGIN}/r/${NAMES.pub}.git`, path.join(OUT, "clone-pub")]);
  check("anonymous clone of public repo", clonePub.code === 0, clonePub.out);
  check("clone HEAD equals local main", git(["rev-parse", "HEAD"], { cwd: path.join(OUT, "clone-pub") }) === mainSha);
  const lsPub = git(["ls-remote", `${ORIGIN}/r/${NAMES.pub}.git`]);
  check("feature/login exists on the remote", lsPub.includes(`${featureSha}\trefs/heads/feature/login`), lsPub);

  // 10. Private repo
  const pushPriv = gitStatus(["push", pushUrl(NAMES.priv), "main"], { cwd: WORK });
  check("push main to private repo", pushPriv.code === 0, pushPriv.out);
  const lsPriv = gitStatus(["ls-remote", `${ORIGIN}/r/${NAMES.priv}.git`]);
  check("anonymous ls-remote of private repo fails", lsPriv.code !== 0);
  check("private repo page is 404 without cookies", (await fetch(`${ORIGIN}/r/${NAMES.priv}`)).status === 404);

  // 11. Invite via HTTP
  const link = await createInvite(ids.priv, "Sam");
  const inviteGet = await fetch(link);
  check("invite link shows the confirm page", inviteGet.status === 200 && (await inviteGet.text()).includes("Accept invite"));
  const accept = await fetch(link, { method: "POST", headers: { Origin: ORIGIN }, redirect: "manual" });
  const acceptHtml = await accept.text();
  const cookie = accept.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("cg_invites="));
  // The page shows a `git credential approve` command with the clone password; clone with it inline.
  const password = unescape(acceptHtml.match(/url=https?:\/\/x:([^@]+)@/)?.[1] ?? "");
  const cloneUrl = password ? `http://x:${password}@localhost:${PORT}/r/${NAMES.priv}.git` : "";
  check("accepting the invite sets a cookie and shows a clone URL", accept.status === 200 && !!cookie && cloneUrl.startsWith("http://x:"));
  const clonePriv = gitStatus(["clone", "-q", cloneUrl, path.join(OUT, "clone-priv")]);
  check("clone private repo with the invite URL", clonePriv.code === 0, clonePriv.out);
  check("private repo page is 200 with the invite cookie", (await fetch(`${ORIGIN}/r/${NAMES.priv}`, { headers: { Cookie: cookie } })).status === 200);
  check("a second accept is refused", (await fetch(link, { method: "POST", headers: { Origin: ORIGIN } })).status === 404);

  // 12. Import
  const imp = await admin("POST", "/admin/import", { name: NAMES.imp, url: "https://github.com/octocat/Hello-World" });
  const impId = imp.status === 303 && imp.headers.get("location")?.match(/^\/admin\/repos\/([^/]+)$/)?.[1];
  if (impId) storageNames.add(impId);
  check("import accepted", !!impId, `status ${imp.status}`);
  let ready = false;
  for (const started = Date.now(); Date.now() - started < 120_000 && !ready; ) {
    ready = (await (await admin("GET", `/admin/repos/${impId}`)).text()).includes(`/admin/repos/${impId}/rename`); // settings appear once it's created
    if (!ready) await sleep(3000);
  }
  check("import becomes Ready", ready);
  await makePublic(impId);
  const impPage = await fetch(`${ORIGIN}/r/${NAMES.imp}`);
  const impHtml = await impPage.text();
  check("imported repo page is 200", impPage.status === 200);
  check("imported repo shows its default branch (master)", impHtml.includes("Default branch <strong>master</strong>"));

  // 13. Raw safety
  const rawPng = await fetch(`${ORIGIN}/r/${NAMES.pub}/blob/main/docs/arch.png?raw`);
  check(
    "image raw is served as an image, not a download",
    rawPng.headers.get("content-type") === "image/png" && !rawPng.headers.get("content-disposition"),
    `${rawPng.headers.get("content-type")} / ${rawPng.headers.get("content-disposition")}`,
  );
  const rawMd = await fetch(`${ORIGIN}/r/${NAMES.pub}/blob/main/README.md?raw=1`);
  check("text raw is text/plain", rawMd.headers.get("content-type") === "text/plain; charset=utf-8", rawMd.headers.get("content-type"));
  const notes = await fetch(`${ORIGIN}/r/${NAMES.pub}/blob/main/docs/${encodeURIComponent("my notes #1.md")}`);
  check("file with space and # in its name opens", notes.status === 200 && (await notes.text()).includes("Notes #1"));

  // 13b. Rename: git and page links keep working at the old name, and a push there says where the repo moved
  const oldId = await createRepo(NAMES.old);
  await makePublic(oldId);
  const pushOld = gitStatus(["push", pushUrl(NAMES.old), "main"], { cwd: WORK });
  check("push to the repo before renaming", pushOld.code === 0, pushOld.out);
  const renameRes = await admin("POST", `/admin/repos/${oldId}/rename`, { name: NAMES.moved });
  check("rename the repo", renameRes.status === 303 && renameRes.headers.get("location") === `/admin/repos/${oldId}?renamed=1`, `status ${renameRes.status}`);
  writeFiles({ "renamed.txt": "pushed to the old name\n" });
  commit("Push to the old name after a rename");
  const renamedSha = git(["rev-parse", "main"], { cwd: WORK });
  const pushMoved = gitStatus(["push", pushUrl(NAMES.old), "main"], { cwd: WORK });
  check("push to the old URL succeeds", pushMoved.code === 0, pushMoved.out);
  check(
    "push to the old URL prints the new location",
    // git pads side-band lines with spaces to clear the terminal line, so compare trimmed lines.
    lines(pushMoved.out).includes("remote: This repository moved. Please use the new location:") &&
      lines(pushMoved.out).includes(`remote:   ${ORIGIN}/r/${NAMES.moved}.git`) &&
      !pushMoved.out.includes("remote: remote:"),
    pushMoved.out,
  );
  check("new name has the pushed commit", git(["ls-remote", pushUrl(NAMES.moved), "refs/heads/main"]).startsWith(renamedSha));
  const movedPage = await fetch(`${ORIGIN}/r/${NAMES.moved}`);
  check("new name's page shows the pushed file", movedPage.status === 200 && (await movedPage.text()).includes("renamed.txt"));
  const cloneOld = gitStatus(["clone", "-q", `${ORIGIN}/r/${NAMES.old}.git`, path.join(OUT, "clone-old")]);
  check("clone from the old URL", cloneOld.code === 0 && git(["rev-parse", "HEAD"], { cwd: path.join(OUT, "clone-old") }) === renamedSha, cloneOld.out);
  const oldPage = await fetch(`${ORIGIN}/r/${NAMES.old}`, { redirect: "manual" });
  check("old page URL redirects to the new name", oldPage.status === 302 && oldPage.headers.get("location") === `/r/${NAMES.moved}`, `${oldPage.status} ${oldPage.headers.get("location")}`);

  // 14. Screenshots
  const browserInvite = await createInvite(ids.priv, "Alex");
  const files = await screenshots({ pub: ids.pub }, browserInvite);
  return files;
}

// 15. Cleanup
const cleanups = [];
async function cleanup() {
  try {
    execFileSync("pkill", ["-f", "remote-debugging-port=9333"], { stdio: "ignore" });
  } catch {}
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {}
  }
  await sleep(1000);
  let names = new Set([...Object.values(NAMES), ...storageNames]);
  try {
    for (const r of JSON.parse(wrangler(["artifacts", "repos", "list", "--namespace", NAMESPACE, "--json"]))) {
      if (r.name.startsWith("e2e-")) names.add(r.name);
    }
  } catch (err) {
    console.warn(`could not list Artifacts repos: ${err.message}`);
  }
  for (const name of names) {
    try {
      wrangler(["artifacts", "repos", "delete", name, "--namespace", NAMESPACE, "--force"]);
      console.log(`deleted Artifacts repo ${name}`);
    } catch {
      // A repo that was never created (or already gone) fails to delete; that's fine.
    }
  }
}

let failed = false;
let files = [];
try {
  files = await main();
} catch (err) {
  failed = true;
  console.error(`\nE2E FAILED: ${err.stack ?? err}${err.cause ? `\ncause: ${err.cause.stack ?? err.cause}` : ""}`);
} finally {
  await cleanup();
}
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed${failed ? " (run aborted)" : ""}`);
console.log(`Screenshots: ${SHOTS}${files.length ? ` (${files.length} files)` : ""}`);
process.exit(failed || passed !== checks.length ? 1 : 0);

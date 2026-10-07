type Content = string | Uint8Array;
type Chain = { files: Record<string, Content>; commits?: { message: string; author?: string; authoredAt?: number }[] };
type Seed = {
  defaultBranch?: string;
  tags?: string[]; // tags on an object that is not a commit: listed, but there is nothing to read
  tagged?: Record<string, Chain & { annotated?: boolean }>; // tags on a commit chain of their own
  lastPushAt?: string;
  source?: string;
  branches: Record<string, Chain>;
};
type RepoData = {
  name: string;
  defaultBranch: string;
  remote: string;
  status: "ready" | "importing";
  trees: Map<string, ArtifactsTreeEntry[]>;
  blobs: Map<string, Uint8Array>;
  commits: Map<string, ArtifactsCommitMetadata[]>; // branch name, or "refs/tags/<name>" for a tagged chain -> newest first
  files: Map<string, Map<string, Uint8Array>>; // same keys -> path -> bytes
  tags: string[];
  tagged: Map<string, boolean>; // tag name -> annotated
  lastPushAt: string | null;
  source: string | null;
};

const enc = new TextEncoder();

/** Deterministic fake 40-hex id. */
export function fakeHash(s: string): string {
  let out = "";
  for (let seed = 0; out.length < 40; seed++) {
    let h = 2166136261 ^ seed;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

/** Production-shaped error: name "ArtifactsError" with a string code. */
export function artifactsError(code: string): Error {
  const e = new Error(`fake ${code}`) as Error & { code: string; numericCode: number };
  e.name = "ArtifactsError";
  e.code = code;
  e.numericCode = 0;
  return e;
}

const DEV_MESSAGES: Record<string, string> = {
  NOT_FOUND: "Repository not found: fake.",
  IMPORT_IN_PROGRESS: 'Repository "fake" is currently being imported from "git:https://x". The import is still in progress and the repository is not yet available. Retry after 5 seconds.',
  ALREADY_EXISTS: "repo already exists: fake",
  INVALID_REPO_NAME: "Invalid repo name.",
  INTERNAL_ERROR: "An internal error occurred.",
};

/** wrangler-dev-shaped error (spike finding): plain Error, no code, message prefixed "ArtifactsError: ". */
export function artifactsDevError(code: string): Error {
  return new Error(`ArtifactsError: ${DEV_MESSAGES[code] ?? code}`);
}

export class FakeArtifacts {
  repos = new Map<string, RepoData>();
  failNext: { method: "create" | "import" | "get" | "readFile"; code: string } | null = null;
  tokens: { name: string; scope: string }[] = [];

  /** Alternates error shapes so code under test must handle both (spike finding). */
  private errorCount = 0;
  fail(code: string): Error {
    return code in DEV_MESSAGES && this.errorCount++ % 2 === 0 ? artifactsDevError(code) : artifactsError(code);
  }

  maybeFail(method: string) {
    if (this.failNext?.method === method) {
      const { code } = this.failNext;
      this.failNext = null;
      throw this.fail(code);
    }
  }

  private empty(name: string, defaultBranch: string, status: RepoData["status"]): RepoData {
    return {
      name, defaultBranch, status,
      remote: `https://fake.artifacts.test/git/ns/${name}.git`,
      trees: new Map(), blobs: new Map(), commits: new Map(), files: new Map(),
      tags: [], tagged: new Map(), lastPushAt: null, source: null,
    };
  }

  private result(r: RepoData): ArtifactsCreateRepoResult {
    return { id: fakeHash(`id:${r.name}`), name: r.name, description: null, defaultBranch: r.defaultBranch, remote: r.remote, token: "art_v1_fake?expires=0" };
  }

  async create(name: string, opts?: { setDefaultBranch?: string }) {
    this.maybeFail("create");
    if (this.repos.has(name)) throw this.fail("ALREADY_EXISTS");
    const r = this.empty(name, opts?.setDefaultBranch ?? "main", "ready");
    this.repos.set(name, r);
    return this.result(r);
  }

  async import(params: { source: { url: string; branch?: string }; target: { name: string } }) {
    this.maybeFail("import");
    if (this.repos.has(params.target.name)) throw this.fail("ALREADY_EXISTS");
    const r = this.empty(params.target.name, params.source.branch ?? "main", "importing");
    this.repos.set(r.name, r);
    return this.result(r);
  }

  async get(name: string) {
    this.maybeFail("get");
    const r = this.repos.get(name);
    if (!r) throw this.fail("NOT_FOUND");
    if (r.status === "importing") throw this.fail("IMPORT_IN_PROGRESS");
    return new FakeRepo(r, this);
  }

  async list() {
    return { repos: [...this.repos.values()].map((r) => ({ name: r.name, status: r.status })), total: this.repos.size } as unknown as ArtifactsRepoListResult;
  }

  async delete(name: string) {
    return this.repos.delete(name);
  }

  /** Test helper: mark an import finished. */
  finishImport(name: string) {
    const r = this.repos.get(name);
    if (r) r.status = "ready";
  }

  /** Test helper: create a ready repo with content. */
  seed(name: string, seed: Seed) {
    const r = this.empty(name, seed.defaultBranch ?? "main", "ready");
    Object.assign(r, { tags: seed.tags ?? [], lastPushAt: seed.lastPushAt ?? null, source: seed.source ?? null });
    // One commit chain per branch and per tagged tag; the key also keeps their hashes apart.
    const addChain = (key: string, b: Chain) => {
      const files = new Map<string, Uint8Array>();
      for (const [p, c] of Object.entries(b.files)) files.set(p, typeof c === "string" ? enc.encode(c) : c);
      r.files.set(key, files);
      const root = this.buildTree(r, key, "", files);
      const msgs = b.commits ?? [{ message: "Initial commit" }];
      r.commits.set(key, msgs.map((m, i) => ({
        hash: fakeHash(`commit:${key}:${i}`), treeHash: root, message: m.message,
        author: { name: m.author ?? "Owner", email: "owner@example.com" },
        committer: { name: m.author ?? "Owner", email: "owner@example.com" },
        parents: [], authoredAt: m.authoredAt ?? 1_760_000_000 - i * 3600, committedAt: m.authoredAt ?? 1_760_000_000 - i * 3600,
      })));
    };
    for (const [branch, b] of Object.entries(seed.branches)) addChain(branch, b);
    for (const [tag, t] of Object.entries(seed.tagged ?? {})) {
      addChain(`refs/tags/${tag}`, t);
      r.tagged.set(tag, t.annotated ?? false);
    }
    this.repos.set(name, r);
    return r;
  }

  private buildTree(r: RepoData, branch: string, dir: string, files: Map<string, Uint8Array>): string {
    const prefix = dir ? `${dir}/` : "";
    const entries = new Map<string, ArtifactsTreeEntry>();
    for (const [path, bytes] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        const hash = fakeHash(`blob:${branch}:${path}`);
        r.blobs.set(hash, bytes);
        entries.set(rest, { name: rest, mode: "100644", hash, type: "blob" });
      } else {
        const sub = rest.slice(0, slash);
        if (!entries.has(sub)) entries.set(sub, { name: sub, mode: "40000", hash: this.buildTree(r, branch, prefix + sub, files), type: "tree" });
      }
    }
    const hash = fakeHash(`tree:${branch}:${dir}`);
    r.trees.set(hash, [...entries.values()]);
    return hash;
  }
}

class FakeRepo {
  constructor(private r: RepoData, private parent: FakeArtifacts) {}
  [Symbol.dispose]() {}
  async info(): Promise<ArtifactsRepoInfo> {
    return { id: fakeHash(`id:${this.r.name}`), name: this.r.name, description: null, defaultBranch: this.r.defaultBranch, createdAt: "", updatedAt: "", lastPushAt: this.r.lastPushAt, source: this.r.source, readOnly: false, remote: this.r.remote };
  }
  async createToken(scope: "read" | "write" = "write", ttl = 86400): Promise<ArtifactsCreateTokenResult> {
    this.parent.tokens.push({ name: this.r.name, scope });
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return { id: fakeHash(`tok:${this.parent.tokens.length}`), plaintext: `art_v1_${scope}${this.parent.tokens.length}?expires=${exp}`, scope, expiresAt: new Date(exp * 1000).toISOString() };
  }
  /** Artifacts takes a commit ID. The fake takes nothing else, so a route that passes a name fails its test. */
  private find(ref: string): { key: string; at: number } | null {
    for (const [key, list] of this.r.commits) {
      const at = list.findIndex((c) => c.hash === ref);
      if (at >= 0) return { key, at };
    }
    return null;
  }
  async log(opts: { ref?: string; limit?: number; offset?: number } = {}) {
    const found = opts.ref === undefined ? { key: this.r.defaultBranch, at: 0 } : this.find(opts.ref);
    const list = found ? (this.r.commits.get(found.key) ?? []).slice(found.at) : [];
    const off = opts.offset ?? 0;
    return list.slice(off, off + (opts.limit ?? 50));
  }
  async readTree(hash: string) { return this.r.trees.get(hash) ?? null; }
  async readBlob(hash: string) { const b = this.r.blobs.get(hash); return b ? new Blob([b]) : null; }
  async readCommit(hash: string) {
    for (const list of this.r.commits.values()) { const c = list.find((x) => x.hash === hash); if (c) return c; }
    return null;
  }
  async readFile(args: { ref: string; path: string }) {
    this.parent.maybeFail("readFile");
    const found = this.find(args.ref);
    const b = found && this.r.files.get(found.key)?.get(args.path);
    return b ? new Blob([b], { type: "text/plain;charset=utf-8" }) : null;
  }
  async listTokens() { return { tokens: [], total: 0 }; }
  async revokeToken() { return true; }
  async fork(): Promise<ArtifactsCreateRepoResult> { throw artifactsError("INTERNAL_ERROR"); }
}

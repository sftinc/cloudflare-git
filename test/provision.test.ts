import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { DAY_MS } from "../src/purge";
import { provisionRepo, refreshProvisioning, validateRepoName } from "../src/provision";
import * as repos from "../src/db/repos";
import { FakeArtifacts } from "./helpers/fake-artifacts";

const art = (f: FakeArtifacts) => f as unknown as Artifacts;
const create = (name: string) => ({ kind: "create" as const, name, description: "", defaultBranch: "main" });
afterEach(() => vi.restoreAllMocks());
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});
const imp = (name: string, opts: { url?: string; branch?: string; description?: string } = {}) =>
  ({ kind: "import" as const, name, description: opts.description ?? "", url: opts.url ?? "https://github.com/a/b", branch: opts.branch ?? "" });

describe("validateRepoName", () => {
  it.each([["site", null], ["a", "x"], ["Site", "x"], ["-site", "x"], ["admin", null], ["invite", null], ["static", null], ["my.repo", "x"], ["a".repeat(64), "x"]])(
    "%s", (name, ok) => expect(validateRepoName(name) === null).toBe(ok === null),
  );
});

describe("provisionRepo", () => {
  it("creates in Artifacts and marks the row provisioned", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), { ...create("p1"), defaultBranch: "develop" }, 1, 30);
    expect(r.ok && r.status).toBe("ready");
    if (!r.ok) throw new Error(r.error);
    expect(r.repo.storage_name).toBe(r.repo.id);
    expect(f.repos.get(r.repo.id)?.defaultBranch).toBe("develop");
    expect((await repos.findLiveRepo(env.DB, "p1"))).not.toBeNull();
  });

  it("a failed create gives its name back; resubmitting inserts a fresh row", async () => {
    quiet();
    const f = new FakeArtifacts();
    f.failNext = { method: "create", code: "INTERNAL_ERROR" };
    const first = await provisionRepo(env.DB, art(f), { ...create("p2"), description: "first try" }, 1, 30);
    expect(!first.ok && first.error).toBe("Artifacts couldn't create the repo (INTERNAL_ERROR). Try again.");
    expect(await repos.findRepoByName(env.DB, "p2")).toBeNull();
    const old = (await env.DB.prepare("SELECT * FROM repos WHERE description = 'first try'").first<repos.RepoRow>())!;
    expect([old.name, old.deleted_at, old.provisioned_at]).toEqual([`~${old.id}`, 1, null]);
    const second = await provisionRepo(env.DB, art(f), { ...create("p2"), description: "second try" }, 2, 30);
    if (!second.ok) throw new Error(second.error);
    expect(second.repo.id).not.toBe(old.id);
    expect(second.repo.storage_name).not.toBe(old.storage_name);
    expect(second.repo.description).toBe("second try");
  });

  it("ALREADY_EXISTS from Artifacts is a failure, not a success", async () => {
    quiet();
    const f = new FakeArtifacts();
    f.failNext = { method: "create", code: "ALREADY_EXISTS" };
    const r = await provisionRepo(env.DB, art(f), create("p3"), 1, 30);
    expect(r.ok).toBe(false);
    expect(await repos.findRepoByName(env.DB, "p3")).toBeNull();
  });

  it("stores a new repo under its id, so an old repo's storage name doesn't block the name", async () => {
    const f = new FakeArtifacts();
    // renamed before storage names were ids: its files are still under its first name
    await env.DB.prepare("INSERT INTO repos (id, name, storage_name, created_at, updated_at) VALUES ('x1', 'new-name', 'old-name', 1, 1)").run();
    const r = await provisionRepo(env.DB, art(f), create("old-name"), 2, 30);
    if (!r.ok) throw new Error(r.error);
    expect(r.repo.storage_name).toBe(r.repo.id);
    expect(f.repos.has(r.repo.id)).toBe(true);
    expect(f.repos.has("old-name")).toBe(false);
  });

  it("rejects names used by provisioned or deleted repos", async () => {
    const f = new FakeArtifacts();
    await provisionRepo(env.DB, art(f), create("p4"), 1, 30);
    const dup = await provisionRepo(env.DB, art(f), create("p4"), 2, 30);
    expect(dup.ok).toBe(false);
    const row = (await repos.findRepoByName(env.DB, "p4"))!;
    await repos.setDeleted(env.DB, row.id, true, 3);
    const del = await provisionRepo(env.DB, art(f), create("p4"), 4, 30);
    expect(!del.ok && del.restoreId).toBe(row.id);
  });

  it("offers Restore only inside the window; past it the name is being purged", async () => {
    const f = new FakeArtifacts();
    const made = await provisionRepo(env.DB, art(f), create("p13"), 1, 30);
    if (!made.ok) throw new Error(made.error);
    await repos.setDeleted(env.DB, made.repo.id, true, 2);
    const purging = { ok: false, error: 'A deleted repo named "p13" is being permanently deleted. Pick another name, or try again tomorrow.' };
    const inside = await provisionRepo(env.DB, art(f), create("p13"), 2 + 30 * DAY_MS - 1, 30);
    expect(!inside.ok && [inside.error, inside.restoreId]).toEqual(['A deleted repo named "p13" exists. Restore it instead.', made.repo.id]);
    expect(await provisionRepo(env.DB, art(f), create("p13"), 2 + 30 * DAY_MS, 30)).toEqual(purging);
    expect(await provisionRepo(env.DB, art(f), imp("p13"), 2 + 30 * DAY_MS, 30)).toEqual(purging);
    expect(await provisionRepo(env.DB, art(f), create("p13"), 3, 0)).toEqual(purging);
    expect(await provisionRepo(env.DB, art(f), create("p13"), 2 + 7 * DAY_MS, 7)).toEqual(purging);
    expect((await repos.findRepoByName(env.DB, "p13"))!.id).toBe(made.repo.id);
  });

  it("refuses import URLs with credentials and clears them", async () => {
    const r = await provisionRepo(env.DB, art(new FakeArtifacts()), { kind: "import", name: "p5", description: "", url: "https://user:tok@github.com/a/b", branch: "" }, 1, 30);
    expect(!r.ok && r.clearUrl).toBe(true);
    expect(await repos.findRepoByName(env.DB, "p5")).toBeNull();
  });

  it("imports stay pending until Artifacts is ready", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), { kind: "import", name: "p6", description: "", url: "https://github.com/a/b", branch: "" }, 1, 30);
    expect(r.ok && r.status).toBe("pending");
    const row = (await repos.findRepoByName(env.DB, "p6"))!;
    f.finishImport(row.storage_name);
    expect(await refreshProvisioning(env.DB, art(f), row, 2)).toBe("ready");
    expect((await repos.findLiveRepo(env.DB, "p6"))).not.toBeNull();
  });

  it("a pending import holds its name", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), imp("p8"), 1, 30);
    expect(r.ok && r.status).toBe("pending");
    const again = await provisionRepo(env.DB, art(f), create("p8"), 2, 30);
    expect(!again.ok && again.error).toBe('"p8" is still being imported.');
  });

  it("a refresh while a create is still running changes nothing", async () => {
    const row = await repos.insertRepo(env.DB, { name: "p12", description: null }, 1); // inserted; Artifacts not called yet
    expect(await refreshProvisioning(env.DB, art(new FakeArtifacts()), row, 2)).toBe("missing");
    expect(await repos.findRepoById(env.DB, row.id)).toEqual(row);
  });

  it("a retry after Artifacts created the first attempt never reuses its storage", async () => {
    quiet();
    const f = new FakeArtifacts();
    f.failNext = { method: "get", code: "INTERNAL_ERROR" }; // the import started, then the check failed
    const one = "https://example.com/one.git";
    expect((await provisionRepo(env.DB, art(f), imp("p9", { url: one, description: one }), 1, 30)).ok).toBe(false);
    const first = (await env.DB.prepare("SELECT * FROM repos WHERE description = ?").bind(one).first<repos.RepoRow>())!;
    expect(f.repos.has(first.storage_name)).toBe(true); // left behind in Artifacts
    const second = await provisionRepo(env.DB, art(f), imp("p9", { url: "https://example.com/two.git" }), 2, 30);
    if (!second.ok) throw new Error(second.error);
    expect(second.repo.id).not.toBe(first.id);
    expect(second.repo.storage_name).not.toBe(first.storage_name);
  });

  it("a create racing another with the same name gets the already-exists error", async () => {
    const f = new FakeArtifacts();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((q: string) => {
      if (!q.startsWith("SELECT a.repo_id")) return prepare(q);
      // the alias check runs after the name check: the other request inserts its row then
      const other = prepare("INSERT INTO repos (id, name, storage_name, created_at, updated_at) VALUES ('race1', 'p14', 'race1', 1, 1)");
      return { bind: (...args: unknown[]) => ({ first: async () => (await other.run(), prepare(q).bind(...args).first()) }) } as never;
    });
    const r = await provisionRepo(env.DB, art(f), create("p14"), 2, 30);
    expect(r).toEqual({ ok: false, error: 'A repo named "p14" already exists.' });
    expect((await repos.findRepoByName(env.DB, "p14"))!.id).toBe("race1");
  });

  it("a create Artifacts didn't confirm is a failure that gives the name back", async () => {
    const f = new FakeArtifacts();
    vi.spyOn(f, "create").mockResolvedValue({} as never); // returned, but nothing is there
    const r = await provisionRepo(env.DB, art(f), create("p15"), 1, 30);
    expect(r).toEqual({ ok: false, error: "Artifacts didn't confirm the repo was created. Try again." });
    expect(await repos.findRepoByName(env.DB, "p15")).toBeNull();
  });

  it("names the branch when an import with a branch finds nothing", async () => {
    quiet();
    const f = new FakeArtifacts();
    f.failNext = { method: "import", code: "NOT_FOUND" };
    const withBranch = await provisionRepo(env.DB, art(f), imp("p10", { branch: "dev" }), 1, 30);
    expect(!withBranch.ok && withBranch.error).toBe('Nothing was found at that URL, or it has no branch "dev".');
    f.failNext = { method: "import", code: "NOT_FOUND" };
    const without = await provisionRepo(env.DB, art(f), imp("p11"), 1, 30);
    expect(!without.ok && without.error).toBe("No repository was found at that URL.");
  });
});

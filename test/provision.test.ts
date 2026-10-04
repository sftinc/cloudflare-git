import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { provisionRepo, refreshProvisioning, validateRepoName } from "../src/provision";
import * as repos from "../src/db/repos";
import { FakeArtifacts } from "./helpers/fake-artifacts";

const art = (f: FakeArtifacts) => f as unknown as Artifacts;
const create = (name: string) => ({ kind: "create" as const, name, description: "", defaultBranch: "main" });

describe("validateRepoName", () => {
  it.each([["site", null], ["a", "x"], ["Site", "x"], ["-site", "x"], ["admin", "x"], ["invite", "x"], ["static", "x"], ["my.repo", "x"], ["a".repeat(64), "x"]])(
    "%s", (name, ok) => expect(validateRepoName(name) === null).toBe(ok === null),
  );
});

describe("provisionRepo", () => {
  it("creates in Artifacts and marks the row provisioned", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), { ...create("p1"), defaultBranch: "develop" }, 1);
    expect(r.ok && r.status).toBe("ready");
    expect(f.repos.get("p1")?.defaultBranch).toBe("develop");
    expect((await repos.findLiveRepo(env.DB, "p1"))).not.toBeNull();
  });

  it("a failed create leaves an unprovisioned row; resubmitting reuses it", async () => {
    const f = new FakeArtifacts();
    f.failNext = { method: "create", code: "INTERNAL_ERROR" };
    const first = await provisionRepo(env.DB, art(f), create("p2"), 1);
    expect(first.ok).toBe(false);
    const row = (await repos.findRepoByName(env.DB, "p2"))!;
    expect(row.provisioned_at).toBeNull();
    const second = await provisionRepo(env.DB, art(f), create("p2"), 2);
    expect(second.ok && second.repo.id).toBe(row.id);
  });

  it("treats ALREADY_EXISTS on resubmit as success", async () => {
    const f = new FakeArtifacts();
    await repos.insertRepo(env.DB, { name: "p3", description: null }, 1); // earlier attempt reached D1 only
    await f.create("p3"); // ...and Artifacts
    const r = await provisionRepo(env.DB, art(f), create("p3"), 2);
    expect(r.ok && r.status).toBe("ready");
  });

  it("rejects names used by provisioned or deleted repos, and reserved names", async () => {
    const f = new FakeArtifacts();
    await provisionRepo(env.DB, art(f), create("p4"), 1);
    const dup = await provisionRepo(env.DB, art(f), create("p4"), 2);
    expect(dup.ok).toBe(false);
    const row = (await repos.findRepoByName(env.DB, "p4"))!;
    await repos.setDeleted(env.DB, row.id, true, 3);
    const del = await provisionRepo(env.DB, art(f), create("p4"), 4);
    expect(!del.ok && del.restoreId).toBe(row.id);
    expect((await provisionRepo(env.DB, art(f), create("admin"), 5)).ok).toBe(false);
  });

  it("refuses import URLs with credentials and clears them", async () => {
    const r = await provisionRepo(env.DB, art(new FakeArtifacts()), { kind: "import", name: "p5", description: "", url: "https://user:tok@github.com/a/b", branch: "" }, 1);
    expect(!r.ok && r.clearUrl).toBe(true);
    expect(await repos.findRepoByName(env.DB, "p5")).toBeNull();
  });

  it("imports stay pending until Artifacts is ready", async () => {
    const f = new FakeArtifacts();
    const r = await provisionRepo(env.DB, art(f), { kind: "import", name: "p6", description: "", url: "https://github.com/a/b", branch: "" }, 1);
    expect(r.ok && r.status).toBe("pending");
    const row = (await repos.findRepoByName(env.DB, "p6"))!;
    f.finishImport("p6");
    expect(await refreshProvisioning(env.DB, art(f), row, 2)).toBe("ready");
    expect((await repos.findLiveRepo(env.DB, "p6"))).not.toBeNull();
  });
});

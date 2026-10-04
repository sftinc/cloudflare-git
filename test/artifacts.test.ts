import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError, artifactsErrorCode, clearArtifactsCaches, getRepoAccess, listBranches } from "../src/artifacts";
import { FakeArtifacts, artifactsDevError, artifactsError } from "./helpers/fake-artifacts";
import { stubArtifactsGit, stubFetch } from "./helpers/git-http";

beforeEach(() => clearArtifactsCaches());
afterEach(() => vi.restoreAllMocks());

const asArt = (f: FakeArtifacts) => f as unknown as Artifacts;

describe("getRepoAccess", () => {
  it("caches tokens per repo and scope, and renews near expiry", async () => {
    const fake = new FakeArtifacts();
    fake.seed("site", { branches: { main: { files: { "a.txt": "a" } } } });
    const now = Date.now();
    const a = await getRepoAccess(asArt(fake), "site", "read", now);
    const b = await getRepoAccess(asArt(fake), "site", "read", now + 60_000);
    expect(b.token).toBe(a.token);
    expect(a.remote).toBe("https://fake.artifacts.test/git/ns/site.git");
    await getRepoAccess(asArt(fake), "site", "write", now);
    expect(fake.tokens.map((t) => t.scope)).toEqual(["read", "write"]);
    await getRepoAccess(asArt(fake), "site", "read", now + 14 * 60_000); // < 2 min left
    expect(fake.tokens).toHaveLength(3);
  });
});

describe("listBranches", () => {
  it("returns branches with HEAD first", async () => {
    const fake = new FakeArtifacts();
    fake.seed("site", { defaultBranch: "main", branches: { "feature/x": { files: { a: "1" } }, main: { files: { a: "1" } } } });
    stubArtifactsGit(fake);
    expect(await listBranches(asArt(fake), "site")).toEqual({ branches: ["main", "feature/x"], head: "main" });
  });
  it("throws UpstreamError on a failed advertisement", async () => {
    const fake = new FakeArtifacts();
    fake.seed("site", { branches: { main: { files: { a: "1" } } } });
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(listBranches(asArt(fake), "site")).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("artifactsErrorCode", () => {
  it("reads codes from production-shaped errors", () => {
    expect(artifactsErrorCode(artifactsError("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(artifactsErrorCode(new Error("x"))).toBeNull();
    expect(artifactsErrorCode("x")).toBeNull();
  });
  it.each(["NOT_FOUND", "IMPORT_IN_PROGRESS", "ALREADY_EXISTS", "INVALID_REPO_NAME", "INTERNAL_ERROR"])(
    "maps the wrangler-dev message for %s",
    (code) => expect(artifactsErrorCode(artifactsDevError(code))).toBe(code),
  );
  it("maps other observed messages", () => {
    expect(artifactsErrorCode(new Error("ArtifactsError: Invalid source.url: must be an HTTPS URL."))).toBe("INVALID_INPUT");
    expect(artifactsErrorCode(new Error("ArtifactsError: something new"))).toBe("UNKNOWN");
  });
});

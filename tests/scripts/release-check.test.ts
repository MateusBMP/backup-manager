import { afterEach, describe, expect, test, vi } from "vitest";
import {
  compareVersions,
  decideRelease,
  fetchPublished,
  parseVersion,
  remoteTagExists,
} from "../../scripts/release-check.js";

describe("compareVersions", () => {
  test("orders by semver precedence", () => {
    const ordered = [
      "0.9.9",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions("1.2.3", "1.2.3+build.5")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });

  test("rejects invalid versions", () => {
    expect(() => parseVersion("1.2")).toThrow(/not a semver/);
    expect(() => parseVersion("v1.2.3")).toThrow(/not a semver/);
  });
});

describe("decideRelease", () => {
  const onNpm = { published: ["0.1.0", "0.1.1"], latest: "0.1.1", tagged: false };

  test("a package that is not on npm yet is left to a manual first publish", () => {
    expect(decideRelease("0.1.1", { published: [], tagged: false })).toMatchObject({
      stage: false,
      reason: expect.stringContaining("manually"),
    });
  });

  test("a bump over latest is staged", () => {
    expect(decideRelease("0.2.0", onNpm)).toEqual({
      stage: true,
      tag: "latest",
      reason: "0.2.0 > 0.1.1 (dist-tag latest)",
    });
  });

  test("an unchanged version is skipped", () => {
    expect(decideRelease("0.1.1", onNpm)).toMatchObject({
      stage: false,
      reason: "0.1.1 is already published",
    });
  });

  test("an already staged (tagged) version is skipped", () => {
    expect(decideRelease("0.2.0", { ...onNpm, tagged: true })).toMatchObject({
      stage: false,
      reason: "v0.2.0 is already tagged (staged or released)",
    });
  });

  test("a downgrade is skipped", () => {
    expect(decideRelease("0.1.0-rc.1", { ...onNpm, published: ["0.1.1"] })).toMatchObject({
      stage: false,
      reason: expect.stringContaining("not greater"),
    });
  });

  test("a prerelease is staged under next", () => {
    expect(decideRelease("0.2.0-beta.1", onNpm)).toMatchObject({ stage: true, tag: "next" });
  });

  test("a package without a latest dist-tag still stages", () => {
    expect(decideRelease("1.0.0", { published: ["1.0.0-rc.1"], tagged: false })).toEqual({
      stage: true,
      tag: "latest",
      reason: "new version (dist-tag latest)",
    });
  });
});

describe("remoteTagExists", () => {
  test("asks origin for the exact tag ref", () => {
    const run = vi.fn((_args: string[]) => "abc123\trefs/tags/v1.0.0\n");
    expect(remoteTagExists("v1.0.0", run)).toBe(true);
    expect(run).toHaveBeenCalledWith(["ls-remote", "--tags", "origin", "refs/tags/v1.0.0"]);
    expect(remoteTagExists("v1.0.1", () => "")).toBe(false);
  });
});

describe("fetchPublished", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reads versions and the latest dist-tag, escaping the scope", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            versions: { "0.1.0": {}, "0.1.1": {} },
            "dist-tags": { latest: "0.1.1" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPublished("@scope/pkg", "https://reg.example/")).resolves.toEqual({
      versions: ["0.1.0", "0.1.1"],
      latest: "0.1.1",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://reg.example/@scope%2fpkg", expect.anything());
  });

  test("treats 404 as an unpublished package and fails on other errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(fetchPublished("@scope/pkg")).resolves.toEqual({ versions: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    await expect(fetchPublished("@scope/pkg")).rejects.toThrow(/503/);
  });
});

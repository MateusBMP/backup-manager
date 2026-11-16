import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { archVersion, debianVersion } from "../../scripts/release-bump.js";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  engines: { node: string };
  dependencies: Record<string, string>;
};

describe("distribution packages", () => {
  test("PKGBUILD, debian/changelog and the lock carry package.json's version", () => {
    expect(/^pkgver=(.*)$/m.exec(read("packaging/arch/PKGBUILD"))?.[1]).toBe(
      archVersion(pkg.version),
    );
    expect(/^backup-manager \(([^)]+)\)/.exec(read("packaging/debian/changelog"))?.[1]).toBe(
      debianVersion(pkg.version),
    );
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.version).toBe(pkg.version);
  });

  test("the packages need the Node.js that package.json needs", () => {
    const major = /^>=(\d+)$/.exec(pkg.engines.node)?.[1];
    expect(major).toBeDefined();
    expect(read("packaging/debian/control")).toContain(`nodejs (>= ${major})`);
    expect(read("packaging/arch/PKGBUILD")).toContain(`depends=('nodejs>=${major}')`);
    expect(read("tests/ci/package.sh")).toContain(`-lt ${major} ]]`);
  });

  test("the Makefile installs the bundle and the release files it names exist", () => {
    const makefile = read("Makefile");
    expect(makefile).toContain("ln -sfn ../lib/$(NAME)/dist/cli.js");
    for (const file of ["LICENSE", "NOTICE", "README.md", "config.example.json"]) {
      expect(makefile).toContain(file);
      expect(read(file).length).toBeGreaterThan(0);
    }
    // Every distribution built for a release is one the CI package job tests.
    const ci = read(".github/workflows/ci.yml");
    const build = read("scripts/release-build.sh");
    for (const [, distro, image] of build.matchAll(/\[(\w+)\]=([\w.:]+)/g)) {
      expect(ci).toContain(`distro: ${distro}, image: "${image}"`);
    }
  });
});

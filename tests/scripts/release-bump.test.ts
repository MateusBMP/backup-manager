import { describe, expect, test } from "vitest";
import {
  addChangelogSection,
  archVersion,
  bumpVersion,
  CHANGELOG_HEAD,
  debianDate,
  debianEntry,
  debianVersion,
  isPrerelease,
  notesBullets,
  refusal,
  setJsonVersion,
  setPkgbuildVersion,
  wrap,
} from "../../scripts/release-bump.js";

const NOTES = `### Added
- Packages for Debian, Ubuntu and Arch; see the
  [Installation](https://example.org/wiki) page.
- \`bkm --version\` prints the **licence**.

### Fixed
- One fix.
`;

describe("release-bump", () => {
  test("bumps the last release and maps versions for Debian and Arch", () => {
    expect(bumpVersion("0.3.1", "patch")).toBe("0.3.2");
    expect(bumpVersion("0.3.1", "minor")).toBe("0.4.0");
    expect(bumpVersion("0.3.1", "major")).toBe("1.0.0");
    expect(bumpVersion("1.2.3-rc.1", "patch")).toBe("1.2.4");
    expect(isPrerelease("1.0.0-rc.1")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
    expect(debianVersion("1.0.0-rc.1")).toBe("1.0.0~rc.1");
    expect(debianVersion("1.0.0")).toBe("1.0.0");
    expect(archVersion("1.0.0-rc.1")).toBe("1.0.0rc.1");
  });

  test("reads the bullets of the notes without Markdown marks", () => {
    expect(notesBullets(NOTES)).toEqual([
      "Packages for Debian, Ubuntu and Arch; see the Installation page.",
      "bkm --version prints the licence.",
      "One fix.",
    ]);
    expect(notesBullets("no bullets\n")).toEqual([]);
  });

  test("wraps a bullet for debian/changelog", () => {
    expect(wrap("aaa bbb ccc", 9, "  * ", "    ")).toEqual(["  * aaa", "    bbb", "    ccc"]);
    expect(wrap("a-very-long-word b", 6, "* ", "  ")).toEqual(["* a-very-long-word", "  b"]);
  });

  test("sets the version in package.json, the lock and the PKGBUILD", () => {
    const lock = `{\n  "name": "x",\n  "version": "0.3.1",\n  "packages": {\n    "": {\n      "version": "0.3.1"\n    },\n    "node_modules/a": {\n      "version": "9.9.9"\n    }\n  }\n}\n`;
    const next = setJsonVersion(lock, "0.4.0", 2);
    expect(next.match(/"version": "0\.4\.0"/g)).toHaveLength(2);
    expect(next).toContain('"version": "9.9.9"');
    expect(() => setJsonVersion("{}", "1.0.0", 1)).toThrow(/expected 1/);
    expect(setPkgbuildVersion("pkgver=0.3.1\npkgrel=3\n", "1.0.0-rc.1")).toBe(
      "pkgver=1.0.0rc.1\npkgrel=1\n",
    );
    expect(() => setPkgbuildVersion("pkgname=x\n", "1.0.0")).toThrow(/pkgver/);
  });

  test("writes a debian/changelog entry", () => {
    const when = new Date(Date.UTC(2026, 10, 16, 12, 0, 0));
    expect(debianDate(when)).toBe("Mon, 16 Nov 2026 12:00:00 +0000");
    expect(debianEntry("1.0.0-rc.1", ["One.", "Two."], "Me <me@example.org>", when)).toBe(
      [
        "backup-manager (1.0.0~rc.1) unstable; urgency=medium",
        "",
        "  * One.",
        "  * Two.",
        "",
        " -- Me <me@example.org>  Mon, 16 Nov 2026 12:00:00 +0000",
        "",
        "",
      ].join("\n"),
    );
  });

  test("adds changelog sections newest first, with their links last", () => {
    const first = addChangelogSection(null, "0.4.0", "2026-11-16", NOTES);
    expect(first.startsWith(CHANGELOG_HEAD)).toBe(true);
    expect(first).toContain("## [0.4.0] - 2026-11-16\n\n### Added\n- Packages");
    expect(
      first.endsWith(
        "\n\n[0.4.0]: https://github.com/MateusBMP/backup-manager/releases/tag/v0.4.0\n",
      ),
    ).toBe(true);
    const second = addChangelogSection(first, "0.5.0", "2026-12-01", "### Fixed\n- Later.\n");
    expect(second.indexOf("## [0.5.0]")).toBeLessThan(second.indexOf("## [0.4.0]"));
    expect(second).toMatch(/\[0\.4\.0\]: https:.*\n\[0\.5\.0\]: https:.*\n$/);
    expect(second.match(/^# Changelog$/gm)).toHaveLength(1);
  });

  test("refuses versions that are not new", () => {
    const state = { current: "0.3.1", lastRelease: "0.3.1", changelog: "## [0.3.0] - x\n" };
    expect(refusal("0.4.0", state)).toBeNull();
    expect(refusal("0.3.1", state)).toMatch(/not newer than the last release/);
    expect(refusal("0.3.0", { current: "0.3.1", changelog: null })).toMatch(/older than the tree/);
    expect(refusal("0.3.1", { current: "0.3.1", changelog: null })).toBeNull();
    expect(refusal("0.4.0", { ...state, changelog: "## [0.4.0] - x\n" })).toMatch(/already has/);
    expect(() => refusal("1.2", state)).toThrow(/not a semver version/);
  });
});

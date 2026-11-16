import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  COPYRIGHT,
  DOCS_URL,
  helpNotice,
  LICENSE_ID,
  LICENSE_URL,
  uiNotice,
  versionText,
} from "../../src/legal.js";
import { VERSION } from "../../src/version.js";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

describe("licence notices", () => {
  test("--version text is GNU style: version, copyright, licence, no warranty", () => {
    const lines = versionText("bkm").split("\n");
    expect(lines[0]).toBe(`bkm (backup-manager) ${VERSION}`);
    expect(lines[1]).toBe(COPYRIGHT);
    expect(lines[2]).toBe(`License GPLv3: GNU GPL version 3 only <${LICENSE_URL}>.`);
    expect(lines.join("\n")).toContain("free to change and redistribute it");
    expect(lines.at(-1)).toBe("There is NO WARRANTY, to the extent permitted by law.");
  });

  test("the help notice and the UI notice name the licence and the missing warranty", () => {
    const help = helpNotice();
    expect(help).toContain(COPYRIGHT);
    expect(help).toContain("GNU GPL version 3 only");
    expect(help).toContain("NO WARRANTY");
    expect(help).toContain(DOCS_URL);
    const [about, licence] = uiNotice();
    expect(about).toBe(`backup-manager ${VERSION} · ${COPYRIGHT}`);
    expect(licence).toContain(LICENSE_ID);
    expect(licence).toContain("NO WARRANTY");
    // The help overlay is 64 columns wide: 58 inside its border and padding.
    expect(Math.max(about.length, licence.length)).toBeLessThanOrEqual(58);
  });

  test("LICENSE, NOTICE, package.json and the packages agree with the notices", () => {
    const license = read("LICENSE");
    expect(license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 29 June 2007");
    const notice = read("NOTICE");
    expect(notice).toContain(COPYRIGHT);
    expect(notice).toContain("GNU General Public License, version 3 only");
    expect(notice).toContain("WITHOUT\nANY WARRANTY");

    const pkg = JSON.parse(read("package.json")) as { license: string; files: string[] };
    expect(pkg.license).toBe(LICENSE_ID);
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]));
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { license?: string }>;
    };
    expect(lock.packages[""]?.license).toBe(LICENSE_ID);

    expect(read("packaging/arch/PKGBUILD")).toMatch(/^license=\('GPL-3\.0-only'/m);
    const copyright = read("packaging/debian/copyright");
    expect(copyright).toContain(`Files: *\nCopyright: 2026 MateusBMP\nLicense: ${LICENSE_ID}`);
    expect(read("README.md")).toContain(`\`${LICENSE_ID}\``);
    expect(read("tsup.config.ts")).toContain(`SPDX-License-Identifier: ${LICENSE_ID}`);
  });
});

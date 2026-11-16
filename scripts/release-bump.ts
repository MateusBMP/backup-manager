/**
 * Sets the release version everywhere it is written, and adds the release notes.
 *
 *   npm run release:bump -- VERSION --notes NOTES.md [--date YYYY-MM-DD]
 *   npm run release:bump -- --current        print the version and the last tag
 *
 * VERSION is semver (1.2.3, 1.2.3-rc.1, 1.2.3-beta.1), or `patch`, `minor` or `major`
 * to bump the last release (the newest `v*` tag; without one, package.json's version).
 * NOTES.md is the release's changelog in Markdown: "### Heading" sections of "- item"
 * bullets (continuation lines indented by two spaces).
 *
 * Changes:
 *   package.json, package-lock.json   version
 *   packaging/arch/PKGBUILD           pkgver (pkgrel back to 1)
 *   packaging/debian/changelog        a new entry from the bullets
 *   CHANGELOG.md                      a "## [VERSION] - DATE" section with the notes
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions, parseVersion } from "./release-check.js";

export const REPO_URL = "https://github.com/MateusBMP/backup-manager";
export const DEB_NAME = "backup-manager";
export const CHANGELOG_HEAD = `# Changelog

All notable changes to backup-manager. Versions follow [Semantic Versioning](https://semver.org/).
The Debian package spells a pre-release with \`~\` (1.0.0-rc.1 is 1.0.0~rc.1); the Arch package
drops the hyphen (1.0.0rc.1).
`;

export type Bump = "patch" | "minor" | "major";
const BUMPS: readonly string[] = ["patch", "minor", "major"];

/** The version a `patch`, `minor` or `major` bump of `base` gives (a pre-release suffix is dropped). */
export function bumpVersion(base: string, bump: Bump): string {
  const [major, minor, patch] = parseVersion(base).core;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).pre.length > 0;
}

/** Debian sorts `~` before everything, so 1.0.0~rc.1 is older than 1.0.0. */
export function debianVersion(version: string): string {
  return version.replace("-", "~");
}

/** pacman allows no hyphen in pkgver; 1.0.0rc.1 is older than 1.0.0 for vercmp. */
export function archVersion(version: string): string {
  return version.replace("-", "");
}

/** The "- item" bullets of the notes: continuation lines joined, Markdown links and marks dropped. */
export function notesBullets(notes: string): string[] {
  const items: string[] = [];
  for (const line of notes.split("\n")) {
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
    else if (line.startsWith("  ") && line.trim() && items.length > 0) {
      items[items.length - 1] += ` ${line.trim()}`;
    }
  }
  return items.map((item) =>
    item
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`/g, "")
      .replace(/\*\*/g, ""),
  );
}

/** Greedy word wrap; a word longer than the width stays whole. */
export function wrap(text: string, width: number, first: string, rest: string): string[] {
  const lines: string[] = [];
  let current = first;
  let empty = true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!empty && current.length + 1 + word.length > width) {
      lines.push(current);
      current = rest + word;
    } else {
      current += empty ? word : ` ${word}`;
    }
    empty = false;
  }
  lines.push(current);
  return lines;
}

/** `"version": "…"` of the package itself: the first one in package.json, the first two in the lock. */
export function setJsonVersion(text: string, version: string, count: 1 | 2): string {
  let left = count;
  const next = text.replace(/^(\s*"version": ")[^"]*(")/gm, (match, a: string, b: string) =>
    left-- > 0 ? `${a}${version}${b}` : match,
  );
  if (left > 0) throw new Error(`expected ${count} "version" field(s)`);
  return next;
}

export function setPkgbuildVersion(text: string, version: string): string {
  if (!/^pkgver=/m.test(text) || !/^pkgrel=/m.test(text)) {
    throw new Error("PKGBUILD has no pkgver or pkgrel");
  }
  return text
    .replace(/^pkgver=.*$/m, `pkgver=${archVersion(version)}`)
    .replace(/^pkgrel=.*$/m, "pkgrel=1");
}

/** RFC 5322 date in UTC, as debian/changelog wants it. */
export function debianDate(when: Date): string {
  return when.toUTCString().replace("GMT", "+0000");
}

export function debianEntry(
  version: string,
  bullets: readonly string[],
  maintainer: string,
  when: Date,
): string {
  const lines = [`${DEB_NAME} (${debianVersion(version)}) unstable; urgency=medium`, ""];
  for (const bullet of bullets) lines.push(...wrap(bullet, 78, "  * ", "    "));
  lines.push("", ` -- ${maintainer}  ${debianDate(when)}`, "");
  return `${lines.join("\n")}\n`;
}

/** Adds the section above the newest one and its link below the others. `null`: a new file. */
export function addChangelogSection(
  current: string | null,
  version: string,
  day: string,
  notes: string,
): string {
  const text = current ?? CHANGELOG_HEAD;
  const section = `## [${version}] - ${day}\n\n${notes.trim()}\n\n`;
  const at = text.search(/^## \[/m);
  const body =
    at >= 0 ? text.slice(0, at) + section + text.slice(at) : `${text.trimEnd()}\n\n${section}`;
  const link = `[${version}]: ${REPO_URL}/releases/tag/v${version}\n`;
  return `${body.trimEnd()}\n${body.includes("]: http") ? "" : "\n"}${link}`;
}

export interface BumpCheck {
  /** version in package.json */
  current: string;
  /** version of the newest `v*` tag, if any */
  lastRelease?: string;
  changelog: string | null;
}

/** Why `version` cannot be released, or null. */
export function refusal(version: string, state: BumpCheck): string | null {
  parseVersion(version);
  if (state.lastRelease && compareVersions(version, state.lastRelease) <= 0) {
    return `${version} is not newer than the last release ${state.lastRelease}`;
  }
  if (compareVersions(version, state.current) < 0) {
    return `${version} is older than the tree's version ${state.current}`;
  }
  if (state.changelog?.includes(`## [${version}]`)) return `CHANGELOG.md already has ${version}`;
  return null;
}

const root = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));

function lastTag(): string {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
      cwd: root("."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function fail(message: string): never {
  console.error(`release-bump: ${message}`);
  process.exit(1);
}

function main(argv: string[]): void {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && !["--notes", "--date"].includes(argv[i - 1] ?? ""),
  );
  const current = (JSON.parse(readFileSync(root("package.json"), "utf8")) as { version: string })
    .version;
  const tag = lastTag();
  if (argv.includes("--current")) {
    console.log(`version ${current}\nlast tag ${tag || "(none)"}`);
    return;
  }
  const wanted = positional[0];
  const notesFile = flag("--notes");
  if (!wanted || !notesFile) fail("usage: release-bump VERSION|patch|minor|major --notes NOTES.md");
  const lastRelease = tag ? tag.slice(1) : undefined;
  let version: string;
  try {
    version = BUMPS.includes(wanted)
      ? bumpVersion(lastRelease ?? current, wanted as Bump)
      : wanted.replace(/^v/, "");
    const changelog = existsSync(root("CHANGELOG.md"))
      ? readFileSync(root("CHANGELOG.md"), "utf8")
      : null;
    const no = refusal(version, { current, ...(lastRelease ? { lastRelease } : {}), changelog });
    if (no) fail(no);
    const notes = readFileSync(notesFile, "utf8");
    const bullets = notesBullets(notes);
    if (bullets.length === 0) fail("the notes have no '- ' bullets");
    const now = new Date();
    now.setMilliseconds(0);
    const day = flag("--date") ?? now.toISOString().slice(0, 10);
    const control = readFileSync(root("packaging/debian/control"), "utf8");
    const maintainer = /^Maintainer: (.+)$/m.exec(control)?.[1]?.trim();
    if (!maintainer) fail("packaging/debian/control has no Maintainer");

    const edit = (file: string, change: (text: string) => string) =>
      writeFileSync(root(file), change(readFileSync(root(file), "utf8")));
    edit("package.json", (t) => setJsonVersion(t, version, 1));
    edit("package-lock.json", (t) => setJsonVersion(t, version, 2));
    edit("packaging/arch/PKGBUILD", (t) => setPkgbuildVersion(t, version));
    edit("packaging/debian/changelog", (t) => debianEntry(version, bullets, maintainer, now) + t);
    writeFileSync(root("CHANGELOG.md"), addChangelogSection(changelog, version, day, notes));
    console.log(
      `${current} -> ${version} (debian ${debianVersion(version)}, arch ${archVersion(version)}); ${bullets.length} changelog items`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

/**
 * Decides whether CI should stage the current package.json version on npm
 * (`npm stage publish`; a maintainer then approves it with `npm stage approve`).
 *
 *   npm run release:check
 *
 * Staged versions are not visible in the public registry document, so the `v<version>` git tag
 * that CI pushes right after staging marks a version as handled.
 *
 * Prints the decision and, on GitHub Actions, appends `stage`, `tag` and `version` to
 * $GITHUB_OUTPUT. Never fails just because there is nothing to stage.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface ReleaseDecision {
  stage: boolean;
  tag: "latest" | "next";
  reason: string;
}

interface SemVer {
  core: [number, number, number];
  pre: string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(version: string): SemVer {
  const m = SEMVER.exec(version.trim());
  if (!m) throw new Error(`not a semver version: ${JSON.stringify(version)}`);
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = va.core[i]! - vb.core[i]!;
    if (d !== 0) return Math.sign(d);
  }
  // A release has higher precedence than any of its prereleases.
  if (va.pre.length === 0) return vb.pre.length === 0 ? 0 : 1;
  if (vb.pre.length === 0) return -1;
  const n = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const d = compareIdentifiers(x, y);
    if (d !== 0) return d;
  }
  return 0;
}

export interface ReleaseState {
  /** every version already on the registry (empty for a package that does not exist yet) */
  published: readonly string[];
  /** the registry's `latest` dist-tag, if any */
  latest?: string;
  /** whether the `v<version>` git tag already exists (the version was staged or released) */
  tagged: boolean;
}

/** @param local version in package.json */
export function decideRelease(local: string, state: ReleaseState): ReleaseDecision {
  const tag = parseVersion(local).pre.length > 0 ? "next" : "latest";
  const skip = (reason: string): ReleaseDecision => ({ stage: false, tag, reason });
  if (state.published.length === 0) {
    // npm only stages versions of packages that already exist.
    return skip("the package is not on npm yet; publish the first version manually");
  }
  if (state.published.includes(local)) return skip(`${local} is already published`);
  if (state.tagged) return skip(`v${local} is already tagged (staged or released)`);
  if (state.latest && compareVersions(local, state.latest) <= 0) {
    return skip(`${local} is not greater than the published latest ${state.latest}`);
  }
  return {
    stage: true,
    tag,
    reason: state.latest
      ? `${local} > ${state.latest} (dist-tag ${tag})`
      : `new version (dist-tag ${tag})`,
  };
}

interface Packument {
  versions?: Record<string, unknown>;
  "dist-tags"?: Record<string, string>;
}

export async function fetchPublished(
  name: string,
  registry = "https://registry.npmjs.org",
): Promise<{ versions: string[]; latest?: string }> {
  const url = `${registry.replace(/\/$/, "")}/${name.replace("/", "%2f")}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.npm.install-v1+json" } });
  if (res.status === 404) return { versions: [] };
  if (!res.ok) throw new Error(`registry responded ${res.status} for ${url}`);
  const doc = (await res.json()) as Packument;
  const latest = doc["dist-tags"]?.latest;
  return { versions: Object.keys(doc.versions ?? {}), ...(latest ? { latest } : {}) };
}

/** Whether `refs/tags/<tag>` exists on the `origin` remote. */
export function remoteTagExists(
  tag: string,
  run: (args: string[]) => string = (args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
): boolean {
  return run(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "";
}

async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  const { versions, latest } = await fetchPublished(pkg.name, process.env.NPM_REGISTRY);
  const decision = decideRelease(pkg.version, {
    published: versions,
    ...(latest ? { latest } : {}),
    // Skip the git call while the package does not exist: nothing can be staged anyway.
    tagged: versions.length > 0 && remoteTagExists(`v${pkg.version}`),
  });
  console.log(
    `${pkg.name}@${pkg.version}: ${decision.stage ? "stage" : "skip"} (${decision.reason})`,
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `stage=${decision.stage}\ntag=${decision.tag}\nversion=${pkg.version}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

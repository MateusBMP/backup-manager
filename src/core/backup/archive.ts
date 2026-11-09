import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import * as tar from "tar";
import type { Project } from "../config/schema.js";

export class ArchiveError extends Error {
  override name = "ArchiveError";
}

export interface ArchiveResult {
  files: number;
  bytes: number;
  warnings: string[];
}

export interface ArchiveOptions {
  compressLevel?: number;
  onProgress?: (progress: { files: number; bytes: number }) => void;
  signal?: AbortSignal;
}

/**
 * Builds the exclude test. A `dir/**` pattern excludes everything below `dir` but keeps the
 * (now empty) directory itself, so the structure survives a restore.
 */
export function excludeMatcher(
  patterns: readonly string[],
): (relative: string, isDir: boolean) => boolean {
  const matchers = patterns.map((pattern) => {
    const full = picomatch(pattern, { dot: true });
    const base = pattern.endsWith("/**") ? picomatch(pattern.slice(0, -3), { dot: true }) : null;
    return { full, base };
  });
  return (relative, isDir) =>
    matchers.some(({ full, base }) => full(relative) && !(isDir && base?.(relative)));
}

/** Archive `project.include` (relative to `project.path`) into a gzip tarball. */
export async function archiveProject(
  project: Project,
  destination: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const warnings: string[] = [];
  const present: string[] = [];
  for (const include of project.include) {
    const relative = path.posix.normalize(include.replace(/\\/g, "/")).replace(/^\/+|\/+$/g, "");
    const full = path.join(project.path, relative);
    if (relative.startsWith("..") || path.relative(project.path, full).startsWith("..")) {
      warnings.push(`include '${include}' points outside the project, skipped`);
      continue;
    }
    const info = await lstat(full).catch(() => null);
    if (!info || info.isSymbolicLink()) {
      warnings.push(`include '${include}' not found under ${project.path}, skipped`);
      continue;
    }
    present.push(relative);
  }
  if (present.length === 0) {
    throw new ArchiveError(
      `none of the include paths exist under ${project.path}: ${project.include.join(", ")}`,
    );
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const excluded = excludeMatcher(project.exclude);
  let files = 0;
  let bytes = 0;
  let lastReport = 0;
  try {
    await tar.c(
      {
        gzip: { level: options.compressLevel ?? 6 },
        file: destination,
        cwd: project.path,
        follow: false,
        portable: false,
        mode: 0o600,
        filter: (entryPath, stat) => {
          if (options.signal?.aborted) throw new ArchiveError("aborted");
          const relative = entryPath.replace(/^\.\//, "");
          const isDir =
            "isDirectory" in stat && typeof stat.isDirectory === "function" && stat.isDirectory();
          if (excluded(relative, isDir)) return false;
          if (!isDir) {
            files++;
            bytes += "size" in stat ? Number(stat.size) || 0 : 0;
            const now = Date.now();
            if (options.onProgress && now - lastReport > 250) {
              lastReport = now;
              options.onProgress({ files, bytes });
            }
          }
          return true;
        },
      },
      present,
    );
  } catch (error) {
    await rm(destination, { force: true });
    throw error instanceof ArchiveError ? error : new ArchiveError((error as Error).message);
  }
  options.onProgress?.({ files, bytes });
  return { files, bytes, warnings };
}

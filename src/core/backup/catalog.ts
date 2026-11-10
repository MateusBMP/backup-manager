import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { type BackupStatus, type Manifest, readManifest } from "./manifest.js";

export const BACKUP_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?$/;
export const TMP_PREFIX = ".tmp-";

export interface BackupInfo {
  id: string;
  environment: string;
  dir: string;
  createdAt: Date;
  status: BackupStatus;
  size: number;
  itemCount: number;
  failedCount: number;
  manifest: Manifest | null;
}

export function dateFromId(id: string): Date | null {
  const m = BACKUP_ID.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return new Date(y!, mo! - 1, d!, h!, mi!, s!);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function readBackup(
  envDir: string,
  environment: string,
  id: string,
): Promise<BackupInfo | null> {
  const createdFromId = dateFromId(id);
  if (!createdFromId) return null;
  const dir = path.join(envDir, id);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return null;
  const manifest = await readManifest(dir);
  if (!manifest) {
    return {
      id,
      environment,
      dir,
      createdAt: createdFromId,
      status: "incomplete",
      size: await dirSize(dir),
      itemCount: 0,
      failedCount: 0,
      manifest: null,
    };
  }
  const created = new Date(manifest.createdAt);
  return {
    id,
    environment,
    dir,
    createdAt: Number.isNaN(created.getTime()) ? createdFromId : created,
    status: manifest.status,
    size: manifest.totalSize ?? manifest.items.reduce((s, i) => s + (i.size || 0), 0),
    itemCount: manifest.items.length,
    failedCount: manifest.items.filter((i) => i.status === "failed").length,
    manifest,
  };
}

/** All backups of an environment, newest first. A missing directory means no backups. */
export async function listBackups(envDir: string, environment: string): Promise<BackupInfo[]> {
  const entries = await readdir(envDir, { withFileTypes: true }).catch(() => []);
  const backups = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && BACKUP_ID.test(e.name))
      .map((e) => readBackup(envDir, environment, e.name)),
  );
  return backups
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}

/** `.tmp-<id>` working directories left behind by interrupted runs. */
export async function listTempDirs(envDir: string): Promise<{ dir: string; mtime: Date }[]> {
  const entries = await readdir(envDir, { withFileTypes: true }).catch(() => []);
  const out: { dir: string; mtime: Date }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(TMP_PREFIX)) continue;
    const dir = path.join(envDir, e.name);
    const s = await stat(dir).catch(() => null);
    if (s) out.push({ dir, mtime: s.mtime });
  }
  return out;
}

export interface DiskUsage {
  total: number;
  free: number;
  used: number;
}

/**
 * Space on the filesystem holding `dir`. A directory that does not exist yet is measured on its
 * nearest existing parent. Null when the filesystem cannot be read.
 */
export async function diskUsage(dir: string): Promise<DiskUsage | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const fs = await statfs(current);
      const total = fs.blocks * fs.bsize;
      const free = fs.bavail * fs.bsize;
      return { total, free, used: Math.max(0, total - fs.bfree * fs.bsize) };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

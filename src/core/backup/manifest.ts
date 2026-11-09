import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ItemKind = "database" | "project";
export type ItemStatus = "success" | "failed";
export type BackupStatus = "complete" | "partial" | "incomplete";

export interface ManifestItem {
  kind: ItemKind;
  name: string;
  /** Path relative to the backup directory, or null when nothing was written. */
  file: string | null;
  size: number;
  sha256: string | null;
  durationMs: number;
  status: ItemStatus;
  error?: string;
  warnings?: string[];
  /** Short human description, e.g. `shop @ 127.0.0.1:3306` or `142 files`. */
  detail?: string;
}

export interface Manifest {
  version: 1;
  id: string;
  environment: string;
  createdAt: string;
  finishedAt: string;
  status: BackupStatus;
  jobId?: string;
  trigger?: string;
  totalSize: number;
  items: ManifestItem[];
}

export const MANIFEST_FILE = "manifest.json";

export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const data = JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}

export function backupStatus(items: ManifestItem[]): BackupStatus {
  const ok = items.filter((i) => i.status === "success").length;
  if (items.length > 0 && ok === items.length) return "complete";
  return ok > 0 ? "partial" : "incomplete";
}

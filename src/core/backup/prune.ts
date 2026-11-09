import { rm } from "node:fs/promises";
import { effectiveRetention, envBackupDir } from "../config/defaults.js";
import type { Config, Environment } from "../config/schema.js";
import { type BackupInfo, listBackups, listTempDirs } from "./catalog.js";
import { selectForDeletion } from "./retention.js";

export const STALE_TMP_MS = 24 * 3600_000;

export interface PrunePlan {
  environment: string;
  keep: BackupInfo[];
  delete: BackupInfo[];
  staleTemp: string[];
  freedBytes: number;
}

export async function planPrune(
  config: Config,
  env: Environment,
  now = new Date(),
): Promise<PrunePlan> {
  const dir = envBackupDir(config, env);
  const backups = await listBackups(dir, env.name);
  const remove = selectForDeletion(backups, effectiveRetention(config, env), now);
  const temps = await listTempDirs(dir);
  return {
    environment: env.name,
    keep: backups.filter((b) => !remove.includes(b)),
    delete: remove,
    staleTemp: temps
      .filter((t) => now.getTime() - t.mtime.getTime() > STALE_TMP_MS)
      .map((t) => t.dir),
    freedBytes: remove.reduce((s, b) => s + b.size, 0),
  };
}

export async function applyPrune(
  plan: PrunePlan,
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const dir of [...plan.delete.map((b) => b.dir), ...plan.staleTemp]) {
    try {
      await rm(dir, { recursive: true, force: true });
      deleted.push(dir);
    } catch (error) {
      errors.push(`${dir}: ${(error as Error).message}`);
    }
  }
  return { deleted, errors };
}

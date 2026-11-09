import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { envBackupDir } from "../config/defaults.js";
import type { Config, Environment } from "../config/schema.js";
import { timestampId } from "../format.js";
import type { Emit } from "../jobs/events.js";
import { archiveProject } from "./archive.js";
import { TMP_PREFIX } from "./catalog.js";
import {
  type BackupStatus,
  backupStatus,
  type Manifest,
  type ManifestItem,
  writeManifest,
} from "./manifest.js";
import { describeConnection, dumpDatabase, resolveConnection } from "./mariadb.js";
import { applyPrune, planPrune } from "./prune.js";

export interface BackupSelection {
  /** Database names to dump; undefined = all. */
  databases?: string[];
  /** Project names to archive; undefined = all. */
  projects?: string[];
}

export interface BackupOptions {
  emit?: Emit;
  signal?: AbortSignal;
  jobId?: string;
  trigger?: string;
  now?: () => Date;
}

export interface BackupResult {
  backupId: string | null;
  dir: string | null;
  status: BackupStatus | "failed";
  manifest: Manifest | null;
  pruned: string[];
}

export class NothingToBackUpError extends Error {
  override name = "NothingToBackUpError";
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function freeId(dir: string, base: string): Promise<string> {
  for (let n = 0; ; n++) {
    const id = n === 0 ? base : `${base}-${n}`;
    const taken = await Promise.all([
      stat(path.join(dir, id)).then(
        () => true,
        () => false,
      ),
      stat(path.join(dir, `${TMP_PREFIX}${id}`)).then(
        () => true,
        () => false,
      ),
    ]);
    if (!taken.some(Boolean)) return id;
  }
}

/**
 * Back up one environment: each database and project is processed in turn inside
 * `.tmp-<id>/`; a failing item does not stop the others. The directory is renamed to
 * `<id>/` at the end, or removed when every item failed. The caller holds the env lock.
 */
export async function runBackup(
  config: Config,
  env: Environment,
  selection: BackupSelection = {},
  options: BackupOptions = {},
): Promise<BackupResult> {
  const emit: Emit = options.emit ?? (() => {});
  const now = options.now ?? (() => new Date());
  const pick = <T extends { name: string }>(all: T[], names?: string[]) =>
    names ? all.filter((x) => names.includes(x.name)) : all;
  const databases = pick(env.databases, selection.databases);
  const projects = pick(env.projects, selection.projects);
  const total = databases.length + projects.length;
  if (total === 0)
    throw new NothingToBackUpError(`environment '${env.name}' has nothing selected to back up`);

  const root = envBackupDir(config, env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const createdAt = now();
  const id = await freeId(root, timestampId(createdAt));
  const work = path.join(root, `${TMP_PREFIX}${id}`);
  await mkdir(work, { mode: 0o700 });
  const level = config.settings.compressLevel;
  const log = (level: "info" | "warn" | "error", message: string) =>
    emit({ type: "log", level, message, environment: env.name });
  log(
    "info",
    `backup ${id} started (${databases.length} database(s), ${projects.length} project(s))`,
  );

  const items: ManifestItem[] = [];
  let index = 0;
  const run = async (
    kind: ManifestItem["kind"],
    name: string,
    relative: string,
    task: (file: string, warnings: string[]) => Promise<string | undefined>,
  ) => {
    index++;
    emit({ type: "item-start", environment: env.name, kind, name, index, total });
    const file = path.join(work, relative);
    const started = Date.now();
    const warnings: string[] = [];
    let item: ManifestItem;
    try {
      if (options.signal?.aborted) throw new Error("aborted");
      const detail = await task(file, warnings);
      const size = (await stat(file)).size;
      item = {
        kind,
        name,
        file: relative,
        size,
        sha256: await sha256(file),
        durationMs: Date.now() - started,
        status: "success",
        ...(detail ? { detail } : {}),
      };
    } catch (error) {
      await rm(file, { force: true });
      item = {
        kind,
        name,
        file: null,
        size: 0,
        sha256: null,
        durationMs: Date.now() - started,
        status: "failed",
        error: (error as Error).message,
      };
      log("error", `${kind} ${name}: ${item.error}`);
    }
    if (warnings.length) item.warnings = warnings;
    for (const w of warnings) log("warn", `${kind} ${name}: ${w}`);
    items.push(item);
    emit({
      type: "item-done",
      environment: env.name,
      kind,
      name,
      status: item.status,
      size: item.size,
      durationMs: item.durationMs,
      ...(item.error ? { error: item.error } : {}),
    });
  };

  for (const db of databases) {
    await run("database", db.name, `databases/${db.name}.sql.gz`, async (file, warnings) => {
      const conn = await resolveConnection(db, env, (w) => warnings.push(w));
      await dumpDatabase(conn, file, {
        compressLevel: level,
        extraArgs: db.extraArgs,
        signal: options.signal,
        onProgress: (bytes) =>
          emit({
            type: "item-progress",
            environment: env.name,
            kind: "database",
            name: db.name,
            bytes,
          }),
      });
      return describeConnection(conn);
    });
  }
  for (const project of projects) {
    await run(
      "project",
      project.name,
      `projects/${project.name}.tar.gz`,
      async (file, warnings) => {
        const result = await archiveProject(project, file, {
          compressLevel: level,
          signal: options.signal,
          onProgress: ({ files, bytes }) =>
            emit({
              type: "item-progress",
              environment: env.name,
              kind: "project",
              name: project.name,
              bytes,
              files,
            }),
        });
        warnings.push(...result.warnings);
        return `${result.files} files`;
      },
    );
  }

  const status = backupStatus(items);
  if (status === "incomplete" || options.signal?.aborted) {
    await rm(work, { recursive: true, force: true });
    log(
      "error",
      options.signal?.aborted ? `backup ${id} cancelled` : `backup ${id} failed: every item failed`,
    );
    emit({ type: "backup-done", environment: env.name, backupId: null, status: "failed" });
    return { backupId: null, dir: null, status: "failed", manifest: null, pruned: [] };
  }
  const manifest: Manifest = {
    version: 1,
    id,
    environment: env.name,
    createdAt: createdAt.toISOString(),
    finishedAt: now().toISOString(),
    status,
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.trigger ? { trigger: options.trigger } : {}),
    totalSize: items.reduce((s, i) => s + i.size, 0),
    items,
  };
  await writeManifest(work, manifest);
  const dir = path.join(root, id);
  await rename(work, dir);
  log(status === "complete" ? "info" : "warn", `backup ${id} ${status}`);
  emit({ type: "backup-done", environment: env.name, backupId: id, status });

  let pruned: string[] = [];
  if (status === "complete" && config.settings.autoPrune) {
    try {
      const plan = await planPrune(config, env, now());
      const result = await applyPrune(plan);
      pruned = result.deleted;
      if (pruned.length) log("info", `pruned ${pruned.length} old backup(s)`);
      for (const e of result.errors) log("warn", `prune: ${e}`);
    } catch (error) {
      log("warn", `prune failed: ${(error as Error).message}`);
    }
  }
  return { backupId: id, dir, status, manifest, pruned };
}

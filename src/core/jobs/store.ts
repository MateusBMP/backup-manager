import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupStatus } from "../backup/manifest.js";
import { timestampId } from "../format.js";
import { isAlive } from "../process.js";

export type JobState = "queued" | "running" | "success" | "partial" | "failed";
export type JobTrigger = "ui" | "schedule" | "catch-up";

export interface JobTarget {
  environment: string;
  databases?: string[];
  projects?: string[];
}

export interface JobBackup {
  environment: string;
  backupId: string | null;
  status: BackupStatus | "failed";
  error?: string;
}

export interface JobRecord {
  id: string;
  status: JobState;
  trigger: JobTrigger;
  targets: JobTarget[];
  configPath: string;
  /** Spawned in its own session (from the UI) rather than as a daemon child. */
  detached: boolean;
  pid: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  backups: JobBackup[];
  exitCode?: number | null;
  error?: string;
}

export const ACTIVE: readonly JobState[] = ["queued", "running"];
const NEVER_STARTED_MS = 60_000;
export const KEEP_JOBS = 200;

export const jobsDir = (stateDir: string) => path.join(stateDir, "jobs");
export const logsDir = (stateDir: string) => path.join(stateDir, "logs");
export const jobFile = (stateDir: string, id: string) => path.join(jobsDir(stateDir), `${id}.json`);
export const eventsFile = (stateDir: string, id: string) =>
  path.join(logsDir(stateDir), `${id}.ndjson`);
export const outputFile = (stateDir: string, id: string) =>
  path.join(logsDir(stateDir), `${id}.out`);

const JOB_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function newJobId(now = new Date()): string {
  return `${timestampId(now)}-${randomBytes(2).toString("hex")}`;
}

export async function writeJob(stateDir: string, job: JobRecord): Promise<void> {
  const file = jobFile(stateDir, job.id);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export async function readJob(stateDir: string, id: string): Promise<JobRecord | null> {
  if (!JOB_ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(jobFile(stateDir, id), "utf8")) as JobRecord;
  } catch {
    return null;
  }
}

export async function updateJob(
  stateDir: string,
  id: string,
  patch: Partial<JobRecord> | ((job: JobRecord) => Partial<JobRecord>),
): Promise<JobRecord | null> {
  const job = await readJob(stateDir, id);
  if (!job) return null;
  const next = { ...job, ...(typeof patch === "function" ? patch(job) : patch) };
  await writeJob(stateDir, next);
  return next;
}

/** A queued/running job whose process is gone is marked failed. */
export async function reconcileJob(
  stateDir: string,
  job: JobRecord,
  now = Date.now(),
): Promise<JobRecord> {
  if (!ACTIVE.includes(job.status)) return job;
  const lost = job.pid
    ? !isAlive(job.pid)
    : now - new Date(job.createdAt).getTime() > NEVER_STARTED_MS;
  if (!lost) return job;
  const error = job.pid ? "job process exited unexpectedly" : "job process never started";
  return (
    (await updateJob(stateDir, job.id, (current) =>
      ACTIVE.includes(current.status)
        ? { status: "failed", error, finishedAt: new Date(now).toISOString() }
        : {},
    )) ?? job
  );
}

/** Jobs newest first, reconciled. */
export async function listJobs(stateDir: string, limit = 50): Promise<JobRecord[]> {
  const names = await readdir(jobsDir(stateDir)).catch(() => [] as string[]);
  const ids = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .filter((id) => JOB_ID.test(id))
    .sort()
    .reverse()
    .slice(0, limit);
  const jobs = await Promise.all(ids.map((id) => readJob(stateDir, id)));
  return Promise.all(
    jobs.filter((j): j is JobRecord => j !== null).map((j) => reconcileJob(stateDir, j)),
  );
}

/** Delete records and logs beyond the newest `keep` finished jobs. */
export async function pruneJobs(stateDir: string, keep = KEEP_JOBS): Promise<number> {
  const names = await readdir(jobsDir(stateDir)).catch(() => [] as string[]);
  const ids = names
    .filter((n) => n.endsWith(".json") && JOB_ID.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort()
    .reverse();
  let removed = 0;
  for (const id of ids.slice(keep)) {
    const job = await readJob(stateDir, id);
    if (job && ACTIVE.includes(job.status)) continue;
    await Promise.all([
      rm(jobFile(stateDir, id), { force: true }),
      rm(eventsFile(stateDir, id), { force: true }),
      rm(outputFile(stateDir, id), { force: true }),
    ]);
    removed++;
  }
  return removed;
}

export function jobState(backups: JobBackup[]): JobState {
  if (backups.length === 0) return "failed";
  if (backups.every((b) => b.status === "complete")) return "success";
  return backups.some((b) => b.status === "complete" || b.status === "partial")
    ? "partial"
    : "failed";
}

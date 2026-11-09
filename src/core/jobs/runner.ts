import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { acquireLock, LockHeldError } from "../backup/lock.js";
import { runBackup } from "../backup/pipeline.js";
import { stateDir as configStateDir, findEnvironment } from "../config/defaults.js";
import { loadConfig } from "../config/load.js";
import { isAlive } from "../process.js";
import { type Emit, eventWriter } from "./events.js";
import {
  eventsFile,
  type JobBackup,
  type JobRecord,
  type JobTarget,
  type JobTrigger,
  jobState,
  logsDir,
  newJobId,
  outputFile,
  pruneJobs,
  readJob,
  updateJob,
  writeJob,
} from "./store.js";

export interface JobCommand {
  command: string;
  args: string[];
}

let jobCommand: JobCommand = { command: process.execPath, args: [process.argv[1] ?? "bkm"] };

/** Set by the CLI entry point: how to re-invoke `bkm` for `bkm __job <id>`. */
export function setJobCommand(cmd: JobCommand): void {
  jobCommand = cmd;
}

export function getJobCommand(): JobCommand {
  return jobCommand;
}

export interface StartOptions {
  trigger: JobTrigger;
  /** true from the UI: own session, survives the parent. false from the daemon. */
  detached: boolean;
}

export interface StartedJob {
  job: JobRecord;
  child: ChildProcess;
}

/** Record a queued job and spawn `bkm __job <id>` to run it. */
export async function startJob(
  stateDir: string,
  configPath: string,
  targets: JobTarget[],
  options: StartOptions,
): Promise<StartedJob> {
  const job: JobRecord = {
    id: newJobId(),
    status: "queued",
    trigger: options.trigger,
    targets,
    configPath,
    detached: options.detached,
    pid: null,
    createdAt: new Date().toISOString(),
    backups: [],
  };
  await writeJob(stateDir, job);
  mkdirSync(logsDir(stateDir), { recursive: true, mode: 0o700 });
  const out = openSync(outputFile(stateDir, job.id), "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      jobCommand.command,
      [...jobCommand.args, "__job", job.id, "--config", configPath],
      {
        detached: options.detached,
        stdio: ["ignore", out, out],
        env: { ...process.env, BKM_JOB: job.id },
      },
    );
  } finally {
    closeSync(out);
  }
  child.once("error", (error) => {
    void updateJob(stateDir, job.id, {
      status: "failed",
      error: `cannot start job: ${error.message}`,
    });
  });
  if (options.detached) child.unref();
  void pruneJobs(stateDir).catch(() => {});
  return { job, child };
}

/** Stop a running job: the whole process group for detached jobs, the process otherwise. */
export async function killJob(
  stateDir: string,
  id: string,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<boolean> {
  const job = await readJob(stateDir, id);
  if (!job?.pid || !isAlive(job.pid) || !["queued", "running"].includes(job.status)) return false;
  try {
    process.kill(job.detached ? -job.pid : job.pid, signal);
  } catch {
    process.kill(job.pid, signal);
  }
  return true;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_LOCKED = 3;

/** Body of `bkm __job <id>`: run every target in this process. Returns the exit code. */
export async function executeJob(
  stateDir: string,
  id: string,
  configPath?: string,
): Promise<number> {
  const job = await readJob(stateDir, id);
  if (!job) {
    console.error(`job ${id} not found in ${stateDir}`);
    return EXIT_FAILURE;
  }
  const emit: Emit = eventWriter(eventsFile(stateDir, id));
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    emit({ type: "log", level: "warn", message: `received ${signal}, cancelling` });
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);
  await updateJob(stateDir, id, {
    status: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const backups: JobBackup[] = [];
  let lockedOnly = true;
  let fatal: string | undefined;
  try {
    const { config } = await loadConfig(configPath ?? job.configPath);
    const state = configStateDir(config);
    for (const target of job.targets) {
      if (controller.signal.aborted) break;
      const env = findEnvironment(config, target.environment);
      if (!env) {
        lockedOnly = false;
        backups.push({
          environment: target.environment,
          backupId: null,
          status: "failed",
          error: "unknown environment",
        });
        emit({
          type: "log",
          level: "error",
          message: `unknown environment '${target.environment}'`,
        });
        continue;
      }
      let lock: Awaited<ReturnType<typeof acquireLock>>;
      try {
        lock = await acquireLock(state, env.name);
      } catch (error) {
        if (!(error instanceof LockHeldError)) lockedOnly = false;
        const message = (error as Error).message;
        backups.push({ environment: env.name, backupId: null, status: "failed", error: message });
        emit({ type: "log", level: "error", message, environment: env.name });
        continue;
      }
      lockedOnly = false;
      try {
        const result = await runBackup(
          config,
          env,
          { databases: target.databases, projects: target.projects },
          { emit, signal: controller.signal, jobId: id, trigger: job.trigger },
        );
        backups.push({ environment: env.name, backupId: result.backupId, status: result.status });
      } catch (error) {
        const message = (error as Error).message;
        backups.push({ environment: env.name, backupId: null, status: "failed", error: message });
        emit({ type: "log", level: "error", message, environment: env.name });
      } finally {
        await lock.release();
      }
    }
  } catch (error) {
    fatal = (error as Error).message;
    lockedOnly = false;
    emit({ type: "log", level: "error", message: fatal });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
  }

  const status = controller.signal.aborted ? "failed" : jobState(backups);
  const error = controller.signal.aborted
    ? "cancelled"
    : (fatal ?? backups.find((b) => b.error)?.error);
  const exitCode =
    status === "success" ? EXIT_OK : lockedOnly && backups.length > 0 ? EXIT_LOCKED : EXIT_FAILURE;
  await updateJob(stateDir, id, {
    status,
    backups,
    exitCode,
    finishedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
  emit({ type: "job-done", status, ...(error ? { error } : {}) });
  return exitCode;
}

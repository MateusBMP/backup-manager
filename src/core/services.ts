import { type BackupInfo, listBackups, readBackup } from "./backup/catalog.js";
import { lockHolder } from "./backup/lock.js";
import { checkConnection, resolveConnection } from "./backup/mariadb.js";
import { applyPrune, type PrunePlan, planPrune } from "./backup/prune.js";
import { envBackupDir, findEnvironment, stateDir, timezone } from "./config/defaults.js";
import { type LoadedConfig, loadConfig } from "./config/load.js";
import type { Config, Database, Environment } from "./config/schema.js";
import { saveConfig } from "./config/store.js";
import { type DoctorReport, runDoctor } from "./doctor.js";
import { type JobEvent, readEvents } from "./jobs/events.js";
import { killJob, startJob } from "./jobs/runner.js";
import {
  eventsFile,
  type JobRecord,
  type JobTarget,
  type JobTrigger,
  listJobs,
  readJob,
} from "./jobs/store.js";
import { nextRun, nextRuns } from "./schedule.js";
import { ServiceManager } from "./service/manager.js";
import type { CommandRunner } from "./service/systemctl.js";

export interface EnvironmentSummary {
  name: string;
  dir: string;
  databases: number;
  projects: number;
  backups: number;
  totalSize: number;
  last: BackupInfo | null;
  lastComplete: BackupInfo | null;
  schedule: string | null;
  nextRun: Date | null;
  /** pid holding the environment lock, if a backup is running. */
  runningPid: number | null;
}

export interface ServicesOptions {
  configPath: string;
  runner?: CommandRunner;
  unitFile?: string;
  manager?: ServiceManager;
}

/** The single facade the CLI, the UI, the API and the daemon use to reach the engine. */
export class Services {
  readonly configPath: string;
  readonly service: ServiceManager;

  constructor(options: ServicesOptions) {
    this.configPath = options.configPath;
    this.service =
      options.manager ??
      new ServiceManager({
        configPath: options.configPath,
        runner: options.runner,
        unitFile: options.unitFile,
      });
  }

  load(): Promise<LoadedConfig> {
    return loadConfig(this.configPath);
  }

  /** Writes through the store (minimal, atomic, `.bak`, mtime-checked). */
  async save(config: Config, expectedMtimeMs: number | null): Promise<LoadedConfig> {
    const mtimeMs = await saveConfig(this.configPath, config, { expectedMtimeMs });
    return { path: this.configPath, config, mtimeMs };
  }

  async summary(config: Config, env: Environment): Promise<EnvironmentSummary> {
    const dir = envBackupDir(config, env);
    const backups = await listBackups(dir, env.name);
    return {
      name: env.name,
      dir,
      databases: env.databases.length,
      projects: env.projects.length,
      backups: backups.length,
      totalSize: backups.reduce((s, b) => s + b.size, 0),
      last: backups[0] ?? null,
      lastComplete: backups.find((b) => b.status === "complete") ?? null,
      schedule: env.schedule ?? null,
      nextRun: nextRun(env.schedule, timezone(config)),
      runningPid: await lockHolder(stateDir(config), env.name),
    };
  }

  summaries(config: Config): Promise<EnvironmentSummary[]> {
    return Promise.all(config.environments.map((env) => this.summary(config, env)));
  }

  nextRuns(config: Config, env: Environment, count = 3): Date[] {
    return env.schedule ? nextRuns(env.schedule, count, timezone(config)) : [];
  }

  async backups(
    config: Config,
    envName: string,
    filter: { status?: string; limit?: number } = {},
  ): Promise<BackupInfo[]> {
    const env = this.env(config, envName);
    let list = await listBackups(envBackupDir(config, env), env.name);
    if (filter.status) list = list.filter((b) => b.status === filter.status);
    return filter.limit ? list.slice(0, filter.limit) : list;
  }

  async recentBackups(config: Config, limit = 10): Promise<BackupInfo[]> {
    const all = await Promise.all(config.environments.map((e) => this.backups(config, e.name)));
    return all
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  backup(config: Config, envName: string, id: string): Promise<BackupInfo | null> {
    const env = this.env(config, envName);
    return readBackup(envBackupDir(config, env), env.name, id);
  }

  /** Start a backup job in its own session (survives the UI and SSH drops). */
  async startBackup(
    config: Config,
    targets: JobTarget[],
    trigger: JobTrigger = "ui",
  ): Promise<JobRecord> {
    for (const t of targets) this.env(config, t.environment);
    const { job } = await startJob(stateDir(config), this.configPath, targets, {
      trigger,
      detached: true,
    });
    return job;
  }

  jobs(config: Config, limit = 50): Promise<JobRecord[]> {
    return listJobs(stateDir(config), limit);
  }

  job(config: Config, id: string): Promise<JobRecord | null> {
    return readJob(stateDir(config), id);
  }

  jobEvents(
    config: Config,
    id: string,
    offset = 0,
  ): Promise<{ events: JobEvent[]; offset: number }> {
    return readEvents(eventsFile(stateDir(config), id), offset);
  }

  killJob(config: Config, id: string): Promise<boolean> {
    return killJob(stateDir(config), id);
  }

  async planPrune(config: Config, envNames?: string[]): Promise<PrunePlan[]> {
    const envs = envNames ? envNames.map((n) => this.env(config, n)) : config.environments;
    return Promise.all(envs.map((env) => planPrune(config, env)));
  }

  async applyPrune(plans: PrunePlan[]): Promise<{ deleted: number; errors: string[] }> {
    let deleted = 0;
    const errors: string[] = [];
    for (const plan of plans) {
      const r = await applyPrune(plan);
      deleted += r.deleted.length;
      errors.push(...r.errors);
    }
    return { deleted, errors };
  }

  async testConnection(env: Environment, db: Database): Promise<{ ok: boolean; message: string }> {
    try {
      const conn = await resolveConnection(db, env);
      await checkConnection(conn);
      return { ok: true, message: `connected to ${conn.schemas.join(", ")}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  doctor(options: { db?: boolean } = {}): Promise<DoctorReport> {
    return runDoctor({ configPath: this.configPath, db: options.db, service: this.service });
  }

  private env(config: Config, name: string): Environment {
    const env = findEnvironment(config, name);
    if (!env) throw new Error(`unknown environment '${name}'`);
    return env;
  }
}

import type { ChildProcess } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApi } from "../../api/server.js";
import { stateDir, timezone } from "../config/defaults.js";
import type { ApiSettings, Config } from "../config/schema.js";
import { startJob } from "../jobs/runner.js";
import { type JobTrigger, updateJob } from "../jobs/store.js";
import { expandHome } from "../paths.js";
import type { Services } from "../services.js";
import { planCatchUp, readScheduleState, writeScheduleState } from "./catchup.js";
import { Scheduler } from "./scheduler.js";

export interface DaemonLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: DaemonLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`warning: ${m}`),
  error: (m) => console.error(`error: ${m}`),
};

export interface DaemonOptions {
  services: Services;
  log?: DaemonLogger;
  /** How long SIGTERM waits for running jobs before killing them. */
  graceMs?: number;
  debounceMs?: number;
  /** Watch the config file for changes (disable in tests that drive reload()). */
  watchConfig?: boolean;
  now?: () => Date;
}

interface Running {
  environment: string;
  jobId: string;
  child: ChildProcess;
  exited: Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** `bkm daemon`: per-environment schedules, catch-up, config reload and the HTTP API. */
export class Daemon {
  readonly services: Services;
  private readonly log: DaemonLogger;
  private config!: Config;
  private scheduler: Scheduler;
  private queue: { environment: string; trigger: JobTrigger; scheduledAt: Date }[] = [];
  private running = new Map<string, Running>();
  private server: Server | null = null;
  private apiKey = "";
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private stopping = false;
  private stateWrite: Promise<void> = Promise.resolve();
  readonly startedAt = new Date();
  /** Resolves after every job started so far has exited (for tests). */
  lastJob: Promise<void> = Promise.resolve();

  constructor(private readonly options: DaemonOptions) {
    this.services = options.services;
    this.log = options.log ?? consoleLogger;
    this.scheduler = new Scheduler((env, at) => this.onFire(env, at));
  }

  get currentConfig(): Config {
    return this.config;
  }

  get runningEnvironments(): string[] {
    return [...this.running.keys()];
  }

  get queued(): string[] {
    return this.queue.map((q) => q.environment);
  }

  get apiAddress(): string | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async start(): Promise<void> {
    const { config } = await this.services.load();
    this.config = config;
    this.log.info(`backup-manager daemon starting (config ${this.services.configPath})`);
    this.applySchedules();
    await this.catchUp();
    await this.applyApi();
    if (this.options.watchConfig !== false) this.watchConfig();
    this.log.info(`ready: ${this.describeSchedules()}`);
  }

  private describeSchedules(): string {
    const runs = this.scheduler.nextRuns();
    if (runs.length === 0) return "no scheduled environments";
    return runs
      .map((r) => `${r.environment} next ${r.nextRun?.toISOString() ?? "never"}`)
      .join(", ");
  }

  nextRuns() {
    return this.scheduler.nextRuns();
  }

  private scheduled() {
    return this.config.environments
      .filter((e) => e.schedule)
      .map((e) => ({ environment: e.name, schedule: e.schedule as string }));
  }

  private applySchedules() {
    const tz = timezone(this.config);
    const { added, removed, changed } = this.scheduler.apply(this.scheduled(), tz);
    for (const n of added) this.log.info(`scheduled ${n}`);
    for (const n of changed) this.log.info(`rescheduled ${n}`);
    for (const n of removed) this.log.info(`unscheduled ${n}`);
  }

  private async catchUp() {
    const state = await readScheduleState(stateDir(this.config));
    const plan = planCatchUp(this.scheduled(), state, this.now(), timezone(this.config));
    await this.saveScheduleState(plan.state);
    for (const d of plan.decisions) {
      if (d.missed) {
        this.log.info(`${d.environment}: missed run at ${d.missed.toISOString()}, catching up`);
        this.enqueue(d.environment, "catch-up", d.missed);
      }
    }
  }

  private saveScheduleState(state: Awaited<ReturnType<typeof readScheduleState>>) {
    const dir = stateDir(this.config);
    this.stateWrite = this.stateWrite
      .then(() => writeScheduleState(dir, state))
      .catch((e) => {
        this.log.warn(`cannot write schedule state: ${(e as Error).message}`);
      });
    return this.stateWrite;
  }

  private recordFire(environment: string, at: Date) {
    const env = this.config.environments.find((e) => e.name === environment);
    if (!env?.schedule) return;
    const dir = stateDir(this.config);
    const schedule = env.schedule;
    this.stateWrite = this.stateWrite
      .then(async () => {
        const state = await readScheduleState(dir);
        state[environment] = { schedule, lastFire: at.toISOString() };
        await writeScheduleState(dir, state);
      })
      .catch((e) => this.log.warn(`cannot write schedule state: ${(e as Error).message}`));
  }

  private onFire(environment: string, scheduledAt: Date) {
    if (this.stopping) return;
    this.recordFire(environment, scheduledAt);
    this.enqueue(environment, "schedule", scheduledAt);
  }

  /** Queue a run unless the environment is already running or queued. */
  enqueue(environment: string, trigger: JobTrigger, scheduledAt = this.now()): boolean {
    if (this.running.has(environment) || this.queue.some((q) => q.environment === environment)) {
      this.log.warn(`${environment}: previous run still in progress, skipping ${trigger} run`);
      return false;
    }
    this.queue.push({ environment, trigger, scheduledAt });
    this.drain();
    return true;
  }

  private drain() {
    while (
      !this.stopping &&
      this.queue.length &&
      this.running.size < this.config.settings.maxConcurrentJobs
    ) {
      const next = this.queue.shift()!;
      void this.launch(next.environment, next.trigger);
    }
  }

  private async launch(environment: string, trigger: JobTrigger) {
    const placeholder = {
      environment,
      jobId: "",
      child: null as unknown as ChildProcess,
      exited: Promise.resolve(),
    };
    this.running.set(environment, placeholder);
    try {
      const { job, child } = await startJob(
        stateDir(this.config),
        this.services.configPath,
        [{ environment }],
        {
          trigger,
          detached: false,
        },
      );
      const exited = new Promise<void>((resolve) => {
        child.once("exit", (code, signal) => {
          this.running.delete(environment);
          this.log.info(`${environment}: job ${job.id} finished (${signal ?? `exit ${code}`})`);
          resolve();
          this.drain();
        });
      });
      this.running.set(environment, { environment, jobId: job.id, child, exited });
      this.lastJob = Promise.all([this.lastJob, exited]).then(() => {});
      this.log.info(`${environment}: started ${trigger} job ${job.id} (pid ${child.pid ?? "?"})`);
    } catch (error) {
      this.running.delete(environment);
      this.log.error(`${environment}: cannot start job: ${(error as Error).message}`);
      this.drain();
    }
  }

  private async tokenFor(api: ApiSettings): Promise<string | null> {
    if (api.token) return api.token;
    if (api.tokenFile) {
      try {
        return (
          (await readFile(expandHome(api.tokenFile), "utf8")).split(/\r?\n/, 1)[0]?.trim() || null
        );
      } catch (error) {
        this.log.error(`cannot read api.tokenFile: ${(error as Error).message}`);
        return null;
      }
    }
    return null;
  }

  private async applyApi() {
    const api = this.config.api;
    const token = await this.tokenFor(api);
    const key = api.enabled ? JSON.stringify([api.host, api.port, token]) : "";
    if (key === this.apiKey && (this.server !== null) === api.enabled) return;
    await this.closeApi();
    this.apiKey = key;
    if (!api.enabled) {
      this.log.info("api disabled");
      return;
    }
    if (!LOOPBACK.has(api.host) && !token) {
      this.log.warn(
        `api listens on ${api.host} without a token; anyone who can reach it can read backup metadata`,
      );
    }
    const app = createApi({
      services: this.services,
      getConfig: () => this.config,
      token,
      startedAt: this.startedAt,
      log: (m) => this.log.error(m),
    });
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, hostname: api.host, port: api.port }, () =>
        resolve(),
      ) as Server;
      server.once("error", (error) => {
        this.log.error(`api cannot listen on ${api.host}:${api.port}: ${error.message}`);
        this.server = null;
        this.apiKey = "";
        resolve();
      });
      this.server = server;
    });
    if (this.server) this.log.info(`api listening on ${this.apiAddress}`);
  }

  private async closeApi() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private watchConfig() {
    const file = this.services.configPath;
    try {
      this.watcher = watch(path.dirname(file), (_event, name) => {
        if (name && name.toString() !== path.basename(file)) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(
          () => void this.reload("config file changed"),
          this.options.debounceMs ?? 500,
        );
      });
    } catch (error) {
      this.log.warn(
        `cannot watch ${file}: ${(error as Error).message}; use \`systemctl --user reload bkm\``,
      );
    }
  }

  /** Re-read the config; an invalid file keeps the current one. */
  async reload(reason = "reload requested"): Promise<boolean> {
    if (this.stopping) return false;
    try {
      const { config } = await this.services.load();
      if (JSON.stringify(config) === JSON.stringify(this.config)) {
        this.log.info(`${reason}: no changes`);
        return true;
      }
      this.config = config;
      this.log.info(`${reason}: configuration reloaded`);
      this.applySchedules();
      await this.applyApi();
      this.drain();
      return true;
    } catch (error) {
      this.log.error(`${reason}: keeping the previous configuration: ${(error as Error).message}`);
      return false;
    }
  }

  /** Stop scheduling and the API, wait for running jobs (up to the grace period), then kill them. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info("stopping");
    this.scheduler.stop();
    this.queue = [];
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    await this.closeApi();
    const running = [...this.running.values()].filter((r) => r.child);
    if (running.length) {
      this.log.info(`waiting for ${running.length} running job(s)`);
      const grace = this.options.graceMs ?? 5 * 60_000;
      const all = Promise.all(running.map((r) => r.exited));
      const timedOut = await Promise.race([all.then(() => false), sleep(grace).then(() => true)]);
      if (timedOut) {
        this.log.warn("grace period over, cancelling running jobs");
        for (const r of running) r.child.kill("SIGTERM");
        const killed = await Promise.race([all.then(() => false), sleep(10_000).then(() => true)]);
        if (killed) {
          for (const r of running) {
            r.child.kill("SIGKILL");
            await updateJob(stateDir(this.config), r.jobId, {
              status: "failed",
              error: "killed when the daemon stopped",
              finishedAt: new Date().toISOString(),
            });
          }
        }
      }
    }
    await this.stateWrite;
    this.log.info("stopped");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/** Run until SIGTERM/SIGINT; SIGHUP reloads. Used by `bkm daemon`. */
export async function runDaemon(options: DaemonOptions): Promise<number> {
  const daemon = new Daemon(options);
  await daemon.start();
  return new Promise<number>((resolve) => {
    const onHup = () => void daemon.reload("SIGHUP");
    const onStop = (signal: NodeJS.Signals) => {
      (options.log ?? consoleLogger).info(`received ${signal}`);
      process.off("SIGHUP", onHup);
      process.off("SIGTERM", onStop);
      process.off("SIGINT", onStop);
      void daemon.stop().then(() => resolve(0));
    };
    process.on("SIGHUP", onHup);
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);
  });
}

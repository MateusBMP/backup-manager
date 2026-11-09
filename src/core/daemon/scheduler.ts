import { Cron } from "croner";

export interface ScheduledEnv {
  environment: string;
  schedule: string;
}

/** One croner job per scheduled environment, rebuilt on every `apply`. */
export class Scheduler {
  private jobs = new Map<string, { schedule: string; cron: Cron }>();
  private timezone: string | undefined;

  constructor(private readonly onFire: (environment: string, scheduledAt: Date) => void) {}

  apply(
    envs: ScheduledEnv[],
    timezone?: string,
  ): { added: string[]; removed: string[]; changed: string[] } {
    const tzChanged = timezone !== this.timezone;
    this.timezone = timezone;
    const wanted = new Map(envs.map((e) => [e.environment, e.schedule]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [name, job] of this.jobs) {
      const schedule = wanted.get(name);
      if (schedule === undefined) {
        job.cron.stop();
        this.jobs.delete(name);
        removed.push(name);
      } else if (schedule !== job.schedule || tzChanged) {
        job.cron.stop();
        this.jobs.delete(name);
        changed.push(name);
      }
    }
    for (const [name, schedule] of wanted) {
      if (this.jobs.has(name)) continue;
      if (!changed.includes(name)) added.push(name);
      const cron = new Cron(
        schedule,
        { ...(timezone ? { timezone } : {}), catch: true },
        (self: Cron) => {
          this.onFire(name, self.currentRun() ?? new Date());
        },
      );
      this.jobs.set(name, { schedule, cron });
    }
    return { added, removed, changed };
  }

  nextRuns(): { environment: string; nextRun: Date | null }[] {
    return [...this.jobs].map(([environment, job]) => ({
      environment,
      nextRun: job.cron.nextRun(),
    }));
  }

  stop(): void {
    for (const job of this.jobs.values()) job.cron.stop();
    this.jobs.clear();
  }
}

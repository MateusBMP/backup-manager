import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { stateDir } from "../../src/core/config/defaults.js";
import { saveConfig } from "../../src/core/config/store.js";
import {
  planCatchUp,
  readScheduleState,
  writeScheduleState,
} from "../../src/core/daemon/catchup.js";
import { Daemon } from "../../src/core/daemon/daemon.js";
import { Scheduler } from "../../src/core/daemon/scheduler.js";
import { getJobCommand, setJobCommand } from "../../src/core/jobs/runner.js";
import { listJobs } from "../../src/core/jobs/store.js";
import { Services } from "../../src/core/services.js";
import {
  fakeSystemd,
  freePort,
  installFakeDump,
  makeConfig,
  makeLaravelProject,
  memoryLogger,
  sleep,
  tempDir,
  waitFor,
} from "../helpers.js";

const ENTRY = path.resolve(import.meta.dirname, "../fixtures/job-entry.ts");
let saved: ReturnType<typeof getJobCommand>;
beforeAll(() => {
  saved = getJobCommand();
  setJobCommand({ command: process.execPath, args: ["--import", "tsx", ENTRY] });
});
afterAll(() => setJobCommand(saved));

const daemons: Daemon[] = [];
afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

async function setup(env: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const root = await tempDir();
  await installFakeDump(root);
  const projectPath = await makeLaravelProject(root);
  const port = await freePort();
  const config = makeConfig(root, {
    api: { port },
    environments: [
      {
        name: "prod",
        projects: [{ name: "shop", path: projectPath }],
        databases: [{ name: "shop", source: { type: "laravel", project: "shop" } }],
        ...env,
      },
    ],
    ...extra,
  });
  const configPath = path.join(root, "config.json");
  await saveConfig(configPath, config);
  const services = new Services({ configPath, runner: fakeSystemd().runner });
  const log = memoryLogger();
  const make = (options: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) => {
    const d = new Daemon({ services, log, watchConfig: false, graceMs: 10_000, ...options });
    daemons.push(d);
    return d;
  };
  return { root, config, configPath, services, log, port, make, state: stateDir(config) };
}

describe("catch-up planning", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const sched = [{ environment: "prod", schedule: "30 3 * * *" }];

  test("first start sets a baseline without running", () => {
    const { decisions, state } = planCatchUp(sched, {}, now, "UTC");
    expect(decisions).toEqual([{ environment: "prod", missed: null }]);
    expect(state.prod).toEqual({ schedule: "30 3 * * *", lastFire: "2026-11-09T03:30:00.000Z" });
  });

  test("a missed fire runs once; up to date or changed schedules do not", () => {
    const missed = planCatchUp(
      sched,
      { prod: { schedule: "30 3 * * *", lastFire: "2026-11-08T03:30:00.000Z" } },
      now,
      "UTC",
    );
    expect(missed.decisions[0]!.missed?.toISOString()).toBe("2026-11-09T03:30:00.000Z");
    expect(missed.state.prod!.lastFire).toBe("2026-11-09T03:30:00.000Z");
    const upToDate = planCatchUp(sched, missed.state, now, "UTC");
    expect(upToDate.decisions[0]!.missed).toBeNull();
    const changed = planCatchUp(
      sched,
      { prod: { schedule: "0 1 * * *", lastFire: "2026-01-01T00:00:00.000Z" } },
      now,
      "UTC",
    );
    expect(changed.decisions[0]!.missed).toBeNull();
  });

  test("state file round trip", async () => {
    const dir = await tempDir();
    expect(await readScheduleState(dir)).toEqual({});
    await writeScheduleState(dir, { a: { schedule: "x", lastFire: "y" } });
    expect(await readScheduleState(dir)).toEqual({ a: { schedule: "x", lastFire: "y" } });
    await writeFile(path.join(dir, "schedule.json"), "nope");
    expect(await readScheduleState(dir)).toEqual({});
  });
});

describe("scheduler", () => {
  test("fires per second, reports next runs, applies changes", async () => {
    const fired: string[] = [];
    const s = new Scheduler((env) => fired.push(env));
    expect(s.apply([{ environment: "a", schedule: "* * * * * *" }], "UTC")).toEqual({
      added: ["a"],
      removed: [],
      changed: [],
    });
    await waitFor(() => fired.length > 0, { timeout: 3000 });
    expect(s.nextRuns()[0]!.nextRun).toBeInstanceOf(Date);
    expect(
      s.apply(
        [
          { environment: "a", schedule: "0 3 * * *" },
          { environment: "b", schedule: "0 4 * * *" },
        ],
        "UTC",
      ),
    ).toEqual({
      added: ["b"],
      removed: [],
      changed: ["a"],
    });
    expect(s.apply([{ environment: "b", schedule: "0 4 * * *" }], "America/Sao_Paulo")).toEqual({
      added: [],
      removed: ["a"],
      changed: ["b"],
    });
    s.stop();
    expect(s.nextRuns()).toEqual([]);
  });
});

describe("daemon", () => {
  test("a schedule fires a job, the API serves, reload re-schedules, stop is clean", async () => {
    const { make, state, log, port, configPath, config } = await setup({ schedule: "* * * * * *" });
    const daemon = make();
    await daemon.start();
    expect(daemon.apiAddress).toBe(`http://127.0.0.1:${port}`);
    const health = await (await fetch(`${daemon.apiAddress}/health`)).json();
    expect(health).toMatchObject({ status: "ok", environments: 1 });

    const job = await waitFor(
      async () => (await listJobs(state)).find((j) => j.status === "success"),
      { timeout: 15_000 },
    );
    expect(job.trigger).toBe("schedule");
    expect(job.detached).toBe(false);
    const schedule = JSON.parse(await readFile(path.join(state, "schedule.json"), "utf8"));
    expect(schedule.prod.schedule).toBe("* * * * * *");

    // invalid config is ignored
    await writeFile(configPath, JSON.stringify({ environments: [{ name: "BAD" }] }));
    expect(await daemon.reload("test")).toBe(false);
    expect(daemon.currentConfig.environments[0]!.name).toBe("prod");
    expect(
      log.lines.some(
        (l) =>
          l.includes("keeping the previous configuration") && l.includes("environments[0].name"),
      ),
    ).toBe(true);

    // valid change: no schedule, new API port
    const newPort = await freePort();
    const next = structuredClone(config);
    delete next.environments[0]!.schedule;
    next.api.port = newPort;
    await saveConfig(configPath, next);
    expect(await daemon.reload("test")).toBe(true);
    expect(daemon.nextRuns()).toEqual([]);
    expect(daemon.apiAddress).toBe(`http://127.0.0.1:${newPort}`);
    expect(await daemon.reload("again")).toBe(true);
    expect(log.lines.at(-1)).toMatch(/no changes/);

    next.api.enabled = false;
    await saveConfig(configPath, next);
    await daemon.reload("disable api");
    expect(daemon.apiAddress).toBeNull();

    await daemon.lastJob;
    await daemon.stop();
    await daemon.stop();
    expect(log.lines).toContain("info: stopped");
    expect(await daemon.reload()).toBe(false);
  });

  test("an environment already running is skipped; concurrency is limited", async () => {
    const { make, log } = await setup({}, { settings: { maxConcurrentJobs: 1 } });
    process.env.FAKE_DUMP_SLEEP_MS = "1500";
    try {
      const daemon = make();
      await daemon.start();
      expect(daemon.enqueue("prod", "schedule")).toBe(true);
      expect(daemon.enqueue("prod", "schedule")).toBe(false);
      expect(log.lines.some((l) => l.includes("previous run still in progress"))).toBe(true);
      await waitFor(() => daemon.runningEnvironments.length === 0 && daemon.queued.length === 0, {
        timeout: 15_000,
      });
      await daemon.lastJob;
      await daemon.stop();
    } finally {
      delete process.env.FAKE_DUMP_SLEEP_MS;
    }
  });

  test("catch-up runs a missed schedule once at start", async () => {
    const { make, state } = await setup({ schedule: "0 3 * * *" });
    await writeScheduleState(state, {
      prod: { schedule: "0 3 * * *", lastFire: "2000-01-01T00:00:00.000Z" },
    });
    const daemon = make();
    await daemon.start();
    const job = await waitFor(
      async () => (await listJobs(state)).find((j) => j.status === "success"),
      { timeout: 15_000 },
    );
    expect(job.trigger).toBe("catch-up");
    await daemon.lastJob;
    await daemon.stop();
    const after = await readScheduleState(state);
    expect(new Date(after.prod!.lastFire).getTime()).toBeGreaterThan(
      new Date("2000-01-02").getTime(),
    );
  });

  test("stop waits for running jobs, then cancels them after the grace period", async () => {
    const { make, state, log } = await setup();
    process.env.FAKE_DUMP_SLEEP_MS = "30000";
    try {
      const daemon = make({ graceMs: 300 });
      await daemon.start();
      daemon.enqueue("prod", "schedule");
      await waitFor(async () => (await listJobs(state)).find((j) => j.status === "running"), {
        timeout: 10_000,
      });
      await daemon.stop();
      expect(log.lines.some((l) => l.includes("grace period over"))).toBe(true);
      const job = await waitFor(
        async () => (await listJobs(state)).find((j) => j.status === "failed"),
        { timeout: 10_000 },
      );
      expect(job.error).toMatch(/cancelled|killed/);
    } finally {
      delete process.env.FAKE_DUMP_SLEEP_MS;
    }
  });

  test("watches the config file and warns about exposed APIs", async () => {
    const { make, log, configPath, config } = await setup(
      {},
      { api: { host: "0.0.0.0", port: await freePort() } },
    );
    const daemon = make({ watchConfig: true, debounceMs: 50 });
    await daemon.start();
    expect(log.lines.some((l) => l.includes("without a token"))).toBe(true);
    const next = structuredClone(config);
    next.environments[0]!.schedule = "0 5 * * *";
    await saveConfig(configPath, next);
    await waitFor(() => daemon.nextRuns().length === 1, { timeout: 5000 });
    await sleep(10);
    await daemon.stop();
  });

  test("tokenFile is read; an unreadable one disables auth with an error", async () => {
    const { make, log, root } = await setup(
      {},
      { api: { port: await freePort(), tokenFile: "/nonexistent/token" } },
    );
    const daemon = make();
    await daemon.start();
    expect(log.lines.some((l) => l.includes("cannot read api.tokenFile"))).toBe(true);
    await daemon.stop();
    expect(root).toBeTruthy();
  });
});

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runBackup } from "../../src/core/backup/pipeline.js";
import { stateDir } from "../../src/core/config/defaults.js";
import { ConfigConflictError } from "../../src/core/config/store.js";
import { runDoctor } from "../../src/core/doctor.js";
import { getJobCommand, setJobCommand } from "../../src/core/jobs/runner.js";
import { ServiceManager } from "../../src/core/service/manager.js";
import { Services } from "../../src/core/services.js";
import {
  fakeSystemd,
  installFakeDump,
  makeConfig,
  makeLaravelProject,
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

async function setup() {
  const root = await tempDir();
  await installFakeDump(root);
  const projectPath = await makeLaravelProject(root);
  const config = makeConfig(root, {
    environments: [
      {
        name: "prod",
        schedule: "30 3 * * *",
        projects: [{ name: "shop", path: projectPath }],
        databases: [
          { name: "shop", source: { type: "laravel", project: "shop" } },
          { name: "bad", source: { type: "connection", password: "wrong", schemas: ["x"] } },
        ],
      },
      { name: "stage" },
    ],
  });
  const configPath = path.join(root, "config.json");
  const fake = fakeSystemd();
  const services = new Services({
    configPath,
    runner: fake.runner,
    unitFile: path.join(root, "bkm.service"),
  });
  const loaded = await services.save(config, null);
  return { root, config, configPath, services, loaded, fake };
}

describe("services facade", () => {
  test("summaries, backups, prune, connection test", async () => {
    const { config, services } = await setup();
    const env = config.environments[0]!;
    await runBackup(config, env, { databases: ["shop"] });
    const summaries = await services.summaries(config);
    expect(summaries[0]).toMatchObject({
      name: "prod",
      databases: 2,
      projects: 1,
      backups: 1,
      schedule: "30 3 * * *",
      runningPid: null,
    });
    expect(summaries[0]!.nextRun).toBeInstanceOf(Date);
    expect(summaries[1]).toMatchObject({ name: "stage", backups: 0, last: null, nextRun: null });
    expect(services.nextRuns(config, env)).toHaveLength(3);
    expect(services.nextRuns(config, config.environments[1]!)).toEqual([]);
    const backups = await services.backups(config, "prod", { status: "complete", limit: 5 });
    expect(backups).toHaveLength(1);
    expect(await services.backups(config, "prod", { status: "partial" })).toEqual([]);
    expect((await services.backup(config, "prod", backups[0]!.id))?.id).toBe(backups[0]!.id);
    expect(await services.recentBackups(config)).toHaveLength(1);
    await expect(services.backups(config, "nope")).rejects.toThrow(/unknown environment/);
    const plans = await services.planPrune(config, ["prod"]);
    expect(plans[0]!.delete).toEqual([]);
    expect(await services.applyPrune(plans)).toEqual({ deleted: 0, errors: [] });
    expect(await services.testConnection(env, env.databases[0]!)).toEqual({
      ok: true,
      message: "connected to shop",
    });
    expect((await services.testConnection(env, env.databases[1]!)).ok).toBe(false);
  });

  test("save detects external edits", async () => {
    const { config, services, loaded, configPath } = await setup();
    const next = await services.save(config, loaded.mtimeMs);
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(configPath, `${JSON.stringify({ environments: [] })}\n`);
    await expect(services.save(config, next.mtimeMs)).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await services.load()).config.environments).toEqual([]);
  });

  test("startBackup runs a detached job visible in jobs and events", async () => {
    const { config, services } = await setup();
    const job = await services.startBackup(config, [
      { environment: "prod", databases: ["shop"], projects: [] },
    ]);
    const done = await waitFor(
      async () => {
        const j = await services.job(config, job.id);
        return j && j.status === "success" ? j : null;
      },
      { timeout: 15_000 },
    );
    expect(done.trigger).toBe("ui");
    expect((await services.jobs(config)).map((j) => j.id)).toContain(job.id);
    const { events } = await services.jobEvents(config, job.id);
    expect(events.at(-1)?.type).toBe("job-done");
    expect(await services.killJob(config, job.id)).toBe(false);
    await expect(services.startBackup(config, [{ environment: "nope" }])).rejects.toThrow(
      /unknown environment/,
    );
  });
});

describe("doctor", () => {
  test("reports config, tools, schedules, storage, projects, databases and service", async () => {
    const { services, fake } = await setup();
    let report = await services.doctor();
    const byName = (g: string) => report.checks.filter((c) => c.group === g);
    expect(byName("config")[0]!.status).toBe("ok");
    expect(byName("tools")[0]).toMatchObject({ name: "dump client", status: "ok" });
    expect(byName("schedule")[0]!.detail).toMatch(/daily at 03:30/);
    expect(byName("schedule")[1]!.detail).toBe("manual only");
    expect(byName("storage").every((c) => c.status !== "fail")).toBe(true);
    expect(byName("projects")[0]!.status).toBe("ok");
    expect(byName("databases").map((c) => c.status)).toEqual(["ok", "fail"]);
    expect(byName("service")[0]).toMatchObject({ name: "unit", status: "warn" });
    expect(report.ok).toBe(false);

    await services.service.install();
    report = await services.doctor({ db: false });
    expect(byName("databases")).toEqual([]);
    expect(byName("service").map((c) => c.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(report.ok).toBe(true);
    fake.state.active = false;
    fake.state.linger = false;
    report = await services.doctor({ db: false });
    expect(
      byName("service")
        .filter((c) => c.status === "warn")
        .map((c) => c.name),
    ).toEqual(["active", "linger"]);
  });

  test("missing config, invalid config, unreadable project, unavailable systemd", async () => {
    const root = await tempDir();
    const fake = fakeSystemd({ available: false });
    const service = new ServiceManager({
      configPath: "/x",
      runner: fake.runner,
      unitFile: path.join(root, "u"),
    });
    let report = await runDoctor({ configPath: path.join(root, "none.json"), service });
    expect(report.missingConfig).toBe(true);
    expect(report.checks.find((c) => c.group === "service")!.detail).toMatch(/unavailable/);

    const bad = path.join(root, "bad.json");
    await writeFile(bad, JSON.stringify({ environments: [{ name: "x", schedule: "nope" }] }));
    report = await runDoctor({ configPath: bad });
    expect(report.checks[0]!.detail).toMatch(/^environments\[0\]\.schedule: invalid cron/);

    const locked = path.join(root, "locked");
    await mkdir(path.join(locked, "storage", "app"), { recursive: true });
    const cfg = path.join(root, "c.json");
    await writeFile(
      cfg,
      JSON.stringify({
        settings: { backupDir: path.join(root, "b"), stateDir: path.join(root, "s") },
        environments: [
          {
            name: "a",
            projects: [
              { name: "p", path: locked },
              { name: "gone", path: path.join(root, "gone") },
            ],
          },
        ],
      }),
    );
    await chmod(path.join(locked, "storage", "app"), 0o000);
    try {
      report = await runDoctor({ configPath: cfg, minFreeBytes: Number.MAX_SAFE_INTEGER });
      const projects = report.checks.filter((c) => c.group === "projects");
      if (process.getuid?.() !== 0)
        expect(projects[0]!.detail).toMatch(/not readable \(owned by group/);
      expect(projects[1]!.detail).toMatch(/does not exist/);
      expect(report.checks.find((c) => c.name === "free space")!.status).toBe("warn");
    } finally {
      await chmod(path.join(locked, "storage", "app"), 0o755);
    }
    expect(stateDir(makeConfig(root))).toBe(path.join(root, "state"));
  });
});

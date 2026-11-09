import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { acquireLock } from "../../src/core/backup/lock.js";
import { stateDir } from "../../src/core/config/defaults.js";
import { saveConfig } from "../../src/core/config/store.js";
import { eventWriter, readEvents } from "../../src/core/jobs/events.js";
import {
  EXIT_FAILURE,
  EXIT_LOCKED,
  EXIT_OK,
  executeJob,
  getJobCommand,
  killJob,
  setJobCommand,
  startJob,
} from "../../src/core/jobs/runner.js";
import {
  eventsFile,
  type JobRecord,
  jobState,
  listJobs,
  newJobId,
  pruneJobs,
  readJob,
  reconcileJob,
  writeJob,
} from "../../src/core/jobs/store.js";
import { isAlive } from "../../src/core/process.js";
import { installFakeDump, makeConfig, makeLaravelProject, tempDir, waitFor } from "../helpers.js";

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
        projects: [{ name: "shop", path: projectPath }],
        databases: [{ name: "shop", source: { type: "laravel", project: "shop" } }],
      },
      { name: "empty" },
    ],
  });
  const configPath = path.join(root, "config.json");
  await saveConfig(configPath, config);
  return { root, config, configPath, state: stateDir(config) };
}

const finished = (state: string, id: string) =>
  waitFor(
    async () => {
      const job = await readJob(state, id);
      return job && !["queued", "running"].includes(job.status) ? job : null;
    },
    { timeout: 15_000 },
  );

describe("job store", () => {
  test("ids, states, reconcile and prune", async () => {
    const state = await tempDir();
    expect(newJobId(new Date(2026, 0, 2, 3, 4, 5))).toMatch(/^20260102-030405-[0-9a-f]{4}$/);
    expect(jobState([])).toBe("failed");
    expect(jobState([{ environment: "a", backupId: "x", status: "complete" }])).toBe("success");
    expect(
      jobState([
        { environment: "a", backupId: "x", status: "complete" },
        { environment: "b", backupId: null, status: "failed" },
      ]),
    ).toBe("partial");
    expect(jobState([{ environment: "b", backupId: null, status: "failed" }])).toBe("failed");

    const base: JobRecord = {
      id: "20260101-000000-aaaa",
      status: "running",
      trigger: "ui",
      targets: [],
      configPath: "/x",
      detached: true,
      pid: 999_999_999,
      createdAt: new Date().toISOString(),
      backups: [],
    };
    await writeJob(state, base);
    await writeJob(state, {
      ...base,
      id: "20260101-000001-bbbb",
      pid: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      status: "queued",
    });
    await writeJob(state, { ...base, id: "20260101-000002-cccc", pid: process.pid });
    const jobs = await listJobs(state);
    expect(jobs.map((j) => [j.id, j.status, j.error])).toEqual([
      ["20260101-000002-cccc", "running", undefined],
      ["20260101-000001-bbbb", "failed", "job process never started"],
      ["20260101-000000-aaaa", "failed", "job process exited unexpectedly"],
    ]);
    expect(await reconcileJob(state, jobs[1]!)).toBe(jobs[1]);
    expect(await readJob(state, "../etc/passwd")).toBeNull();
    expect(await pruneJobs(state, 1)).toBe(2);
    expect((await listJobs(state)).length).toBe(1);
  });

  test("events are appended in order and read incrementally", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "logs", "x.ndjson");
    expect(await readEvents(file)).toEqual({ events: [], offset: 0 });
    const emit = eventWriter(file);
    emit({ type: "log", level: "info", message: "one" });
    const first = await readEvents(file);
    expect(first.events.map((e) => e.type)).toEqual(["log"]);
    emit({ type: "job-done", status: "success" });
    await appendFile(file, 'garbage\n{"partial":');
    const second = await readEvents(file, first.offset);
    expect(second.events.map((e) => e.type)).toEqual(["job-done"]);
    expect((await readEvents(file, second.offset)).events).toEqual([]);
    await writeFile(file, "");
    expect((await readEvents(file, second.offset)).offset).toBe(0);
  });
});

describe("job runner", () => {
  test("a detached job runs in its own session and completes", async () => {
    const { configPath, state } = await setup();
    const { job, child } = await startJob(state, configPath, [{ environment: "prod" }], {
      trigger: "ui",
      detached: true,
    });
    expect(job.status).toBe("queued");
    const done = await finished(state, job.id);
    expect(done.status).toBe("success");
    expect(done.pid).toBe(child.pid);
    expect(done.backups[0]!.status).toBe("complete");
    expect(done.exitCode).toBe(EXIT_OK);
    const { events } = await readEvents(eventsFile(state, job.id));
    expect(events.at(-1)).toMatchObject({ type: "job-done", status: "success" });
    expect(events.some((e) => e.type === "item-done")).toBe(true);
  });

  test("a daemon job is a normal child and reports its exit code", async () => {
    const { configPath, state } = await setup();
    const { job, child } = await startJob(
      state,
      configPath,
      [{ environment: "empty" }, { environment: "ghost" }],
      {
        trigger: "schedule",
        detached: false,
      },
    );
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(EXIT_FAILURE);
    const done = (await readJob(state, job.id))!;
    expect(done.status).toBe("failed");
    expect(done.backups.map((b) => b.error)).toEqual([
      expect.stringMatching(/nothing selected/),
      "unknown environment",
    ]);
  });

  test("killing a detached job stops the whole process group", async () => {
    const { configPath, state } = await setup();
    process.env.FAKE_DUMP_SLEEP_MS = "30000";
    try {
      const { job } = await startJob(state, configPath, [{ environment: "prod", projects: [] }], {
        trigger: "ui",
        detached: true,
      });
      await waitFor(
        async () =>
          (await readEvents(eventsFile(state, job.id))).events.some((e) => e.type === "item-start"),
        { timeout: 10_000 },
      );
      const running = (await readJob(state, job.id))!;
      expect(running.status).toBe("running");
      expect(await killJob(state, job.id)).toBe(true);
      const done = await finished(state, job.id);
      expect(done.status).toBe("failed");
      expect(done.error).toBe("cancelled");
      await waitFor(() => !isAlive(running.pid));
      expect(await killJob(state, job.id)).toBe(false);
    } finally {
      delete process.env.FAKE_DUMP_SLEEP_MS;
    }
  });

  test("executeJob in-process: lock held → exit 3; missing job → failure", async () => {
    const { configPath, state } = await setup();
    const id = newJobId();
    await writeJob(state, {
      id,
      status: "queued",
      trigger: "ui",
      targets: [{ environment: "prod" }],
      configPath,
      detached: false,
      pid: null,
      createdAt: new Date().toISOString(),
      backups: [],
    });
    const lock = await acquireLock(state, "prod", process.ppid);
    try {
      expect(await executeJob(state, id)).toBe(EXIT_LOCKED);
    } finally {
      await lock.release();
    }
    expect((await readJob(state, id))!.error).toMatch(/already being backed up/);
    expect(await executeJob(state, "20990101-000000-ffff")).toBe(EXIT_FAILURE);
  });

  test("executeJob with an unreadable config fails cleanly", async () => {
    const { state } = await setup();
    const id = newJobId();
    await writeJob(state, {
      id,
      status: "queued",
      trigger: "ui",
      targets: [{ environment: "prod" }],
      configPath: "/nonexistent/config.json",
      detached: false,
      pid: null,
      createdAt: new Date().toISOString(),
      backups: [],
    });
    expect(await executeJob(state, id)).toBe(EXIT_FAILURE);
    expect((await readJob(state, id))!.error).toMatch(/no config file/);
  });
});

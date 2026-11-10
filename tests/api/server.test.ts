import path from "node:path";
import { describe, expect, test } from "vitest";
import { createApi } from "../../src/api/server.js";
import { runBackup } from "../../src/core/backup/pipeline.js";
import { stateDir } from "../../src/core/config/defaults.js";
import { writeJob } from "../../src/core/jobs/store.js";
import { Services } from "../../src/core/services.js";
import {
  fakeSystemd,
  installFakeDump,
  makeConfig,
  makeLaravelProject,
  tempDir,
} from "../helpers.js";

async function setup(token: string | null = null) {
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
          { name: "shop", source: { type: "laravel", project: "shop", password: "hunter2" } },
          {
            name: "rep",
            source: {
              type: "connection",
              host: "db",
              user: "dbadmin",
              passwordFile: "/secret.pw",
              schemas: ["r"],
            },
            extraArgs: ["--password=leak"],
          },
        ],
      },
    ],
  });
  const services = new Services({
    configPath: path.join(root, "c.json"),
    runner: fakeSystemd().runner,
  });
  const backup = await runBackup(config, config.environments[0]!, { databases: ["shop"] });
  await writeJob(stateDir(config), {
    id: "20261109-031500-abcd",
    status: "success",
    trigger: "schedule",
    targets: [{ environment: "prod" }],
    configPath: "/c.json",
    detached: false,
    pid: null,
    createdAt: new Date().toISOString(),
    backups: [{ environment: "prod", backupId: backup.backupId, status: "complete" }],
  });
  const errors: string[] = [];
  let current = config;
  const app = createApi({ services, getConfig: () => current, token, log: (m) => errors.push(m) });
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { headers });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as never as Record<string, unknown> & unknown[],
    };
  };
  return { app, get, backup, errors, setConfig: (c: typeof config) => (current = c) };
}

describe("api", () => {
  test("routes return the expected shapes and never credentials", async () => {
    const { get, backup } = await setup();
    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: "ok",
      environments: 1,
      nextRuns: [{ environment: "prod" }],
    });

    const envs = await get("/environments");
    expect(envs.body[0]).toMatchObject({
      name: "prod",
      backups: 1,
      databases: 2,
      projects: 1,
      running: false,
    });
    expect((envs.body[0] as { nextRun: string }).nextRun).toMatch(/T03:30|T\d\d:30/);

    const env = await get("/environments/prod");
    expect(env.body).toMatchObject({
      name: "prod",
      retention: { keepLast: 7, keepDays: 30 },
      schedule: "30 3 * * *",
      disk: { total: expect.any(Number), free: expect.any(Number), used: expect.any(Number) },
    });
    const disk = (env.body as unknown as { disk: { total: number; free: number } }).disk;
    expect(disk.total).toBeGreaterThan(0);
    expect(disk.free).toBeLessThanOrEqual(disk.total);

    const projects = await get("/environments/prod/projects");
    expect(projects.body).toEqual([
      expect.objectContaining({ name: "shop", include: ["storage/app"] }),
    ]);

    const history = await get("/environments/prod/projects/shop/backups?limit=5");
    expect(history.body).toEqual([
      {
        backupId: backup.backupId,
        createdAt: expect.any(String),
        backupStatus: "complete",
        status: "success",
        size: expect.any(Number),
        durationMs: expect.any(Number),
        detail: "2 files",
        databases: [
          {
            name: "shop",
            status: "success",
            size: expect.any(Number),
            durationMs: expect.any(Number),
          },
        ],
      },
    ]);
    expect((await get("/environments/prod/projects/shop/backups?limit=0")).status).toBe(400);

    const dbs = await get("/environments/prod/databases");
    expect(dbs.body).toEqual([
      {
        name: "shop",
        type: "laravel",
        project: "shop",
        host: null,
        port: null,
        socket: null,
        schemas: null,
      },
      {
        name: "rep",
        type: "connection",
        project: null,
        host: "db",
        port: null,
        socket: null,
        schemas: ["r"],
      },
    ]);
    const all = JSON.stringify([envs.body, env.body, projects.body, dbs.body]);
    for (const secret of ["hunter2", "dbadmin", "secret.pw", "leak", "password", "user"])
      expect(all).not.toContain(secret);

    const backups = await get("/environments/prod/backups?status=complete&limit=5");
    expect(backups.body).toEqual([
      expect.objectContaining({ id: backup.backupId, status: "complete", items: 2, failed: 0 }),
    ]);
    expect((await get("/environments/prod/backups?status=partial")).body).toEqual([]);
    expect((await get("/environments/prod/backups?limit=0")).status).toBe(400);

    const detail = await get(`/environments/prod/backups/${backup.backupId}`);
    expect(detail.body).toMatchObject({
      id: backup.backupId,
      contents: [
        expect.objectContaining({ kind: "database", sha256: expect.any(String) }),
        expect.objectContaining({ kind: "project", detail: "2 files" }),
      ],
    });

    const jobs = await get("/jobs?limit=5");
    expect(jobs.body).toEqual([
      expect.objectContaining({
        id: "20261109-031500-abcd",
        trigger: "schedule",
        environments: ["prod"],
      }),
    ]);
    expect(JSON.stringify(jobs.body)).not.toContain("configPath");

    const docs = await get("/openapi.json");
    expect(docs.body).toMatchObject({ openapi: "3.1.0" });
    expect(JSON.stringify(docs.body)).toContain("/environments/{env}/backups/{id}");
    expect(JSON.stringify(docs.body)).toContain("/environments/{env}/projects/{project}/backups");
  });

  test("404s and sanitized 500s", async () => {
    const { get, app, errors, setConfig } = await setup();
    for (const url of [
      "/environments/nope",
      "/environments/nope/projects",
      "/environments/nope/databases",
      "/environments/nope/projects/shop/backups",
      "/environments/prod/projects/nope/backups",
      "/environments/nope/backups",
      "/environments/nope/backups/x",
      "/environments/prod/backups/20990101-000000",
      "/nothing",
    ]) {
      expect((await get(url)).status).toBe(404);
    }
    const html = await app.request("/docs");
    expect(html.status).toBe(200);
    setConfig(null as never);
    const broken = await get("/environments");
    expect(broken).toEqual({ status: 500, body: { error: "internal error" } });
    expect(errors[0]).toMatch(/api error on \/environments/);
  });

  test("bearer token is required except for /health and docs", async () => {
    const { get } = await setup("s3cret");
    expect((await get("/health")).status).toBe(200);
    expect((await get("/openapi.json")).status).toBe(200);
    expect((await get("/environments")).status).toBe(401);
    expect((await get("/environments", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await get("/environments", { authorization: "Basic s3cret" })).status).toBe(401);
    expect((await get("/environments", { authorization: "Bearer s3cret" })).status).toBe(200);
  });
});

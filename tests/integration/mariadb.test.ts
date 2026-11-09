// Real MariaDB end to end. Runs only when BKM_IT_DB_HOST or BKM_IT_DB_SOCKET is set:
//   BKM_IT_DB_HOST/PORT/USER/PASSWORD or BKM_IT_DB_SOCKET, BKM_IT_DB_NAME (default bkm_it)
//   BKM_IT_DB_CREATE=1 creates the schema and a table first (CI); otherwise the schema is
//   only read (safe against a local server).
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApi } from "../../src/api/server.js";
import { listBackups } from "../../src/core/backup/catalog.js";
import { runBackup } from "../../src/core/backup/pipeline.js";
import { envBackupDir, stateDir } from "../../src/core/config/defaults.js";
import { saveConfig } from "../../src/core/config/store.js";
import { Daemon } from "../../src/core/daemon/daemon.js";
import { getJobCommand, setJobCommand } from "../../src/core/jobs/runner.js";
import { listJobs } from "../../src/core/jobs/store.js";
import { Services } from "../../src/core/services.js";
import {
  fakeSystemd,
  freePort,
  makeConfig,
  makeLaravelProject,
  memoryLogger,
  tempDir,
  waitFor,
} from "../helpers.js";

const env = process.env;
const enabled = Boolean(env.BKM_IT_DB_HOST || env.BKM_IT_DB_SOCKET);
const schema = env.BKM_IT_DB_NAME ?? "bkm_it";
const conn: { socket?: string; host?: string; port?: number; user?: string; password?: string } = {
  ...(env.BKM_IT_DB_SOCKET
    ? { socket: env.BKM_IT_DB_SOCKET }
    : { host: env.BKM_IT_DB_HOST, port: Number(env.BKM_IT_DB_PORT ?? 3306) }),
  ...(env.BKM_IT_DB_USER ? { user: env.BKM_IT_DB_USER } : {}),
  ...(env.BKM_IT_DB_PASSWORD ? { password: env.BKM_IT_DB_PASSWORD } : {}),
};

function sql(statement: string) {
  const args = [
    ...(conn.socket
      ? [`--socket=${conn.socket}`]
      : [`--host=${conn.host}`, `--port=${conn.port}`, "--protocol=TCP"]),
    ...(conn.user ? [`--user=${conn.user}`] : []),
    "-e",
    statement,
  ];
  execFileSync("mariadb", args, {
    env: { ...process.env, MYSQL_PWD: conn.password ?? "" },
    stdio: "pipe",
  });
}

const ENTRY = path.resolve(import.meta.dirname, "../fixtures/job-entry.ts");
let saved: ReturnType<typeof getJobCommand>;

describe.skipIf(!enabled)("mariadb integration", () => {
  beforeAll(() => {
    saved = getJobCommand();
    setJobCommand({ command: process.execPath, args: ["--import", "tsx", ENTRY] });
    if (env.BKM_IT_DB_CREATE === "1") {
      sql(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
      sql(`CREATE TABLE IF NOT EXISTS \`${schema}\`.items (id INT PRIMARY KEY, name VARCHAR(32))`);
      sql(`REPLACE INTO \`${schema}\`.items VALUES (1, 'alpha'), (2, 'beta')`);
    }
  });
  afterAll(() => setJobCommand(saved));

  async function setup(extra: Record<string, unknown> = {}) {
    const root = await tempDir();
    const projectPath = await makeLaravelProject(root);
    const config = makeConfig(root, {
      api: { port: await freePort() },
      environments: [
        {
          name: "it",
          projects: [{ name: "shop", path: projectPath }],
          databases: [{ name: "main", source: { type: "connection", ...conn, schemas: [schema] } }],
          ...extra,
        },
      ],
    });
    const configPath = path.join(root, "config.json");
    await saveConfig(configPath, config);
    return {
      root,
      config,
      configPath,
      services: new Services({ configPath, runner: fakeSystemd().runner }),
    };
  }

  test("connection test, real dump, backup, API and prune", async () => {
    const { config, services } = await setup();
    const e = config.environments[0]!;
    expect(await services.testConnection(e, e.databases[0]!)).toMatchObject({ ok: true });

    const result = await runBackup(config, e);
    expect(result.status).toBe("complete");
    const dump = gunzipSync(
      await readFile(path.join(result.dir!, "databases/main.sql.gz")),
    ).toString();
    expect(dump).toMatch(/-- (MariaDB|MySQL) dump/);
    if (env.BKM_IT_DB_CREATE === "1") expect(dump).toContain("alpha");

    const app = createApi({ services, getConfig: () => config });
    const res = await app.request("/environments/it/backups");
    expect(((await res.json()) as unknown[])[0]).toMatchObject({
      id: result.backupId,
      status: "complete",
    });

    const plans = await services.planPrune(config);
    expect(plans[0]!.delete).toEqual([]);
    expect(await listBackups(envBackupDir(config, e), "it")).toHaveLength(1);
  });

  test("a wrong password fails the item with the server message", async () => {
    const { config, services } = await setup();
    const e = config.environments[0]!;
    const bad = {
      ...e.databases[0]!,
      source: { ...e.databases[0]!.source, user: "bkm_nobody", password: "wrong" },
    };
    const r = await services.testConnection(e, bad as (typeof e.databases)[number]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/denied|ERROR/i);
  });

  test("detached job from the UI facade and a scheduled daemon run", async () => {
    const { config, services } = await setup({ schedule: "* * * * * *" });
    const job = await services.startBackup(config, [{ environment: "it" }]);
    await waitFor(async () => (await services.job(config, job.id))?.status === "success", {
      timeout: 60_000,
    });

    const daemon = new Daemon({ services, log: memoryLogger(), watchConfig: false });
    await daemon.start();
    await waitFor(
      async () =>
        (await listJobs(stateDir(config))).some(
          (j) => j.trigger === "schedule" && j.status === "success",
        ),
      {
        timeout: 60_000,
      },
    );
    await daemon.stop();
  });
});

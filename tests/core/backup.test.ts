import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { archiveProject, excludeMatcher } from "../../src/core/backup/archive.js";
import {
  dateFromId,
  diskUsage,
  listBackups,
  listTempDirs,
  readBackup,
} from "../../src/core/backup/catalog.js";
import { acquireLock, LockHeldError, lockHolder } from "../../src/core/backup/lock.js";
import { backupStatus, readManifest, writeManifest } from "../../src/core/backup/manifest.js";
import {
  buildDumpArgs,
  checkConnection,
  DumpError,
  describeConnection,
  dumpDatabase,
  renderOptionFile,
  resolveConnection,
} from "../../src/core/backup/mariadb.js";
import { NothingToBackUpError, runBackup } from "../../src/core/backup/pipeline.js";
import { applyPrune, planPrune } from "../../src/core/backup/prune.js";
import { selectForDeletion } from "../../src/core/backup/retention.js";
import { envBackupDir } from "../../src/core/config/defaults.js";
import type { JobEvent } from "../../src/core/jobs/events.js";
import { findExecutable, isAlive } from "../../src/core/process.js";
import { installFakeDump, makeConfig, makeLaravelProject, tempDir } from "../helpers.js";

const day = 86_400_000;
const now = new Date("2026-11-09T12:00:00Z");
const b = (
  id: string,
  ageDays: number,
  status: "complete" | "partial" | "incomplete" = "complete",
) => ({
  id,
  createdAt: new Date(now.getTime() - ageDays * day),
  status,
});

describe("retention", () => {
  test("keepLast or keepDays protects complete backups", () => {
    const backups = [b("a", 0), b("b", 1), b("c", 2), b("d", 10), b("e", 40)];
    expect(selectForDeletion(backups, { keepLast: 2, keepDays: 5 }, now).map((x) => x.id)).toEqual([
      "d",
      "e",
    ]);
    expect(selectForDeletion(backups, { keepLast: 4, keepDays: 0 }, now).map((x) => x.id)).toEqual([
      "e",
    ]);
  });

  test("newest complete is always kept; failures newer than it survive", () => {
    const backups = [b("p1", 0, "partial"), b("c1", 50), b("p2", 60, "incomplete"), b("c2", 70)];
    expect(selectForDeletion(backups, { keepLast: 0, keepDays: 1 }, now).map((x) => x.id)).toEqual([
      "p2",
      "c2",
    ]);
    expect(selectForDeletion([b("x", 90, "partial")], { keepLast: 1, keepDays: 1 }, now)).toEqual(
      [],
    );
  });
});

describe("catalog, manifest and prune", () => {
  test("lists backups newest first, reads manifests and incomplete dirs", async () => {
    const root = await tempDir();
    const config = makeConfig(root, {
      retention: { keepLast: 1, keepDays: 0 },
      environments: [{ name: "prod" }],
    });
    const env = config.environments[0]!;
    const dir = envBackupDir(config, env);
    await mkdir(path.join(dir, "20261101-030000"), { recursive: true });
    await writeFile(path.join(dir, "20261101-030000", "x"), "12345");
    await mkdir(path.join(dir, "20261105-030000"), { recursive: true });
    await writeManifest(path.join(dir, "20261105-030000"), {
      version: 1,
      id: "20261105-030000",
      environment: "prod",
      createdAt: new Date(2026, 10, 5, 3).toISOString(),
      finishedAt: new Date(2026, 10, 5, 3, 1).toISOString(),
      status: "complete",
      totalSize: 10,
      items: [
        {
          kind: "database",
          name: "db",
          file: "databases/db.sql.gz",
          size: 10,
          sha256: "x",
          durationMs: 1,
          status: "success",
        },
      ],
    });
    await mkdir(path.join(dir, "not-a-backup"));
    await mkdir(path.join(dir, ".tmp-20261106-030000"));
    const old = new Date(Date.now() - 2 * day);
    await utimes(path.join(dir, ".tmp-20261106-030000"), old, old);

    const list = await listBackups(dir, "prod");
    expect(list.map((x) => [x.id, x.status, x.size])).toEqual([
      ["20261105-030000", "complete", 10],
      ["20261101-030000", "incomplete", 5],
    ]);
    expect(await readBackup(dir, "prod", "nope")).toBeNull();
    expect(await readBackup(dir, "prod", "20261107-000000")).toBeNull();
    expect(await listBackups(path.join(root, "missing"), "x")).toEqual([]);
    expect((await listTempDirs(dir)).length).toBe(1);
    expect(dateFromId("20261105-030000-2")?.getDate()).toBe(5);
    expect(dateFromId("x")).toBeNull();
    expect(await readManifest(path.join(dir, "20261101-030000"))).toBeNull();

    const plan = await planPrune(config, env);
    expect(plan.delete.map((x) => x.id)).toEqual(["20261101-030000"]);
    expect(plan.staleTemp).toHaveLength(1);
    expect(plan.freedBytes).toBe(5);
    const result = await applyPrune(plan);
    expect(result.deleted).toHaveLength(2);
    expect((await listBackups(dir, "prod")).map((x) => x.id)).toEqual(["20261105-030000"]);
  });

  test("diskUsage measures the nearest existing parent of a missing directory", async () => {
    const root = await tempDir();
    const usage = await diskUsage(path.join(root, "not", "created", "yet"));
    expect(usage).toEqual({
      total: expect.any(Number),
      free: expect.any(Number),
      used: expect.any(Number),
    });
    expect(usage!.total).toBeGreaterThan(0);
    expect(usage!.free + usage!.used).toBeLessThanOrEqual(usage!.total);
  });

  test("backupStatus", () => {
    const ok = { status: "success" } as never;
    const bad = { status: "failed" } as never;
    expect(backupStatus([ok, ok])).toBe("complete");
    expect(backupStatus([ok, bad])).toBe("partial");
    expect(backupStatus([bad])).toBe("incomplete");
    expect(backupStatus([])).toBe("incomplete");
  });
});

describe("lock", () => {
  test("exclusive per environment, stale locks are taken over", async () => {
    const root = await tempDir();
    const lock = await acquireLock(root, "prod");
    expect(await lockHolder(root, "prod")).toBe(process.pid);
    await expect(acquireLock(root, "prod", process.ppid)).rejects.toBeInstanceOf(LockHeldError);
    await lock.release();
    expect(await lockHolder(root, "prod")).toBeNull();
    await writeFile(path.join(root, "locks", "prod.lock"), "999999999\n");
    const again = await acquireLock(root, "prod");
    await again.release();
    expect(isAlive(999_999_999)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });
});

describe("archive", () => {
  test("glob excludes keep empty directories and dotfile rules apply", async () => {
    const root = await tempDir();
    const projectPath = await makeLaravelProject(root);
    const dest = path.join(root, "out.tar.gz");
    const project = {
      name: "shop",
      path: projectPath,
      include: ["storage", "missing"],
      exclude: ["storage/framework/{cache,sessions,views}/**", "storage/logs/**", "**/.gitignore"],
    };
    const progress: number[] = [];
    const result = await archiveProject(project, dest, {
      onProgress: (p) => progress.push(p.files),
    });
    expect(result.warnings).toEqual([expect.stringContaining("'missing' not found")]);
    expect(result.files).toBe(2);
    expect(progress.at(-1)).toBe(2);
    const listing = execFileSync("tar", ["-tzf", dest], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(listing).toContain("storage/app/public/a.txt");
    expect(listing).toContain("storage/logs/");
    expect(listing).toContain("storage/framework/cache/");
    expect(listing.some((l) => l.includes("laravel.log"))).toBe(false);
    expect(listing.some((l) => l.endsWith(".gitignore"))).toBe(false);
    expect(listing.some((l) => l.includes("cache/data"))).toBe(false);
  });

  test("fails when nothing to include; rejects paths outside", async () => {
    const root = await tempDir();
    const project = { name: "x", path: root, include: ["../etc", "nope"], exclude: [] };
    await expect(archiveProject(project, path.join(root, "o.tgz"))).rejects.toThrow(
      /none of the include paths/,
    );
  });

  test("excludeMatcher", () => {
    const m = excludeMatcher(["a/**", "*.tmp"]);
    expect(m("a", true)).toBe(false);
    expect(m("a/b", false)).toBe(true);
    expect(m("x.tmp", false)).toBe(true);
    expect(m("b", true)).toBe(false);
  });
});

describe("mariadb", () => {
  const env = (projectPath: string) =>
    makeConfig("/tmp/x", {
      environments: [
        {
          name: "prod",
          projects: [{ name: "shop", path: projectPath }],
          databases: [
            { name: "shop", source: { type: "laravel", project: "shop" } },
            {
              name: "over",
              source: {
                type: "laravel",
                project: "shop",
                host: "db",
                port: 3307,
                database: "other",
              },
            },
            {
              name: "rep",
              source: { type: "connection", socket: "/run/s.sock", user: "u", schemas: ["a", "b"] },
            },
          ],
        },
      ],
    }).environments[0]!;

  test("resolves Laravel .env with overrides and connection sources", async () => {
    const root = await tempDir();
    const e = env(await makeLaravelProject(root));
    const shop = await resolveConnection(e.databases[0]!, e);
    expect(shop).toEqual({
      host: "127.0.0.1",
      port: 3306,
      socket: undefined,
      user: "app",
      password: "secret",
      schemas: ["shop"],
    });
    const over = await resolveConnection(e.databases[1]!, e);
    expect([over.host, over.port, over.schemas]).toEqual(["db", 3307, ["other"]]);
    const rep = await resolveConnection(e.databases[2]!, e);
    expect(describeConnection(rep)).toBe("a, b @ /run/s.sock");
    expect(describeConnection(shop)).toBe("shop @ 127.0.0.1:3306");
  });

  test("resolution errors", async () => {
    const root = await tempDir();
    const pg = await makeLaravelProject(root, "pg", "DB_CONNECTION=pgsql\nDB_DATABASE=x\n");
    let e = env(pg);
    await expect(resolveConnection(e.databases[0]!, e)).rejects.toThrow(/only mysql\/mariadb/);
    const badPort = await makeLaravelProject(root, "bp", "DB_PORT=abc\nDB_DATABASE=x\n");
    e = env(badPort);
    await expect(resolveConnection(e.databases[0]!, e)).rejects.toThrow(/DB_PORT/);
    const noDb = await makeLaravelProject(root, "nd", "DB_HOST=h\n");
    e = env(noDb);
    await expect(resolveConnection(e.databases[0]!, e)).rejects.toThrow(/no schema/);
    e = env(path.join(root, "missing"));
    await expect(resolveConnection(e.databases[0]!, e)).rejects.toThrow(/cannot read/);
    const withPwFile = {
      name: "p",
      source: {
        type: "connection" as const,
        passwordFile: path.join(root, "nope.pw"),
        schemas: ["a"],
      },
      extraArgs: [],
    };
    await expect(resolveConnection(withPwFile, e)).rejects.toThrow(/passwordFile/);
    await writeFile(path.join(root, "ok.pw"), 's3cr"et\nignored\n');
    withPwFile.source.passwordFile = path.join(root, "ok.pw");
    expect((await resolveConnection(withPwFile, e)).password).toBe('s3cr"et');
  });

  test("option file and args keep secrets out of argv", () => {
    const conn = {
      host: "h",
      port: 1,
      socket: "/s",
      user: 'u"x',
      password: "p\\w",
      schemas: ["one"],
    };
    expect(renderOptionFile(conn)).toBe(
      '[client]\nhost="h"\nport=1\nsocket="/s"\nuser="u\\"x"\npassword="p\\\\w"\n',
    );
    expect(buildDumpArgs("/f.cnf", conn, ["--x"])).toEqual([
      "--defaults-extra-file=/f.cnf",
      "--single-transaction",
      "--quick",
      "--routines",
      "--triggers",
      "--events",
      "--hex-blob",
      "--x",
      "one",
    ]);
    expect(buildDumpArgs("/f", { schemas: ["a", "b"] }).slice(-3)).toEqual([
      "--databases",
      "a",
      "b",
    ]);
  });

  test("dump streams gzip through the fake binary; failures keep stderr", async () => {
    const root = await tempDir();
    const log = await installFakeDump(root);
    const dest = path.join(root, "out", "db.sql.gz");
    const progress: number[] = [];
    const bytes = await dumpDatabase({ user: "u", password: "pw", schemas: ["a", "b"] }, dest, {
      onProgress: (n) => progress.push(n),
    });
    const sql = gunzipSync(await readFile(dest)).toString();
    expect(sql).toContain("-- schemas: a,b");
    expect(bytes).toBe(Buffer.byteLength(sql));
    expect(progress.at(-1)).toBe(bytes);
    expect((await stat(dest)).mode & 0o777).toBe(0o600);
    const call = JSON.parse((await readFile(log, "utf8")).trim().split("\n")[0]!);
    expect(call.args.join(" ")).not.toContain("pw");
    expect(call.cnf).toContain('password="pw"');

    await expect(dumpDatabase({ password: "wrong", schemas: ["a"] }, dest)).rejects.toThrow(
      /Access denied/,
    );
    await expect(stat(dest)).rejects.toThrow();
    await expect(
      dumpDatabase({ schemas: ["a"] }, dest, { binary: path.join(root, "nope") }),
    ).rejects.toBeInstanceOf(DumpError);

    await checkConnection({ schemas: ["a"] });
    await expect(checkConnection({ password: "wrong", schemas: ["a"] })).rejects.toThrow(
      /Access denied/,
    );
    await expect(checkConnection({ schemas: ["a"] }, path.join(root, "nope"))).rejects.toThrow(
      /cannot run/,
    );
    expect(await findExecutable(["definitely-not-here-xyz"])).toBeNull();
  });

  test("abort kills the dump", async () => {
    const root = await tempDir();
    await installFakeDump(root);
    process.env.FAKE_DUMP_SLEEP_MS = "10000";
    try {
      const controller = new AbortController();
      const started = Date.now();
      const promise = dumpDatabase({ schemas: ["a"] }, path.join(root, "x.gz"), {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 200);
      await expect(promise).rejects.toThrow(/aborted/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      delete process.env.FAKE_DUMP_SLEEP_MS;
    }
  });
});

describe("pipeline", () => {
  async function setup(extra: Record<string, unknown> = {}) {
    const root = await tempDir();
    await installFakeDump(root);
    const projectPath = await makeLaravelProject(root);
    const config = makeConfig(root, {
      retention: { keepLast: 1, keepDays: 0 },
      environments: [
        {
          name: "prod",
          projects: [{ name: "shop", path: projectPath }],
          databases: [
            { name: "shop", source: { type: "laravel", project: "shop" } },
            { name: "bad", source: { type: "connection", password: "wrong", schemas: ["x"] } },
          ],
          ...extra,
        },
      ],
    });
    return { root, config, env: config.environments[0]! };
  }

  test("partial backup keeps good items, writes manifest with sha256", async () => {
    const { config, env } = await setup();
    const events: JobEvent["type"][] = [];
    const result = await runBackup(
      config,
      env,
      {},
      { emit: (e) => events.push(e.type), jobId: "j", trigger: "ui" },
    );
    expect(result.status).toBe("partial");
    const manifest = result.manifest!;
    expect(manifest.items.map((i) => [i.name, i.status])).toEqual([
      ["shop", "success"],
      ["bad", "failed"],
      ["shop", "success"],
    ]);
    expect(manifest.items[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.items[1]!.error).toMatch(/Access denied/);
    expect(manifest.items[2]!.detail).toBe("2 files");
    expect(await readManifest(result.dir!)).toEqual(manifest);
    expect(events).toContain("item-start");
    expect(events).toContain("item-done");
    expect(events.at(-1)).toBe("backup-done");
  });

  test("complete backups auto-prune; selection filters items; ids never collide", async () => {
    const { config, env } = await setup();
    const fixed = () => new Date(2026, 10, 9, 3, 0, 0);
    const first = await runBackup(
      config,
      env,
      { databases: ["shop"], projects: [] },
      { now: fixed },
    );
    expect(first.status).toBe("complete");
    const second = await runBackup(
      config,
      env,
      { databases: ["shop"], projects: [] },
      { now: fixed },
    );
    expect(second.backupId).toBe(`${first.backupId}-1`);
    expect(second.pruned).toEqual([first.dir]);
    await expect(runBackup(config, env, { databases: [], projects: [] })).rejects.toBeInstanceOf(
      NothingToBackUpError,
    );
  });

  test("all items failing removes the backup", async () => {
    const { config, env } = await setup();
    const result = await runBackup(config, env, { databases: ["bad"], projects: [] });
    expect(result.status).toBe("failed");
    expect(await listBackups(envBackupDir(config, env), "prod")).toEqual([]);
  });

  test("an aborted run is discarded", async () => {
    const { config, env } = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await runBackup(config, env, {}, { signal: controller.signal });
    expect(result.status).toBe("failed");
  });
});

describe("cancellation races", () => {
  test("a signal aborted before the dump starts never spawns it", async () => {
    const root = await tempDir();
    const log = await installFakeDump(root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      dumpDatabase({ schemas: ["a"] }, path.join(root, "x.gz"), { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    await expect(readFile(log, "utf8")).rejects.toThrow();
  });
});

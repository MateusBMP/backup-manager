import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  effectiveRetention,
  emptyConfig,
  envBackupDir,
  minimizeConfig,
} from "../../src/core/config/defaults.js";
import {
  ConfigError,
  ConfigMissingError,
  formatIssuePath,
  loadConfig,
  parseConfig,
} from "../../src/core/config/load.js";
import { configJsonSchema, DEFAULT_EXCLUDE } from "../../src/core/config/schema.js";
import { ConfigConflictError, saveConfig, serializeConfig } from "../../src/core/config/store.js";
import { makeConfig, tempDir } from "../helpers.js";

const env = (extra: Record<string, unknown> = {}) => ({
  name: "prod",
  projects: [{ name: "shop", path: "/srv/shop" }],
  databases: [{ name: "shop", source: { type: "laravel", project: "shop" } }],
  ...extra,
});

function issues(data: unknown): string[] {
  try {
    parseConfig(data);
  } catch (error) {
    return (error as ConfigError).issues;
  }
  return [];
}

describe("schema", () => {
  test("empty config is valid and filled with defaults", () => {
    const config = parseConfig({});
    expect(config.environments).toEqual([]);
    expect(config.settings.compressLevel).toBe(6);
    expect(config.retention).toEqual({ keepLast: 7, keepDays: 30 });
    expect(config.api).toEqual({ enabled: true, host: "127.0.0.1", port: 8080 });
    expect(emptyConfig().$schema).toContain("config.schema.json");
  });

  test("project defaults and both source types", () => {
    const config = parseConfig({
      environments: [
        env({
          schedule: "30 3 * * *",
          databases: [
            { name: "shop", source: { type: "laravel", project: "shop", database: "x" } },
            { name: "rep", source: { type: "connection", host: "db", schemas: ["a", "b"] } },
          ],
        }),
      ],
    });
    const e = config.environments[0]!;
    expect(e.projects[0]!.include).toEqual(["storage/app"]);
    expect(e.projects[0]!.exclude).toEqual(DEFAULT_EXCLUDE);
    expect(e.databases[1]!.extraArgs).toEqual([]);
  });

  test.each([
    [{ environments: [env({ name: "Bad Name" })] }, "environments[0].name"],
    [{ environments: [env(), env()] }, "environments[1].name: duplicate environment"],
    [{ environments: [env({ schedule: "nope" })] }, "environments[0].schedule: invalid cron"],
    [{ settings: { timezone: "Mars/Base" } }, "settings.timezone: unknown timezone"],
    [{ settings: { compressLevel: 12 } }, "settings.compressLevel"],
    [
      { retention: { keepLast: 0, keepDays: 0 } },
      "retention: keepLast and keepDays cannot both be 0",
    ],
    [
      { environments: [env({ retention: { keepLast: 0 } })], retention: { keepDays: 0 } },
      "environments[0].retention",
    ],
    [{ api: { token: "a", tokenFile: "b" } }, "api.tokenFile"],
    [{ api: { port: 0 } }, "api.port"],
    [{ unknown: 1 }, "(root)"],
    [
      {
        environments: [
          env({ databases: [{ name: "x", source: { type: "laravel", project: "nope" } }] }),
        ],
      },
      "environments[0].databases[0].source.project: unknown project",
    ],
    [
      {
        environments: [
          env({ databases: [{ name: "x", source: { type: "connection", schemas: [] } }] }),
        ],
      },
      "environments[0].databases[0].source.schemas",
    ],
    [
      {
        environments: [
          env({
            databases: [
              {
                name: "x",
                source: { type: "connection", schemas: ["a"], password: "p", passwordFile: "f" },
              },
            ],
          }),
        ],
      },
      "source.passwordFile: set password or passwordFile",
    ],
    [
      {
        environments: [
          env({
            projects: [
              { name: "a", path: "/a" },
              { name: "a", path: "/b" },
            ],
            databases: [],
          }),
        ],
      },
      "environments[0].projects[1].name: duplicate project",
    ],
    [
      {
        environments: [
          env({
            databases: [
              { name: "a", source: { type: "connection", schemas: ["s"] } },
              { name: "a", source: { type: "connection", schemas: ["s"] } },
            ],
          }),
        ],
      },
      "databases[1].name: duplicate database",
    ],
    [
      {
        settings: { backupDir: "/b" },
        environments: [env({ name: "a" }), env({ name: "b", backupDir: "/b/a" })],
      },
      "environments[1].backupDir: backup directory is already used by environment 'a'",
    ],
  ])("rejects %j", (data, expected) => {
    expect(issues(data).join("\n")).toContain(expected);
  });

  test("six-field schedules are accepted", () => {
    expect(issues({ environments: [env({ schedule: "*/5 * * * * *" })] })).toEqual([]);
  });

  test("formatIssuePath", () => {
    expect(formatIssuePath(["environments", 0, "databases", 1, "source"])).toBe(
      "environments[0].databases[1].source",
    );
    expect(formatIssuePath([])).toBe("(root)");
  });

  test("JSON schema exposes descriptions and defaults", () => {
    const schema = configJsonSchema() as { properties: Record<string, unknown>; $id: string };
    expect(schema.$id).toContain("config.schema.json");
    expect(JSON.stringify(schema)).toContain("Cron expression");
  });
});

describe("defaults", () => {
  test("env backup dir and effective retention", async () => {
    const root = await tempDir();
    const config = makeConfig(root, {
      retention: { keepLast: 3 },
      environments: [env(), env({ name: "stage", backupDir: "/x/y", retention: { keepDays: 2 } })],
    });
    expect(envBackupDir(config, config.environments[0]!)).toBe(path.join(root, "backups", "prod"));
    expect(envBackupDir(config, config.environments[1]!)).toBe("/x/y");
    expect(effectiveRetention(config, config.environments[1]!)).toEqual({
      keepLast: 3,
      keepDays: 2,
    });
  });

  test("minimizeConfig drops defaults and empty sections", () => {
    const config = parseConfig({
      settings: { compressLevel: 9, autoPrune: true },
      api: { port: 8080, token: "t" },
      environments: [
        env({
          projects: [
            { name: "shop", path: "/srv/shop", include: ["storage/app"], exclude: ["x/**"] },
          ],
        }),
      ],
    });
    const min = minimizeConfig(config);
    expect(min.settings).toEqual({ compressLevel: 9 });
    expect(min.retention).toBeUndefined();
    expect(min.api).toEqual({ token: "t" });
    const project = (min.environments as { projects: Record<string, unknown>[] }[])[0]!
      .projects[0]!;
    expect(project).toEqual({ name: "shop", path: "/srv/shop", exclude: ["x/**"] });
    expect(parseConfig(min)).toEqual({ ...config, $schema: expect.any(String) });
    expect(minimizeConfig(emptyConfig())).toEqual({
      $schema: expect.any(String),
      version: 1,
      environments: [],
    });
  });
});

describe("load and store", () => {
  test("missing, invalid JSON and invalid content", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "config.json");
    await expect(loadConfig(file)).rejects.toBeInstanceOf(ConfigMissingError);
    await writeFile(file, "{ nope");
    await expect(loadConfig(file)).rejects.toThrow(/not valid JSON/);
    await writeFile(file, JSON.stringify({ settings: { compressLevel: 0 } }));
    await expect(loadConfig(file)).rejects.toThrow(/settings.compressLevel/);
  });

  test("unreadable path", async () => {
    const dir = await tempDir();
    await expect(loadConfig(dir)).rejects.toThrow(/cannot read/);
  });

  test("save is minimal, atomic, 0600, keeps a .bak and detects conflicts", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "nested", "config.json");
    const config = makeConfig(dir, { environments: [env()] });
    const mtime = await saveConfig(file, config, { expectedMtimeMs: null });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const loaded = await loadConfig(file);
    expect(loaded.config).toEqual({ ...config, $schema: expect.any(String) });
    expect(loaded.mtimeMs).toBe(mtime);
    expect(await readFile(file, "utf8")).toBe(serializeConfig(config));

    config.settings.compressLevel = 9;
    await saveConfig(file, config, { expectedMtimeMs: mtime });
    expect(await readFile(`${file}.bak`, "utf8")).not.toContain("compressLevel");
    expect(await readFile(file, "utf8")).toContain('"compressLevel": 9');

    await expect(
      saveConfig(file, config, { expectedMtimeMs: mtime - 1000 }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    await expect(saveConfig(file, config, { expectedMtimeMs: null })).rejects.toBeInstanceOf(
      ConfigConflictError,
    );
    await saveConfig(file, config); // no expectation: always writes
  });

  test("refuses to write an invalid config", async () => {
    const dir = await tempDir();
    const config = makeConfig(dir);
    config.settings.compressLevel = 42;
    await expect(saveConfig(path.join(dir, "c.json"), config)).rejects.toBeInstanceOf(ConfigError);
  });
});

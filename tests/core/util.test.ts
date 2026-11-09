import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dotenvGet, loadDotenv, parseDotenv } from "../../src/core/dotenv.js";
import {
  formatAge,
  formatBytes,
  formatDateTime,
  formatDuration,
  timestampId,
  truncate,
} from "../../src/core/format.js";
import {
  defaultBackupDir,
  defaultConfigPath,
  defaultStateDir,
  expandHome,
  resolveConfigPath,
} from "../../src/core/paths.js";
import {
  describeSchedule,
  isValidTimezone,
  nextRun,
  nextRuns,
  previousRun,
  scheduleError,
} from "../../src/core/schedule.js";
import { tempDir } from "../helpers.js";

describe("dotenv", () => {
  test("parses Laravel style files", async () => {
    const env = parseDotenv(
      [
        "# comment",
        "",
        "APP_NAME=Shop",
        "export DB_HOST=127.0.0.1",
        'DB_PASSWORD="p\\"a\\nss"',
        "DB_USERNAME='single # not comment'",
        "DB_DATABASE=shop # inline comment",
        "EMPTY=",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal .env interpolation
        "URL=${APP_URL}/x",
        'OPEN="unterminated',
        "not a line",
      ].join("\n"),
    );
    expect(env.values.APP_NAME).toBe("Shop");
    expect(env.values.DB_HOST).toBe("127.0.0.1");
    expect(env.values.DB_PASSWORD).toBe('p"a\nss');
    expect(env.values.DB_USERNAME).toBe("single # not comment");
    expect(env.values.DB_DATABASE).toBe("shop");
    expect(env.values.OPEN).toBe("unterminated");
    expect(dotenvGet(env, "EMPTY")).toBeUndefined();
    expect(dotenvGet(env, "APP_NAME")).toBe("Shop");
    expect(env.warnings).toHaveLength(2);
    const dir = await tempDir();
    await writeFile(path.join(dir, ".env"), "A=1\n");
    expect((await loadDotenv(path.join(dir, ".env"))).values.A).toBe("1");
  });
});

describe("format", () => {
  test("bytes, durations, ages, dates, ids", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(3.1 * 1024 ** 3)).toBe("3.1 GiB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatDuration(41_000)).toBe("41s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
    expect(formatDuration(Number.NaN)).toBe("—");
    const now = new Date("2026-11-09T12:00:00Z");
    expect(formatAge(now, now)).toBe("now");
    expect(formatAge(new Date(now.getTime() - 30_000), now)).toBe("30s ago");
    expect(formatAge(new Date(now.getTime() - 5 * 60_000), now)).toBe("5m ago");
    expect(formatAge(new Date(now.getTime() - 9 * 3600_000), now)).toBe("9h ago");
    expect(formatAge(new Date(now.getTime() - 2 * 86_400_000), now)).toBe("2d ago");
    expect(formatAge(new Date(now.getTime() - 30 * 86_400_000), now)).toBe("4w ago");
    expect(formatAge(new Date(now.getTime() + 3600_000), now)).toBe("in 1h");
    expect(formatAge("garbage", now)).toBe("—");
    expect(formatDateTime(new Date(2026, 10, 9, 3, 5))).toBe("2026-11-09 03:05");
    expect(formatDateTime("x")).toBe("—");
    expect(timestampId(new Date(2026, 10, 9, 3, 15, 7))).toBe("20261109-031507");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("ab", 4)).toBe("ab");
    expect(truncate("ab", 0)).toBe("");
  });
});

describe("paths", () => {
  test("xdg defaults and lookup order", () => {
    expect(expandHome("~/x")).toBe(path.join(homedir(), "x"));
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("/a")).toBe("/a");
    const env = { XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "relative" };
    expect(defaultConfigPath(env)).toBe("/c/backup-manager/config.json");
    expect(defaultBackupDir(env)).toBe("/d/backup-manager/backups");
    expect(defaultStateDir(env)).toBe(path.join(homedir(), ".local/state/backup-manager"));
    expect(resolveConfigPath("/x.json", env)).toBe("/x.json");
    expect(resolveConfigPath(undefined, { ...env, BKM_CONFIG: "/y.json" })).toBe("/y.json");
    expect(resolveConfigPath(undefined, env)).toBe("/c/backup-manager/config.json");
  });
});

describe("schedule", () => {
  test("validation, next and previous runs", () => {
    expect(scheduleError("30 3 * * *")).toBeNull();
    expect(scheduleError("bad")).toBeTruthy();
    const from = new Date("2026-11-09T12:00:00Z");
    const runs = nextRuns("30 3 * * *", 3, "UTC", from);
    expect(runs.map((d) => d.toISOString())).toEqual([
      "2026-11-10T03:30:00.000Z",
      "2026-11-11T03:30:00.000Z",
      "2026-11-12T03:30:00.000Z",
    ]);
    expect(nextRuns("bad", 3)).toEqual([]);
    expect(nextRun(undefined)).toBeNull();
    expect(nextRun("30 3 * * *", "UTC", from)?.toISOString()).toBe("2026-11-10T03:30:00.000Z");
    expect(previousRun("30 3 * * *", from, "UTC")?.toISOString()).toBe("2026-11-09T03:30:00.000Z");
    expect(previousRun("bad", from)).toBeNull();
    expect(isValidTimezone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimezone("Nope/Nope")).toBe(false);
  });

  test.each([
    ["* * * * *", "every minute"],
    ["*/15 * * * *", "every 15 minutes"],
    ["5 * * * *", "hourly at minute 5"],
    ["0 */6 * * *", "every 6 hours at minute 0"],
    ["30 3 * * *", "daily at 03:30"],
    ["0 2 * * 0", "weekly on Sunday at 02:00"],
    ["0 2 * * 1-5", "weekdays at 02:00"],
    ["0 4 1 * *", "monthly on day 1 at 04:00"],
    ["*/10 * * * * *", "every 10 seconds"],
    ["0 30 3 * * *", "daily at 03:30"],
    ["5 30 3 * * *", "custom: 5 30 3 * * *"],
    ["0 3 1-7 * 1", "custom: 0 3 1-7 * 1"],
    ["bad", "bad"],
  ])("describe %s", (expr, text) => {
    expect(describeSchedule(expr)).toBe(text);
  });
});

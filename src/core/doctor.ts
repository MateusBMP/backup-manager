import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CLIENT_BINARIES,
  checkConnection,
  DUMP_BINARIES,
  resolveConnection,
} from "./backup/mariadb.js";
import { backupRoot, envBackupDir, stateDir, timezone } from "./config/defaults.js";
import { ConfigError, ConfigMissingError, type LoadedConfig, loadConfig } from "./config/load.js";
import type { Config } from "./config/schema.js";
import { formatBytes, formatDateTime } from "./format.js";
import { findExecutable } from "./process.js";
import { describeSchedule, nextRun } from "./schedule.js";
import type { ServiceManager } from "./service/manager.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  group: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  configPath: string;
  checks: Check[];
  ok: boolean;
  /** true when no config file exists (the CLI exits 2). */
  missingConfig: boolean;
}

export interface DoctorOptions {
  configPath: string;
  db?: boolean;
  service?: ServiceManager;
  minFreeBytes?: number;
}

async function writable(dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.bkm-doctor-${process.pid}`);
    await writeFile(probe, "");
    await rm(probe, { force: true });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

async function groupName(gid: number): Promise<string> {
  const text = await readFile("/etc/group", "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const [name, , id] = line.split(":");
    if (name && Number(id) === gid) return name;
  }
  return String(gid);
}

async function readable(target: string, dir: boolean): Promise<string | null> {
  try {
    await access(target, dir ? constants.R_OK | constants.X_OK : constants.R_OK);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "does not exist";
    const info = await stat(target).catch(() => null);
    const hint = info
      ? ` (owned by group '${await groupName(info.gid)}'; add yourself with \`sudo usermod -aG ${await groupName(info.gid)} $USER\`)`
      : "";
    return `not readable${hint}`;
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (group: string, name: string, status: CheckStatus, detail: string) =>
    checks.push({ group, name, status, detail });
  let loaded: LoadedConfig | null = null;
  let missingConfig = false;
  try {
    loaded = await loadConfig(options.configPath);
    add("config", "config file", "ok", `${options.configPath} is valid`);
  } catch (error) {
    missingConfig = error instanceof ConfigMissingError;
    if (error instanceof ConfigError && error.issues.length) {
      for (const issue of error.issues) add("config", "config file", "fail", issue);
    } else {
      add("config", "config file", "fail", (error as Error).message);
    }
  }

  const dump = await findExecutable(DUMP_BINARIES);
  add(
    "tools",
    "dump client",
    dump ? "ok" : "fail",
    dump ?? `none of ${DUMP_BINARIES.join(", ")} on PATH (install mariadb-client)`,
  );
  const client = await findExecutable(CLIENT_BINARIES);
  add(
    "tools",
    "sql client",
    client ? "ok" : "warn",
    client ?? `none of ${CLIENT_BINARIES.join(", ")} on PATH (needed for connection tests)`,
  );

  if (loaded) await checkConfig(loaded.config, options, add);

  if (options.service) {
    const s = await options.service.status();
    if (!s.available) {
      add("service", "systemd", "warn", `systemctl --user unavailable: ${s.error ?? "unknown"}`);
    } else if (!s.installed) {
      add(
        "service",
        "unit",
        "warn",
        "not installed; open `bkm` → Service → Install / update to run schedules",
      );
    } else {
      add(
        "service",
        "unit",
        s.outdated ? "warn" : "ok",
        s.outdated
          ? `${s.unitPath} is outdated; open \`bkm\` → Service → Install / update`
          : s.unitPath,
      );
      add(
        "service",
        "active",
        s.activeState === "active" ? "ok" : "warn",
        `${s.activeState} (${s.subState})${s.mainPid ? `, pid ${s.mainPid}` : ""}`,
      );
      add("service", "enabled", s.enabled === "enabled" ? "ok" : "warn", s.enabled);
      add(
        "service",
        "linger",
        s.linger ? "ok" : "warn",
        s.linger === null
          ? "unknown"
          : s.linger
            ? "enabled (runs at boot and after logout)"
            : "disabled: the service stops when you log out (`loginctl enable-linger`)",
      );
    }
  }

  return {
    configPath: options.configPath,
    checks,
    ok: !checks.some((c) => c.status === "fail"),
    missingConfig,
  };
}

async function checkConfig(
  config: Config,
  options: DoctorOptions,
  add: (group: string, name: string, status: CheckStatus, detail: string) => void,
) {
  const tz = timezone(config);
  if (config.environments.length === 0)
    add("config", "environments", "warn", "no environments yet; add one in `bkm`");
  for (const env of config.environments) {
    if (env.schedule) {
      const next = nextRun(env.schedule, tz);
      add(
        "schedule",
        env.name,
        "ok",
        `${describeSchedule(env.schedule)} (${tz}); next ${next ? formatDateTime(next) : "—"}`,
      );
    } else {
      add("schedule", env.name, "ok", "manual only");
    }
  }

  const dirs: [string, string][] = [
    ["backup dir", backupRoot(config)],
    ["state dir", stateDir(config)],
    ...config.environments
      .filter((e) => e.backupDir)
      .map((e): [string, string] => [`${e.name} backup dir`, envBackupDir(config, e)]),
  ];
  for (const [name, dir] of dirs) {
    const error = await writable(dir);
    add("storage", name, error ? "fail" : "ok", error ? `${dir}: ${error}` : dir);
  }
  try {
    const fs = await statfs(backupRoot(config));
    const free = fs.bavail * fs.bsize;
    const ratio = fs.blocks ? fs.bavail / fs.blocks : 1;
    const low = free < (options.minFreeBytes ?? 1024 ** 3) || ratio < 0.05;
    add(
      "storage",
      "free space",
      low ? "warn" : "ok",
      `${formatBytes(free)} free (${Math.round(ratio * 100)}%)`,
    );
  } catch (error) {
    add("storage", "free space", "warn", (error as Error).message);
  }

  for (const env of config.environments) {
    for (const project of env.projects) {
      const label = `${env.name}/${project.name}`;
      const problem = await readable(project.path, true);
      if (problem) {
        add("projects", label, "fail", `${project.path} ${problem}`);
        continue;
      }
      const missing: string[] = [];
      for (const include of project.include) {
        const p = await readable(path.join(project.path, include), true);
        if (p) missing.push(`${include} ${p}`);
      }
      const usesEnv = env.databases.some(
        (d) => d.source.type === "laravel" && d.source.project === project.name,
      );
      if (usesEnv) {
        const p = await readable(path.join(project.path, ".env"), false);
        if (p) missing.push(`.env ${p}`);
      }
      const allMissing = missing.length >= project.include.length + (usesEnv ? 1 : 0);
      add(
        "projects",
        label,
        missing.length ? (allMissing ? "fail" : "warn") : "ok",
        missing.length ? missing.join("; ") : project.path,
      );
    }
    if (options.db === false) continue;
    for (const db of env.databases) {
      const label = `${env.name}/${db.name}`;
      try {
        const conn = await resolveConnection(db, env);
        await checkConnection(conn);
        add("databases", label, "ok", `connected (${conn.schemas.join(", ")})`);
      } catch (error) {
        add("databases", label, "fail", (error as Error).message.split("\n")[0] ?? "error");
      }
    }
  }
}

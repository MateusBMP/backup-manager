import path from "node:path";
import { defaultBackupDir, defaultStateDir, resolvePath } from "../paths.js";
import { systemTimezone } from "../schedule.js";
import {
  type Config,
  ConfigSchema,
  DEFAULT_API,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_RETENTION,
  DEFAULT_SETTINGS,
  type Environment,
  type Retention,
  SCHEMA_URL,
} from "./schema.js";

/** A valid config with no environments (what onboarding starts from). */
export function emptyConfig(): Config {
  return ConfigSchema.parse({ $schema: SCHEMA_URL });
}

export function backupRoot(config: Config): string {
  return resolvePath(config.settings.backupDir ?? defaultBackupDir());
}

export function stateDir(config: Config): string {
  return resolvePath(config.settings.stateDir ?? defaultStateDir());
}

export function timezone(config: Config): string {
  return config.settings.timezone ?? systemTimezone();
}

export function envBackupDir(config: Config, env: Environment): string {
  return env.backupDir ? resolvePath(env.backupDir) : path.join(backupRoot(config), env.name);
}

export function effectiveRetention(config: Config, env: Environment): Retention {
  return {
    keepLast: env.retention?.keepLast ?? config.retention.keepLast,
    keepDays: env.retention?.keepDays ?? config.retention.keepDays,
  };
}

export function findEnvironment(config: Config, name: string): Environment | undefined {
  return config.environments.find((e) => e.name === name);
}

const sameArray = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function dropDefaults<T extends Record<string, unknown>>(
  value: T,
  defaults: Record<string, unknown>,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([k, v]) => v !== undefined && defaults[k] !== v),
  ) as Partial<T>;
}

const isEmpty = (o: object | undefined) => !o || Object.keys(o).length === 0;

/**
 * The smallest JSON document that parses back to `config`: default values and empty
 * sections are removed, so the file only shows what the user chose.
 */
export function minimizeConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {
    $schema: config.$schema ?? SCHEMA_URL,
    version: config.version,
  };
  const settings = dropDefaults(config.settings, DEFAULT_SETTINGS);
  if (!isEmpty(settings)) out.settings = settings;
  const retention = dropDefaults(config.retention, DEFAULT_RETENTION);
  if (!isEmpty(retention)) out.retention = retention;
  const api = dropDefaults(config.api, DEFAULT_API);
  if (!isEmpty(api)) out.api = api;
  out.environments = config.environments.map((env) => {
    const e: Record<string, unknown> = { name: env.name };
    if (env.schedule) e.schedule = env.schedule;
    if (env.backupDir) e.backupDir = env.backupDir;
    const retention = env.retention ? dropDefaults(env.retention, {}) : undefined;
    if (!isEmpty(retention)) e.retention = retention;
    if (env.projects.length) {
      e.projects = env.projects.map((p) => {
        const project: Record<string, unknown> = { name: p.name, path: p.path };
        if (!sameArray(p.include, DEFAULT_INCLUDE)) project.include = p.include;
        if (!sameArray(p.exclude, DEFAULT_EXCLUDE)) project.exclude = p.exclude;
        return project;
      });
    }
    if (env.databases.length) {
      e.databases = env.databases.map((db) => {
        const d: Record<string, unknown> = {
          name: db.name,
          source: Object.fromEntries(Object.entries(db.source).filter(([, v]) => v !== undefined)),
        };
        if (db.extraArgs.length) d.extraArgs = db.extraArgs;
        return d;
      });
    }
    return e;
  });
  return out;
}

import path from "node:path";
import { z } from "zod";
import { defaultBackupDir, resolvePath } from "../paths.js";
import { isValidTimezone, scheduleError } from "../schedule.js";

export const CONFIG_VERSION = 1;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/MateusBMP/backup-manager/main/config.schema.json";

export const DEFAULT_INCLUDE = ["storage/app"];
export const DEFAULT_EXCLUDE = [
  "storage/framework/{cache,sessions,views}/**",
  "storage/logs/**",
  "**/.gitignore",
];
export const DEFAULT_RETENTION = { keepLast: 7, keepDays: 30 } as const;
export const DEFAULT_API = { enabled: true, host: "127.0.0.1", port: 8080 } as const;
export const DEFAULT_SETTINGS = {
  compressLevel: 6,
  autoPrune: true,
  maxConcurrentJobs: 1,
} as const;

const name = (what: string) =>
  z
    .string()
    .regex(
      NAME_PATTERN,
      "use lowercase letters, digits, '-' or '_' (must start with a letter or digit)",
    )
    .max(64)
    .describe(`${what} name: lowercase letters, digits, '-' and '_'.`);

const nonEmpty = z.string().trim().min(1);

export const SettingsSchema = z
  .object({
    backupDir: nonEmpty
      .optional()
      .describe("Root directory for backups. Default: $XDG_DATA_HOME/backup-manager/backups."),
    stateDir: nonEmpty
      .optional()
      .describe(
        "Directory for jobs, logs, locks and schedule state. Default: $XDG_STATE_HOME/backup-manager.",
      ),
    compressLevel: z
      .int()
      .min(1)
      .max(9)
      .default(DEFAULT_SETTINGS.compressLevel)
      .describe("gzip compression level for dumps and archives (1 fastest … 9 smallest)."),
    autoPrune: z
      .boolean()
      .default(DEFAULT_SETTINGS.autoPrune)
      .describe("Apply the retention policy after every successful backup."),
    timezone: nonEmpty
      .optional()
      .describe(
        "IANA timezone for schedules, e.g. 'America/Sao_Paulo'. Default: the system timezone.",
      ),
    maxConcurrentJobs: z
      .int()
      .min(1)
      .max(16)
      .default(DEFAULT_SETTINGS.maxConcurrentJobs)
      .describe("Maximum scheduled jobs the daemon runs at the same time."),
  })
  .strict()
  .describe("Global settings.");

export const RetentionSchema = z
  .object({
    keepLast: z
      .int()
      .min(0)
      .default(DEFAULT_RETENTION.keepLast)
      .describe("Keep the newest N complete backups (0 disables this rule)."),
    keepDays: z
      .int()
      .min(0)
      .default(DEFAULT_RETENTION.keepDays)
      .describe("Keep complete backups younger than N days (0 disables this rule)."),
  })
  .strict()
  .describe("Retention policy. A backup is kept when either rule keeps it.");

export const RetentionOverrideSchema = z
  .object({
    keepLast: z.int().min(0).optional().describe("Overrides the global keepLast."),
    keepDays: z.int().min(0).optional().describe("Overrides the global keepDays."),
  })
  .strict()
  .describe("Per-environment retention override.");

export const ApiSchema = z
  .object({
    enabled: z
      .boolean()
      .default(DEFAULT_API.enabled)
      .describe("Serve the read-only HTTP API from the daemon."),
    host: nonEmpty.default(DEFAULT_API.host).describe("Address to bind."),
    port: z.int().min(1).max(65_535).default(DEFAULT_API.port).describe("TCP port."),
    token: nonEmpty
      .optional()
      .describe("Bearer token required by every route except /health, /docs and /openapi.json."),
    tokenFile: nonEmpty
      .optional()
      .describe("File containing the bearer token (alternative to token)."),
  })
  .strict()
  .describe("Read-only HTTP API served by `bkm daemon`.");

export const ProjectSchema = z
  .object({
    name: name("Project"),
    path: nonEmpty.describe(
      "Absolute path to the Laravel project root (the directory with artisan).",
    ),
    include: z
      .array(nonEmpty)
      .min(1)
      .default(DEFAULT_INCLUDE)
      .describe("Directories to archive, relative to the project root."),
    exclude: z
      .array(nonEmpty)
      .default(DEFAULT_EXCLUDE)
      .describe(
        "Glob patterns (relative to the project root) to leave out. 'dir/**' keeps the empty directory.",
      ),
  })
  .strict();

const credentials = {
  host: nonEmpty.optional().describe("Server host."),
  port: z.int().min(1).max(65_535).optional().describe("Server port."),
  socket: nonEmpty.optional().describe("Unix socket path (instead of host/port)."),
  user: nonEmpty.optional().describe("User name."),
  password: z.string().optional().describe("Password. Prefer passwordFile."),
  passwordFile: nonEmpty.optional().describe("File containing the password (first line)."),
};

export const LaravelSourceSchema = z
  .object({
    type: z.literal("laravel"),
    project: name("Project").describe(
      "Project (in the same environment) whose .env provides DB_* values.",
    ),
    ...credentials,
    database: nonEmpty.optional().describe("Overrides DB_DATABASE."),
  })
  .strict()
  .describe("Read the connection from a Laravel project's .env; any field set here wins.");

export const ConnectionSourceSchema = z
  .object({
    type: z.literal("connection"),
    ...credentials,
    schemas: z.array(nonEmpty).min(1).describe("Schemas (databases) to dump into one file."),
  })
  .strict()
  .describe("An explicit MariaDB/MySQL connection.");

export const DatabaseSchema = z
  .object({
    name: name("Database"),
    source: z.discriminatedUnion("type", [LaravelSourceSchema, ConnectionSourceSchema]),
    extraArgs: z
      .array(z.string())
      .default([])
      .describe("Extra arguments for mariadb-dump, e.g. ['--ignore-table=app.sessions']."),
  })
  .strict();

export const EnvironmentSchema = z
  .object({
    name: name("Environment"),
    schedule: nonEmpty
      .optional()
      .describe("Cron expression (5 or 6 fields) for automatic backups. Omit for manual only."),
    backupDir: nonEmpty
      .optional()
      .describe("Backup directory used as-is. Default: <settings.backupDir>/<name>."),
    retention: RetentionOverrideSchema.optional(),
    projects: z
      .array(ProjectSchema)
      .default([])
      .describe("Laravel projects whose storage is archived."),
    databases: z.array(DatabaseSchema).default([]).describe("Databases dumped with mariadb-dump."),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(CONFIG_VERSION).default(CONFIG_VERSION).describe("Config format version."),
    settings: SettingsSchema.default({
      compressLevel: DEFAULT_SETTINGS.compressLevel,
      autoPrune: DEFAULT_SETTINGS.autoPrune,
      maxConcurrentJobs: DEFAULT_SETTINGS.maxConcurrentJobs,
    }),
    retention: RetentionSchema.default({ ...DEFAULT_RETENTION }),
    api: ApiSchema.default({ ...DEFAULT_API }),
    environments: z
      .array(EnvironmentSchema)
      .default([])
      .describe("Environments, in display order."),
  })
  .strict()
  .superRefine((config, ctx) => {
    const tz = config.settings.timezone;
    if (tz && !isValidTimezone(tz)) {
      ctx.addIssue({
        code: "custom",
        path: ["settings", "timezone"],
        message: `unknown timezone '${tz}'`,
      });
    }
    if (config.api.token && config.api.tokenFile) {
      ctx.addIssue({
        code: "custom",
        path: ["api", "tokenFile"],
        message: "set token or tokenFile, not both",
      });
    }
    checkRetention(config.retention, ["retention"], ctx);

    const envNames = new Set<string>();
    const dirs = new Map<string, string>();
    config.environments.forEach((env, i) => {
      const at = (...rest: (string | number)[]) => ["environments", i, ...rest];
      if (envNames.has(env.name)) {
        ctx.addIssue({
          code: "custom",
          path: at("name"),
          message: `duplicate environment '${env.name}'`,
        });
      }
      envNames.add(env.name);
      if (env.schedule) {
        const error = scheduleError(env.schedule, tz && isValidTimezone(tz) ? tz : undefined);
        if (error)
          ctx.addIssue({
            code: "custom",
            path: at("schedule"),
            message: `invalid cron expression: ${error}`,
          });
      }
      if (env.retention) {
        checkRetention(
          { ...config.retention, ...stripUndefined(env.retention) },
          at("retention"),
          ctx,
        );
      }
      const dir = env.backupDir
        ? resolvePath(env.backupDir)
        : path.join(resolvePath(config.settings.backupDir ?? defaultBackupDir()), env.name);
      const other = dirs.get(dir);
      if (other) {
        ctx.addIssue({
          code: "custom",
          path: at("backupDir"),
          message: `backup directory is already used by environment '${other}'`,
        });
      }
      dirs.set(dir, env.name);

      const projects = new Set<string>();
      env.projects.forEach((p, j) => {
        if (projects.has(p.name)) {
          ctx.addIssue({
            code: "custom",
            path: at("projects", j, "name"),
            message: `duplicate project '${p.name}'`,
          });
        }
        projects.add(p.name);
      });
      const dbs = new Set<string>();
      env.databases.forEach((db, j) => {
        if (dbs.has(db.name)) {
          ctx.addIssue({
            code: "custom",
            path: at("databases", j, "name"),
            message: `duplicate database '${db.name}'`,
          });
        }
        dbs.add(db.name);
        const source = db.source;
        if (source.password !== undefined && source.passwordFile) {
          ctx.addIssue({
            code: "custom",
            path: at("databases", j, "source", "passwordFile"),
            message: "set password or passwordFile, not both",
          });
        }
        if (source.type === "laravel" && !projects.has(source.project)) {
          ctx.addIssue({
            code: "custom",
            path: at("databases", j, "source", "project"),
            message: `unknown project '${source.project}' in environment '${env.name}'`,
          });
        }
      });
    });
  });

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function checkRetention(
  r: { keepLast: number; keepDays: number },
  at: (string | number)[],
  ctx: z.RefinementCtx,
) {
  if (r.keepLast === 0 && r.keepDays === 0) {
    ctx.addIssue({ code: "custom", path: at, message: "keepLast and keepDays cannot both be 0" });
  }
}

export type Config = z.output<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type Settings = Config["settings"];
export type Retention = Config["retention"];
export type ApiSettings = Config["api"];
export type Environment = Config["environments"][number];
export type Project = Environment["projects"][number];
export type Database = Environment["databases"][number];
export type DatabaseSource = Database["source"];
export type LaravelSource = z.output<typeof LaravelSourceSchema>;
export type ConnectionSource = z.output<typeof ConnectionSourceSchema>;

/** JSON Schema for editors (`$schema` in config.json). */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ConfigSchema, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  return {
    $schema: schema.$schema,
    $id: SCHEMA_URL,
    title: "backup-manager configuration",
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema")),
  };
}

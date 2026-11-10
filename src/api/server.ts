import { timingSafeEqual } from "node:crypto";
import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type BackupInfo, diskUsage } from "../core/backup/catalog.js";
import {
  effectiveRetention,
  envBackupDir,
  findEnvironment,
  timezone,
} from "../core/config/defaults.js";
import type { Config, Database } from "../core/config/schema.js";
import type { JobRecord } from "../core/jobs/store.js";
import { nextRun } from "../core/schedule.js";
import type { Services } from "../core/services.js";
import { VERSION } from "../version.js";

export interface ApiOptions {
  services: Services;
  /** Current config (the daemon swaps it on reload). */
  getConfig: () => Config;
  token?: string | null;
  startedAt?: Date;
  log?: (message: string) => void;
}

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const Status = z.enum(["complete", "partial", "incomplete"]);

const BackupSummary = z
  .object({
    id: z.string(),
    environment: z.string(),
    status: Status,
    createdAt: z.string(),
    size: z.number(),
    items: z.number(),
    failed: z.number(),
  })
  .openapi("BackupSummary");

const BackupItem = z
  .object({
    kind: z.enum(["database", "project"]),
    name: z.string(),
    file: z.string().nullable(),
    size: z.number(),
    sha256: z.string().nullable(),
    durationMs: z.number(),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    detail: z.string().optional(),
  })
  .openapi("BackupItem");

const BackupDetail = BackupSummary.extend({
  finishedAt: z.string().nullable(),
  trigger: z.string().nullable(),
  jobId: z.string().nullable(),
  contents: z.array(BackupItem),
}).openapi("BackupDetail");

const EnvironmentSummary = z
  .object({
    name: z.string(),
    schedule: z.string().nullable(),
    nextRun: z.string().nullable(),
    databases: z.number(),
    projects: z.number(),
    backups: z.number(),
    totalSize: z.number(),
    lastBackup: BackupSummary.nullable(),
    running: z.boolean(),
  })
  .openapi("EnvironmentSummary");

const DiskUsage = z
  .object({ total: z.number(), free: z.number(), used: z.number() })
  .openapi("DiskUsage");

const EnvironmentDetail = EnvironmentSummary.extend({
  backupDir: z.string(),
  retention: z.object({ keepLast: z.number(), keepDays: z.number() }),
  disk: DiskUsage.nullable().openapi({
    description: "Space on the filesystem holding backupDir, in bytes; null when unreadable",
  }),
}).openapi("EnvironmentDetail");

const Project = z
  .object({
    name: z.string(),
    path: z.string(),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  })
  .openapi("Project");

const ProjectDatabaseItem = z
  .object({
    name: z.string(),
    status: z.enum(["success", "failed"]),
    size: z.number(),
    durationMs: z.number(),
    error: z.string().optional(),
  })
  .openapi("ProjectDatabaseItem");

const ProjectBackup = z
  .object({
    backupId: z.string(),
    createdAt: z.string(),
    backupStatus: Status,
    status: z.enum(["success", "failed"]),
    size: z.number(),
    durationMs: z.number(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
    detail: z.string().optional(),
    databases: z.array(ProjectDatabaseItem),
  })
  .openapi("ProjectBackup");

const DatabaseOut = z
  .object({
    name: z.string(),
    type: z.enum(["laravel", "connection"]),
    project: z.string().nullable(),
    host: z.string().nullable(),
    port: z.number().nullable(),
    socket: z.string().nullable(),
    schemas: z.array(z.string()).nullable(),
  })
  .openapi("Database");

const Job = z
  .object({
    id: z.string(),
    status: z.enum(["queued", "running", "success", "partial", "failed"]),
    trigger: z.enum(["ui", "schedule", "catch-up"]),
    environments: z.array(z.string()),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    backups: z.array(
      z.object({
        environment: z.string(),
        backupId: z.string().nullable(),
        status: z.string(),
        error: z.string().optional(),
      }),
    ),
    error: z.string().nullable(),
  })
  .openapi("Job");

const Health = z
  .object({
    status: z.literal("ok"),
    version: z.string(),
    uptimeSeconds: z.number(),
    environments: z.number(),
    nextRuns: z.array(z.object({ environment: z.string(), nextRun: z.string() })),
  })
  .openapi("Health");

const EnvParam = z.object({
  env: z.string().openapi({ param: { name: "env", in: "path" }, example: "production" }),
});
const ProjectParam = EnvParam.extend({
  project: z.string().openapi({ param: { name: "project", in: "path" }, example: "shop" }),
});
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const secured = [{ bearer: [] }];
const notFound = { 404: json(ErrorBody, "Not found") };

function backupSummary(b: BackupInfo): z.infer<typeof BackupSummary> {
  return {
    id: b.id,
    environment: b.environment,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    size: b.size,
    items: b.itemCount,
    failed: b.failedCount,
  };
}

/** Only non-secret connection fields: never user, password or passwordFile, nor extraArgs. */
function databaseOut(db: Database): z.infer<typeof DatabaseOut> {
  const s = db.source;
  return {
    name: db.name,
    type: s.type,
    project: s.type === "laravel" ? s.project : null,
    host: s.host ?? null,
    port: s.port ?? null,
    socket: s.socket ?? null,
    schemas: s.type === "connection" ? s.schemas : s.database ? [s.database] : null,
  };
}

/**
 * The project's item in every backup that contains it, with the items of the databases read from
 * the project's `.env`, newest first.
 */
function projectBackups(
  backups: BackupInfo[],
  project: string,
  databases: string[],
): z.infer<typeof ProjectBackup>[] {
  return backups.flatMap((b) => {
    const items = b.manifest?.items ?? [];
    const item = items.find((i) => i.kind === "project" && i.name === project);
    if (!item) return [];
    return [
      {
        backupId: b.id,
        createdAt: b.createdAt.toISOString(),
        backupStatus: b.status,
        status: item.status,
        size: item.size,
        durationMs: item.durationMs,
        ...(item.error ? { error: item.error } : {}),
        ...(item.warnings?.length ? { warnings: item.warnings } : {}),
        ...(item.detail ? { detail: item.detail } : {}),
        databases: items
          .filter((i) => i.kind === "database" && databases.includes(i.name))
          .map((i) => ({
            name: i.name,
            status: i.status,
            size: i.size,
            durationMs: i.durationMs,
            ...(i.error ? { error: i.error } : {}),
          })),
      },
    ];
  });
}

function jobOut(j: JobRecord): z.infer<typeof Job> {
  return {
    id: j.id,
    status: j.status,
    trigger: j.trigger,
    environments: j.targets.map((t) => t.environment),
    createdAt: j.createdAt,
    startedAt: j.startedAt ?? null,
    finishedAt: j.finishedAt ?? null,
    backups: j.backups,
    error: j.error ?? null,
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const OPEN_PATHS = new Set(["/health", "/docs", "/openapi.json"]);

export function createApi(options: ApiOptions) {
  const { services, getConfig } = options;
  const startedAt = options.startedAt ?? new Date();
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "invalid request" }, 400);
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
  });

  app.use("*", async (c, next) => {
    if (options.token && !OPEN_PATHS.has(c.req.path)) {
      const header = c.req.header("authorization") ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!safeEqual(given, options.token)) return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.onError((error, c) => {
    options.log?.(`api error on ${c.req.path}: ${error.message}`);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  const envOr404 = (name: string) => findEnvironment(getConfig(), name);

  async function summary(name: string) {
    const config = getConfig();
    const env = findEnvironment(config, name)!;
    const s = await services.summary(config, env);
    return {
      name: s.name,
      schedule: s.schedule,
      nextRun: s.nextRun?.toISOString() ?? null,
      databases: s.databases,
      projects: s.projects,
      backups: s.backups,
      totalSize: s.totalSize,
      lastBackup: s.last ? backupSummary(s.last) : null,
      running: s.runningPid !== null,
    };
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      responses: { 200: json(Health, "Daemon health") },
    }),
    (c) => {
      const config = getConfig();
      const tz = timezone(config);
      return c.json(
        {
          status: "ok" as const,
          version: VERSION,
          uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
          environments: config.environments.length,
          nextRuns: config.environments.flatMap((e) => {
            const next = nextRun(e.schedule, tz);
            return next ? [{ environment: e.name, nextRun: next.toISOString() }] : [];
          }),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments",
      security: secured,
      responses: { 200: json(z.array(EnvironmentSummary), "Environments") },
    }),
    async (c) =>
      c.json(await Promise.all(getConfig().environments.map((e) => summary(e.name))), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments/{env}",
      security: secured,
      request: { params: EnvParam },
      responses: { 200: json(EnvironmentDetail, "Environment"), ...notFound },
    }),
    async (c) => {
      const env = envOr404(c.req.valid("param").env);
      if (!env) return c.json({ error: "unknown environment" }, 404);
      const config = getConfig();
      const backupDir = envBackupDir(config, env);
      return c.json(
        {
          ...(await summary(env.name)),
          backupDir,
          retention: effectiveRetention(config, env),
          disk: await diskUsage(backupDir),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments/{env}/projects",
      security: secured,
      request: { params: EnvParam },
      responses: { 200: json(z.array(Project), "Projects"), ...notFound },
    }),
    (c) => {
      const env = envOr404(c.req.valid("param").env);
      if (!env) return c.json({ error: "unknown environment" }, 404);
      return c.json(
        env.projects.map(({ name, path, include, exclude }) => ({ name, path, include, exclude })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments/{env}/projects/{project}/backups",
      security: secured,
      request: {
        params: ProjectParam,
        query: z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }),
      },
      responses: {
        200: json(z.array(ProjectBackup), "The project in each backup, newest first"),
        ...notFound,
      },
    }),
    async (c) => {
      const { env: name, project } = c.req.valid("param");
      const env = envOr404(name);
      if (!env) return c.json({ error: "unknown environment" }, 404);
      if (!env.projects.some((p) => p.name === project)) {
        return c.json({ error: "unknown project" }, 404);
      }
      const databases = env.databases
        .filter((d) => d.source.type === "laravel" && d.source.project === project)
        .map((d) => d.name);
      const list = projectBackups(
        await services.backups(getConfig(), env.name),
        project,
        databases,
      );
      const { limit } = c.req.valid("query");
      return c.json(limit ? list.slice(0, limit) : list, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments/{env}/databases",
      security: secured,
      request: { params: EnvParam },
      responses: { 200: json(z.array(DatabaseOut), "Databases (no credentials)"), ...notFound },
    }),
    (c) => {
      const env = envOr404(c.req.valid("param").env);
      if (!env) return c.json({ error: "unknown environment" }, 404);
      return c.json(env.databases.map(databaseOut), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments/{env}/backups",
      security: secured,
      request: {
        params: EnvParam,
        query: z.object({
          status: Status.optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
      },
      responses: { 200: json(z.array(BackupSummary), "Backups, newest first"), ...notFound },
    }),
    async (c) => {
      const env = envOr404(c.req.valid("param").env);
      if (!env) return c.json({ error: "unknown environment" }, 404);
      const { status, limit } = c.req.valid("query");
      const list = await services.backups(getConfig(), env.name, { status, limit });
      return c.json(list.map(backupSummary), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/environments/{env}/backups/{id}",
      security: secured,
      request: {
        params: EnvParam.extend({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
      },
      responses: { 200: json(BackupDetail, "Backup"), ...notFound },
    }),
    async (c) => {
      const { env: name, id } = c.req.valid("param");
      const env = envOr404(name);
      if (!env) return c.json({ error: "unknown environment" }, 404);
      const b = await services.backup(getConfig(), env.name, id);
      if (!b) return c.json({ error: "unknown backup" }, 404);
      return c.json(
        {
          ...backupSummary(b),
          finishedAt: b.manifest?.finishedAt ?? null,
          trigger: b.manifest?.trigger ?? null,
          jobId: b.manifest?.jobId ?? null,
          contents: b.manifest?.items ?? [],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/jobs",
      security: secured,
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
      responses: { 200: json(z.array(Job), "Jobs, newest first") },
    }),
    async (c) =>
      c.json((await services.jobs(getConfig(), c.req.valid("query").limit ?? 50)).map(jobOut), 200),
  );

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "backup-manager API",
      version: VERSION,
      description: "Read-only view of environments, backups and jobs.",
    },
  });
  app.get("/docs", swaggerUI({ url: "/openapi.json" }));
  return app;
}

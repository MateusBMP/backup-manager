import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Database, Environment } from "../config/schema.js";
import { dotenvGet, loadDotenv } from "../dotenv.js";
import { expandHome } from "../paths.js";
import { findExecutable } from "../process.js";

export const DUMP_BINARIES = ["mariadb-dump", "mysqldump"] as const;
export const CLIENT_BINARIES = ["mariadb", "mysql"] as const;
export const DUMP_OPTIONS = [
  "--single-transaction",
  "--quick",
  "--routines",
  "--triggers",
  "--events",
  "--hex-blob",
] as const;
const SUPPORTED = new Set(["mysql", "mariadb"]);

export class DumpError extends Error {
  override name = "DumpError";
}

export interface Connection {
  host?: string;
  port?: number;
  socket?: string;
  user?: string;
  password?: string;
  schemas: string[];
}

export function describeConnection(c: Connection): string {
  const where = c.socket ?? `${c.host ?? "localhost"}:${c.port ?? 3306}`;
  return `${c.schemas.join(", ")} @ ${where}`;
}

async function readPasswordFile(file: string, dbName: string): Promise<string> {
  try {
    return (await readFile(expandHome(file), "utf8")).split(/\r?\n/, 1)[0] ?? "";
  } catch (error) {
    throw new DumpError(
      `database '${dbName}': cannot read passwordFile: ${(error as Error).message}`,
    );
  }
}

/** Merge explicit settings over the DB_* values of the linked Laravel project's `.env`. */
export async function resolveConnection(
  db: Database,
  env: Environment,
  warn: (message: string) => void = () => {},
): Promise<Connection> {
  const s = db.source;
  let password = s.password;
  if (s.passwordFile) password = await readPasswordFile(s.passwordFile, db.name);
  const conn: Connection = {
    host: s.host,
    port: s.port,
    socket: s.socket,
    user: s.user,
    password,
    schemas: s.type === "connection" ? [...s.schemas] : [],
  };
  if (s.type === "laravel") {
    const project = env.projects.find((p) => p.name === s.project);
    if (!project) throw new DumpError(`database '${db.name}': unknown project '${s.project}'`);
    const file = path.join(project.path, ".env");
    let dotenv: Awaited<ReturnType<typeof loadDotenv>>;
    try {
      dotenv = await loadDotenv(file);
    } catch (error) {
      throw new DumpError(
        `database '${db.name}': cannot read ${file}: ${(error as Error).message}`,
      );
    }
    for (const w of dotenv.warnings) warn(`${file}: ${w}`);
    const driver = (dotenvGet(dotenv, "DB_CONNECTION") ?? "mysql").toLowerCase();
    if (!SUPPORTED.has(driver)) {
      throw new DumpError(
        `database '${db.name}': ${file} has DB_CONNECTION=${driver}; only mysql/mariadb are supported`,
      );
    }
    conn.host ??= dotenvGet(dotenv, "DB_HOST");
    const envPort = dotenvGet(dotenv, "DB_PORT");
    if (conn.port === undefined && envPort) {
      const port = Number.parseInt(envPort, 10);
      if (!Number.isInteger(port))
        throw new DumpError(`${file}: DB_PORT is not a number: '${envPort}'`);
      conn.port = port;
    }
    conn.socket ??= dotenvGet(dotenv, "DB_SOCKET");
    conn.user ??= dotenvGet(dotenv, "DB_USERNAME");
    if (conn.password === undefined) conn.password = dotenv.values.DB_PASSWORD;
    const schema = s.database ?? dotenvGet(dotenv, "DB_DATABASE");
    if (schema) conn.schemas = [schema];
  }
  if (conn.schemas.length === 0)
    throw new DumpError(`database '${db.name}': no schema configured or found in .env`);
  return conn;
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function renderOptionFile(c: Connection): string {
  const lines = ["[client]"];
  if (c.host) lines.push(`host=${quote(c.host)}`);
  if (c.port) lines.push(`port=${c.port}`);
  if (c.socket) lines.push(`socket=${quote(c.socket)}`);
  if (c.user) lines.push(`user=${quote(c.user)}`);
  if (c.password !== undefined) lines.push(`password=${quote(c.password)}`);
  return `${lines.join("\n")}\n`;
}

/** Credentials live only in a private option file that is removed afterwards. */
export async function withOptionFile<T>(
  c: Connection,
  fn: (file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "bkm-"));
  const file = path.join(dir, "client.cnf");
  try {
    await writeFile(file, renderOptionFile(c), { mode: 0o600, flag: "wx" });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function buildDumpArgs(
  optionFile: string,
  c: Connection,
  extraArgs: readonly string[] = [],
): string[] {
  const args = [`--defaults-extra-file=${optionFile}`, ...DUMP_OPTIONS, ...extraArgs];
  if (c.schemas.length > 1) args.push("--databases", ...c.schemas);
  else args.push(c.schemas[0] as string);
  return args;
}

export async function findDumpBinary(): Promise<string> {
  const found = await findExecutable(DUMP_BINARIES);
  if (!found) throw new DumpError(`none of ${DUMP_BINARIES.join(", ")} found on PATH`);
  return found;
}

export interface DumpOptions {
  compressLevel?: number;
  extraArgs?: readonly string[];
  binary?: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
}

/** Stream `mariadb-dump` stdout through gzip into `destination`. Returns uncompressed bytes. */
export async function dumpDatabase(
  c: Connection,
  destination: string,
  options: DumpOptions = {},
): Promise<number> {
  const binary = options.binary ?? (await findDumpBinary());
  await mkdir(path.dirname(destination), { recursive: true });
  if (options.signal?.aborted) throw new DumpError("aborted");
  return withOptionFile(c, async (optionFile) => {
    const child = spawn(binary, buildDumpArgs(optionFile, c, options.extraArgs), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // the signal may have fired while the option file was being written
    if (options.signal?.aborted) onAbort();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let bytes = 0;
    let last = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        const now = Date.now();
        if (options.onProgress && now - last > 250) {
          last = now;
          options.onProgress(bytes);
        }
        done(null, chunk);
      },
    });
    try {
      const [, result] = await Promise.all([
        pipeline(
          child.stdout,
          counter,
          createGzip({ level: options.compressLevel ?? 6 }),
          createWriteStream(destination, { mode: 0o600 }),
        ),
        exited,
      ]);
      if (result.error)
        throw new DumpError(`cannot run ${path.basename(binary)}: ${result.error.message}`);
      if (options.signal?.aborted) throw new DumpError("aborted");
      if (result.code !== 0) {
        const tail = stderr.trim().split("\n").slice(-5).join(" | ");
        const how = result.signal
          ? `was killed by ${result.signal}`
          : `exited with status ${result.code}`;
        throw new DumpError(`${path.basename(binary)} ${how}: ${tail || "no error output"}`);
      }
    } catch (error) {
      await rm(destination, { force: true });
      throw error instanceof DumpError ? error : new DumpError((error as Error).message);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    options.onProgress?.(bytes);
    return bytes;
  });
}

/** Run `SELECT 1` against the first schema; throws `DumpError` with the server message. */
export async function checkConnection(
  c: Connection,
  binary?: string,
  timeoutMs = 15_000,
): Promise<void> {
  const client = binary ?? (await findExecutable(CLIENT_BINARIES));
  if (!client) throw new DumpError(`none of ${CLIENT_BINARIES.join(", ")} found on PATH`);
  await withOptionFile(c, async (optionFile) => {
    const result = await new Promise<{ code: number | null; stderr: string; error?: Error }>(
      (resolve) => {
        const child = spawn(
          client,
          [`--defaults-extra-file=${optionFile}`, "-N", "-e", "SELECT 1", c.schemas[0] as string],
          {
            stdio: ["ignore", "ignore", "pipe"],
            timeout: timeoutMs,
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d: string) => {
          stderr += d;
        });
        child.once("error", (error) => resolve({ code: null, stderr, error }));
        child.once("close", (code) => resolve({ code, stderr }));
      },
    );
    if (result.error)
      throw new DumpError(`cannot run ${path.basename(client)}: ${result.error.message}`);
    if (result.code !== 0)
      throw new DumpError(result.stderr.trim() || `exit status ${result.code}`);
  });
}

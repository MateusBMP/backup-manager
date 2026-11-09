import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { parseConfig } from "../src/core/config/load.js";
import type { Config } from "../src/core/config/schema.js";

const dirs: string[] = [];

/** A fresh temporary directory, removed after the current test. */
export async function tempDir(prefix = "bkm-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export function makeConfig(root: string, data: Record<string, unknown> = {}): Config {
  const { settings, ...rest } = data as { settings?: Record<string, unknown> };
  return parseConfig({
    settings: {
      backupDir: path.join(root, "backups"),
      stateDir: path.join(root, "state"),
      ...settings,
    },
    ...rest,
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeout = 5000, interval = 20 }: { timeout?: number; interval?: number } = {},
): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`waitFor timed out${last ? `: ${(last as Error).message}` : ""}`);
}

const FAKE_DUMP = path.resolve(import.meta.dirname, "fixtures/fake-mariadb-dump.mjs");

/** Put fake `mariadb-dump`/`mariadb` first on PATH; returns the log file they append to. */
export async function installFakeDump(root: string): Promise<string> {
  const { mkdir, symlink } = await import("node:fs/promises");
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const name of ["mariadb-dump", "mariadb"]) await symlink(FAKE_DUMP, path.join(bin, name));
  const log = path.join(root, "fake-dump.log");
  const saved = { PATH: process.env.PATH, FAKE_DUMP_LOG: process.env.FAKE_DUMP_LOG };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_DUMP_LOG = log;
  restores.push(() => {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_DUMP_LOG === undefined) delete process.env.FAKE_DUMP_LOG;
    else process.env.FAKE_DUMP_LOG = saved.FAKE_DUMP_LOG;
  });
  return log;
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

/** A minimal Laravel project tree with a .env. */
export async function makeLaravelProject(root: string, name = "shop", env = ""): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = path.join(root, name);
  const files: Record<string, string> = {
    artisan: "#!/usr/bin/env php\n",
    ".env":
      env ||
      `DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=${name}\nDB_USERNAME=app\nDB_PASSWORD=secret\n`,
    "storage/app/public/a.txt": "a",
    "storage/app/public/.gitignore": "*\n",
    "storage/app/private/b.txt": "bb",
    "storage/logs/laravel.log": "log",
    "storage/framework/cache/data/x": "cache",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

import type { CommandResult, CommandRunner } from "../src/core/service/systemctl.js";

/** In-memory systemd: records argv and simulates unit state. Never runs real commands. */
export function fakeSystemd(
  options: { available?: boolean; lingerAllowed?: boolean; linger?: boolean } = {},
) {
  const state = {
    available: options.available ?? true,
    loaded: false,
    enabled: false,
    active: false,
    linger: options.linger ?? false,
    lingerAllowed: options.lingerAllowed ?? true,
    reloads: 0,
  };
  const calls: string[][] = [];
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string, code = 1): CommandResult => ({ code, stdout: "", stderr });
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl") {
      if (args[0] !== "--user") throw new Error("systemctl must always be called with --user");
      if (!state.available) return fail("Failed to connect to bus: No medium found");
      const [verb, ...rest] = args.slice(1);
      switch (verb) {
        case "show":
          return ok(
            [
              `ActiveState=${state.active ? "active" : "inactive"}`,
              `SubState=${state.active ? "running" : "dead"}`,
              `MainPID=${state.active ? 4242 : 0}`,
              `UnitFileState=${state.loaded ? (state.enabled ? "enabled" : "disabled") : ""}`,
              `LoadState=${state.loaded ? "loaded" : "not-found"}`,
            ].join("\n"),
          );
        case "daemon-reload":
          state.loaded = true;
          state.reloads++;
          return ok();
        case "enable":
          state.enabled = true;
          if (rest.includes("--now")) state.active = true;
          return ok();
        case "disable":
          state.enabled = false;
          if (rest.includes("--now")) state.active = false;
          return ok();
        case "start":
        case "restart":
          state.active = true;
          return ok();
        case "stop":
          state.active = false;
          return ok();
        case "reload":
          return state.active ? ok() : fail("Job for bkm.service failed: unit not active");
        default:
          return fail(`unknown verb ${verb}`);
      }
    }
    if (command === "loginctl") {
      if (args[0] === "show-user") return ok(`Linger=${state.linger ? "yes" : "no"}\n`);
      if (args[0] === "enable-linger") {
        if (!state.lingerAllowed) return fail("Could not enable linger: Access denied");
        state.linger = true;
        return ok();
      }
    }
    if (command === "journalctl")
      return ok("-- Logs begin --\n2026-11-09T03:30:00 host bkm[1]: scheduler started\n");
    return fail(`${command}: command not found`, 127);
  };
  return { runner, calls, state };
}

/** A TCP port that was free a moment ago. */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

export function memoryLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => lines.push(`info: ${m}`),
    warn: (m: string) => lines.push(`warn: ${m}`),
    error: (m: string) => lines.push(`error: ${m}`),
  };
}

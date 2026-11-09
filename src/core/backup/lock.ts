import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAlive } from "../process.js";

export class LockHeldError extends Error {
  constructor(
    readonly environment: string,
    readonly pid: number,
  ) {
    super(`environment '${environment}' is already being backed up (pid ${pid})`);
    this.name = "LockHeldError";
  }
}

export interface Lock {
  file: string;
  release(): Promise<void>;
}

export function lockFile(stateDir: string, environment: string): string {
  return path.join(stateDir, "locks", `${environment}.lock`);
}

async function holder(file: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Per-environment pid lock; a lock whose process is gone is taken over. */
export async function acquireLock(
  stateDir: string,
  environment: string,
  pid = process.pid,
): Promise<Lock> {
  const file = lockFile(stateDir, environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return {
        file,
        release: async () => {
          if ((await holder(file)) === pid) await rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await holder(file);
      if (current !== null && current !== pid && isAlive(current))
        throw new LockHeldError(environment, current);
      await rm(file, { force: true }); // stale (dead pid, our own pid or unreadable)
    }
  }
  throw new Error(`could not acquire lock ${file}`);
}

/** Pid holding the environment lock, or null when it is free (or stale). */
export async function lockHolder(stateDir: string, environment: string): Promise<number | null> {
  const pid = await holder(lockFile(stateDir, environment));
  return pid !== null && isAlive(pid) ? pid : null;
}

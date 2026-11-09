import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/** True when a process with this pid exists (EPERM still means it exists). */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** First executable found on PATH among `names`. */
export async function findExecutable(
  names: readonly string[],
  envPath = process.env.PATH ?? "",
): Promise<string | null> {
  for (const name of names) {
    for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

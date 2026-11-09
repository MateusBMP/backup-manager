import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { minimizeConfig } from "./defaults.js";
import { ConfigError, parseConfig } from "./load.js";
import type { Config } from "./schema.js";

export class ConfigConflictError extends ConfigError {
  constructor(readonly path: string) {
    super(`${path} was changed by someone else since it was loaded; reload before saving`);
    this.name = "ConfigConflictError";
  }
}

export interface SaveOptions {
  /** mtime from when the config was loaded; `null` means the file must not exist yet. */
  expectedMtimeMs?: number | null;
}

async function currentMtime(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function serializeConfig(config: Config): string {
  return `${JSON.stringify(minimizeConfig(config), null, 2)}\n`;
}

/**
 * The only way config is written: validate, minimise, keep a `.bak`, then write a 0600
 * temp file and rename it over the target. Returns the new mtime.
 */
export async function saveConfig(
  file: string,
  config: Config,
  options: SaveOptions = {},
): Promise<number> {
  const text = serializeConfig(config);
  parseConfig(JSON.parse(text)); // never write something we cannot read back
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mtime = await currentMtime(file);
  if (options.expectedMtimeMs !== undefined && mtime !== options.expectedMtimeMs) {
    throw new ConfigConflictError(file);
  }
  if (mtime !== null) await copyFile(file, `${file}.bak`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return (await stat(file)).mtimeMs;
}

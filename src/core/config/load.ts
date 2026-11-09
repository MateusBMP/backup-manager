import { readFile, stat } from "node:fs/promises";
import type { z } from "zod";
import { type Config, ConfigSchema } from "./schema.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConfigMissingError extends ConfigError {
  constructor(readonly path: string) {
    super(`no config file at ${path}; run \`bkm\` to create one`);
    this.name = "ConfigMissingError";
  }
}

export interface LoadedConfig {
  path: string;
  config: Config;
  /** File mtime when it was read; used to detect external edits before saving. */
  mtimeMs: number;
}

/** `environments[0].databases[1].source.host` style path. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out || "(root)";
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
}

export function parseConfig(data: unknown, source = "config"): Config {
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = formatIssues(result.error);
    throw new ConfigError(`${source} is invalid:\n  ${issues.join("\n  ")}`, issues);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, { mtimeMs }] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigMissingError(path);
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`, [
      `(root): ${(error as Error).message}`,
    ]);
  }
  return { path, config: parseConfig(data, path), mtimeMs };
}

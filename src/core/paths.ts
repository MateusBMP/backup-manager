import { homedir } from "node:os";
import path from "node:path";

export const APP_DIR = "backup-manager";

/** Expand a leading `~` or `~/` to the current user's home directory. */
export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** Expand `~` and make the path absolute (relative paths resolve against `base`). */
export function resolvePath(p: string, base = process.cwd()): string {
  return path.resolve(base, expandHome(p));
}

function xdg(name: string, fallback: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  return value && path.isAbsolute(value) ? value : path.join(homedir(), fallback);
}

export function xdgConfigHome(env = process.env): string {
  return xdg("XDG_CONFIG_HOME", ".config", env);
}

export function xdgDataHome(env = process.env): string {
  return xdg("XDG_DATA_HOME", ".local/share", env);
}

export function xdgStateHome(env = process.env): string {
  return xdg("XDG_STATE_HOME", ".local/state", env);
}

export function defaultConfigPath(env = process.env): string {
  return path.join(xdgConfigHome(env), APP_DIR, "config.json");
}

export function defaultBackupDir(env = process.env): string {
  return path.join(xdgDataHome(env), APP_DIR, "backups");
}

export function defaultStateDir(env = process.env): string {
  return path.join(xdgStateHome(env), APP_DIR);
}

/** Config lookup order: explicit flag → `$BKM_CONFIG` → XDG default. */
export function resolveConfigPath(explicit?: string, env = process.env): string {
  if (explicit) return resolvePath(explicit);
  if (env.BKM_CONFIG) return resolvePath(env.BKM_CONFIG);
  return defaultConfigPath(env);
}

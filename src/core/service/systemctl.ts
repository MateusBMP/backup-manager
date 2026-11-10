import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. Injected so tests never touch the real systemd. */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/**
 * `systemctl --user` needs XDG_RUNTIME_DIR (and D-Bus) to reach the user manager. Shells opened
 * with `su`, `sudo -u` or SSH without pam_systemd lack them even when the manager runs at
 * /run/user/<uid>, so fill them in from there. Existing values are kept; `env` is not mutated.
 */
export function userBusEnv(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null = process.getuid?.() ?? null,
  exists: (p: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const out = { ...env };
  if (!out.XDG_RUNTIME_DIR && uid !== null) {
    const dir = `/run/user/${uid}`;
    if (exists(dir)) out.XDG_RUNTIME_DIR = dir;
  }
  if (!out.DBUS_SESSION_BUS_ADDRESS && out.XDG_RUNTIME_DIR) {
    const bus = `${out.XDG_RUNTIME_DIR}/bus`;
    if (exists(bus)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }
  return out;
}

export const execRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: userBusEnv() },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (err && err.code === "ENOENT") {
          resolve({ code: 127, stdout: "", stderr: `${command}: command not found` });
          return;
        }
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

/** Every systemctl call is user-level; `sudo` is never used. */
export class Systemd {
  constructor(private readonly run: CommandRunner = execRunner) {}

  systemctl(...args: string[]): Promise<CommandResult> {
    return this.run("systemctl", ["--user", ...args]);
  }

  journal(unit: string, lines: number): Promise<CommandResult> {
    return this.run("journalctl", [
      "--user",
      "-u",
      unit,
      "-n",
      String(lines),
      "--no-pager",
      "-o",
      "short-iso",
    ]);
  }

  loginctl(...args: string[]): Promise<CommandResult> {
    return this.run("loginctl", args);
  }
}

export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

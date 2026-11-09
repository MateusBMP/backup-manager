import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program without a shell. Injected so tests never touch the real systemd. */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export const execRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
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

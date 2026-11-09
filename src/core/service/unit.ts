import path from "node:path";
import { xdgConfigHome } from "../paths.js";

export const UNIT_NAME = "bkm";
export const UNIT_FILE = `${UNIT_NAME}.service`;

export function unitPath(env = process.env): string {
  return path.join(xdgConfigHome(env), "systemd", "user", UNIT_FILE);
}

/** Quote one ExecStart word for systemd (also escapes `%` specifiers and `$`). */
export function quoteArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface UnitOptions {
  /** argv of the daemon: node, its flags, the CLI script. */
  command: string[];
  configPath: string;
}

export function renderUnit({ command, configPath }: UnitOptions): string {
  const exec = [...command, "daemon", "--config", configPath].map(quoteArg).join(" ");
  return [
    "# Managed by backup-manager (bkm → Service). Choose Install / update after moving node or bkm.",
    "[Unit]",
    "Description=backup-manager scheduler and API",
    "Documentation=https://github.com/MateusBMP/backup-manager",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    "ExecReload=/bin/kill -HUP $MAINPID",
    "Restart=on-failure",
    "RestartSec=10",
    "TimeoutStopSec=6min",
    "NoNewPrivileges=yes",
    "Environment=NODE_ENV=production",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

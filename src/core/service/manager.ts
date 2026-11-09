import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { getJobCommand } from "../jobs/runner.js";
import { type CommandRunner, execRunner, parseProperties, Systemd } from "./systemctl.js";
import { renderUnit, UNIT_FILE, UNIT_NAME, unitPath } from "./unit.js";

export interface ServiceStatus {
  /** systemctl --user is usable (a user manager is running). */
  available: boolean;
  installed: boolean;
  unitPath: string;
  /** The installed unit differs from what Install / update would write now. */
  outdated: boolean;
  activeState: string;
  subState: string;
  mainPid: number | null;
  /** UnitFileState: enabled, disabled, … */
  enabled: string;
  /** null when unknown */
  linger: boolean | null;
  error?: string;
}

export interface InstallResult {
  unit: string;
  unitPath: string;
  actions: string[];
  warnings: string[];
  changed: boolean;
}

export class ServiceError extends Error {
  override name = "ServiceError";
}

export interface ManagerOptions {
  configPath: string;
  runner?: CommandRunner;
  unitFile?: string;
  user?: string;
  /** argv used to start the daemon; defaults to the current `bkm` invocation. */
  command?: string[];
}

export class ServiceManager {
  readonly systemd: Systemd;
  readonly unitFile: string;
  private readonly user: string;

  constructor(private readonly options: ManagerOptions) {
    this.systemd = new Systemd(options.runner ?? execRunner);
    this.unitFile = options.unitFile ?? unitPath();
    this.user = options.user ?? userInfo().username;
  }

  expectedUnit(): string {
    const cmd =
      this.options.command ??
      (() => {
        const { command, args } = getJobCommand();
        return [command, ...args];
      })();
    return renderUnit({ command: cmd, configPath: this.options.configPath });
  }

  private async installedUnit(): Promise<string | null> {
    return readFile(this.unitFile, "utf8").catch(() => null);
  }

  async linger(): Promise<boolean | null> {
    const r = await this.systemd.loginctl("show-user", this.user, "-p", "Linger");
    if (r.code !== 0) return null;
    return parseProperties(r.stdout).Linger === "yes";
  }

  async status(): Promise<ServiceStatus> {
    const installed = await this.installedUnit();
    const base: ServiceStatus = {
      available: false,
      installed: installed !== null,
      unitPath: this.unitFile,
      outdated: installed !== null && installed !== this.expectedUnit(),
      activeState: "unknown",
      subState: "unknown",
      mainPid: null,
      enabled: "unknown",
      linger: null,
    };
    const show = await this.systemd.systemctl(
      "show",
      UNIT_NAME,
      "-p",
      "ActiveState,SubState,MainPID,UnitFileState,LoadState",
    );
    if (show.code !== 0) {
      return {
        ...base,
        error: (show.stderr || show.stdout).trim() || `systemctl exited with ${show.code}`,
      };
    }
    const p = parseProperties(show.stdout);
    const pid = Number.parseInt(p.MainPID ?? "0", 10);
    return {
      ...base,
      available: true,
      activeState: p.ActiveState || "unknown",
      subState: p.SubState || "unknown",
      mainPid: pid > 0 ? pid : null,
      enabled: p.UnitFileState || (p.LoadState === "not-found" ? "not-found" : "unknown"),
      linger: await this.linger(),
    };
  }

  private async must(args: string[], what: string) {
    const r = await this.systemd.systemctl(...args);
    if (r.code !== 0)
      throw new ServiceError(
        `${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`,
      );
  }

  async install({ force = false } = {}): Promise<InstallResult> {
    const unit = this.expectedUnit();
    const current = await this.installedUnit();
    const result: InstallResult = {
      unit,
      unitPath: this.unitFile,
      actions: [],
      warnings: [],
      changed: false,
    };
    const writeUnit = current === null || (current !== unit && force);
    if (current !== null && current !== unit && !force) {
      throw new ServiceError(
        `${this.unitFile} differs from the expected unit; it was changed outside bkm`,
      );
    }
    const status = await this.status();
    if (!status.available) {
      throw new ServiceError(
        `systemd user manager is not available: ${status.error ?? "unknown error"}`,
      );
    }
    if (writeUnit) result.actions.push(`write ${this.unitFile}`, "systemctl --user daemon-reload");
    const needsStart = writeUnit || status.enabled !== "enabled" || status.activeState !== "active";
    if (needsStart) result.actions.push(`systemctl --user enable --now ${UNIT_NAME}`);
    if (writeUnit && current !== null) result.actions.push(`systemctl --user restart ${UNIT_NAME}`);
    const linger = await this.linger();
    if (linger !== true) result.actions.push(`loginctl enable-linger ${this.user}`);

    if (writeUnit) {
      await mkdir(path.dirname(this.unitFile), { recursive: true });
      await writeFile(this.unitFile, unit, { mode: 0o644 });
      result.changed = true;
      await this.must(["daemon-reload"], "daemon-reload");
    }
    if (needsStart) await this.must(["enable", "--now", UNIT_NAME], "enable --now");
    if (writeUnit && current !== null) await this.must(["restart", UNIT_NAME], "restart");
    if (linger !== true) {
      const r = await this.systemd.loginctl("enable-linger", this.user);
      if (r.code !== 0) {
        result.warnings.push(
          `could not enable lingering (${(r.stderr || r.stdout).trim() || `exit ${r.code}`}); the service runs only while you are logged in`,
        );
      }
    }
    return result;
  }

  async uninstall(): Promise<string[]> {
    const actions: string[] = [];
    if ((await this.installedUnit()) === null) return actions;
    await this.systemd.systemctl("disable", "--now", UNIT_NAME);
    actions.push(`systemctl --user disable --now ${UNIT_NAME}`);
    await rm(this.unitFile, { force: true });
    actions.push(`remove ${this.unitFile}`);
    await this.systemd.systemctl("daemon-reload");
    actions.push("systemctl --user daemon-reload");
    return actions;
  }

  async control(action: "start" | "stop" | "restart" | "reload"): Promise<void> {
    await this.must([action, UNIT_NAME], action);
  }

  async logs(lines = 200): Promise<string[]> {
    const r = await this.systemd.journal(UNIT_NAME, lines);
    if (r.code !== 0) return [`(journalctl failed: ${(r.stderr || r.stdout).trim()})`];
    return r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("-- "));
  }
}

export { UNIT_FILE, UNIT_NAME };

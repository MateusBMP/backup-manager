import { Command, CommanderError } from "commander";
import { stateDir } from "../core/config/defaults.js";
import { ConfigError, ConfigMissingError, loadConfig } from "../core/config/load.js";
import { consoleLogger, type DaemonLogger, runDaemon } from "../core/daemon/daemon.js";
import { EXIT_FAILURE, EXIT_OK, executeJob } from "../core/jobs/runner.js";
import { resolveConfigPath } from "../core/paths.js";
import type { CommandRunner } from "../core/service/systemctl.js";
import { Services } from "../core/services.js";
import { doctorText, type PrintOptions, printOptions } from "../ui/print/print.js";
import { VERSION } from "../version.js";

export const EXIT_USAGE = 2;

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  isTTY: boolean;
  print: PrintOptions;
}

export interface CliDeps {
  io?: CliIO;
  runner?: CommandRunner;
  unitFile?: string;
  env?: NodeJS.ProcessEnv;
  /** Opens the full-screen UI; resolves with the exit code. */
  launchUi?: (services: Services) => Promise<number>;
  daemonLog?: DaemonLogger;
  /** Overrides runDaemon (tests). */
  daemon?: typeof runDaemon;
}

export const processIO = (): CliIO => ({
  out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
  isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  print: printOptions(process.stdout),
});

const NO_CONFIG_HINT = "run `bkm` in a terminal first to create one";

/** Parses argv (without node and script) and runs the command. Returns the exit code. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? processIO();
  const env = deps.env ?? process.env;
  let code = EXIT_OK;
  const services = (configPath: string) =>
    new Services({ configPath, runner: deps.runner, unitFile: deps.unitFile });

  const program = new Command("bkm")
    .description("Back up MariaDB databases and Laravel storage per environment.")
    .version(VERSION, "-v, --version")
    .option(
      "-c, --config <path>",
      "config file (default: $BKM_CONFIG or ~/.config/backup-manager/config.json)",
    )
    .showHelpAfterError("(run `bkm --help` for usage)")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });

  const configPath = () => resolveConfigPath(program.opts<{ config?: string }>().config, env);

  async function requireConfig(path: string) {
    try {
      return await loadConfig(path);
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        io.err(`bkm: no config at ${path}; ${NO_CONFIG_HINT}`);
      } else {
        io.err(`bkm: ${(error as Error).message}`);
      }
      code = EXIT_USAGE;
      return null;
    }
  }

  program.action(async () => {
    if (!io.isTTY) {
      io.err(program.helpInformation());
      io.err("bkm: the interactive UI needs a terminal (TTY)");
      code = EXIT_USAGE;
      return;
    }
    const launch =
      deps.launchUi ?? (async (s: Services) => (await import("../ui/main.js")).runUi(s));
    code = await launch(services(configPath()));
  });

  program
    .command("doctor")
    .description("check config, tools, directories, project access, databases and the service")
    .option("--no-db", "skip database connection checks")
    .action(async (opts: { db: boolean }) => {
      const path = configPath();
      const report = await services(path).doctor({ db: opts.db });
      if (report.missingConfig) {
        io.err(`bkm: no config at ${path}; ${NO_CONFIG_HINT}`);
        code = EXIT_USAGE;
        return;
      }
      io.out(doctorText(report, io.print));
      code = report.ok ? EXIT_OK : EXIT_FAILURE;
    });

  program
    .command("daemon")
    .description("run the scheduler and API in the foreground (what the systemd service starts)")
    .action(async () => {
      const path = configPath();
      if (!(await requireConfig(path))) return;
      const run = deps.daemon ?? runDaemon;
      try {
        code = await run({ services: services(path), log: deps.daemonLog ?? consoleLogger });
      } catch (error) {
        io.err(`bkm daemon: ${(error as Error).message}`);
        code = error instanceof ConfigError ? EXIT_USAGE : EXIT_FAILURE;
      }
    });

  program
    .command("__job <id>", { hidden: true })
    .description("run a queued backup job (internal)")
    .action(async (id: string) => {
      const path = configPath();
      const loaded = await requireConfig(path);
      if (!loaded) return;
      code = await executeJob(stateDir(loaded.config), id, path);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.code === "commander.help"
      ) {
        return EXIT_OK;
      }
      return EXIT_USAGE;
    }
    io.err(`bkm: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }
  return code;
}

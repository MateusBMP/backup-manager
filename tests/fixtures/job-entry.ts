// Test stand-in for `bkm __job <id> --config <path>`.
import { stateDir } from "../../src/core/config/defaults.js";
import { loadConfig } from "../../src/core/config/load.js";
import { executeJob } from "../../src/core/jobs/runner.js";

const args = process.argv.slice(2);
const id = args[args.indexOf("__job") + 1] as string;
const configPath = args[args.indexOf("--config") + 1] as string;
const { config } = await loadConfig(configPath);
process.exitCode = await executeJob(stateDir(config), id, configPath);

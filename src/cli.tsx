import { fileURLToPath } from "node:url";
import { main } from "./cli/program.js";
import { setJobCommand } from "./core/jobs/runner.js";

// Jobs and the systemd unit re-invoke this same entry point with the same node flags.
setJobCommand({
  command: process.execPath,
  args: [...process.execArgv, fileURLToPath(import.meta.url)],
});

const code = await main(process.argv.slice(2));
process.exitCode = code;

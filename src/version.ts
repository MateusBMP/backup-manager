import { createRequire } from "node:module";

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    for (const candidate of ["../package.json", "../../package.json"]) {
      try {
        const pkg = require(candidate) as { name?: string; version?: string };
        if (pkg.name === "backup-manager" && pkg.version) return pkg.version;
      } catch {
        // try the next location (src/ in dev, dist/ when built)
      }
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export const VERSION = readVersion();

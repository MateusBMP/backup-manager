import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.tsx" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      "// backup-manager - Copyright (C) 2026 MateusBMP",
      "// SPDX-License-Identifier: GPL-3.0-only (see LICENSE and NOTICE)",
    ].join("\n"),
  },
});

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
  banner: { js: "#!/usr/bin/env node" },
});

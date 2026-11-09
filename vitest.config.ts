import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/integration/**"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/cli.tsx", "src/ui/main.tsx"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 },
      reporter: ["text-summary", "text", "lcov"],
    },
  },
});

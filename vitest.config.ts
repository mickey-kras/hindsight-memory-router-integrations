import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@memory-router": new URL("./src", import.meta.url).pathname } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/upstream/**", "integrations/coding-agents/upstream/**"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 80,
      },
    },
  },
});

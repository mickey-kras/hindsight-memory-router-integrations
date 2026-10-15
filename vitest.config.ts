import { coverageConfigDefaults, defineConfig } from "vitest/config";

const mcpSdk = new URL("./src/upstream/coding-agents/node_modules/@modelcontextprotocol/sdk/dist/esm", import.meta.url)
  .pathname;

export default defineConfig({
  resolve: {
    alias: {
      "@memory-router": new URL("./src", import.meta.url).pathname,
      "@modelcontextprotocol/sdk/client/index.js": `${mcpSdk}/client/index.js`,
      "@modelcontextprotocol/sdk/inMemory.js": `${mcpSdk}/inMemory.js`,
      "@modelcontextprotocol/sdk/types.js": `${mcpSdk}/types.js`,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/plugin.ts",
        "src/shared/**/*.ts",
        "src/coding-agents/**/*.ts",
        "src/upstream/src/retain-queue.ts",
        "src/upstream/src/session-patterns.ts",
      ],
      exclude: coverageConfigDefaults.exclude,
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});

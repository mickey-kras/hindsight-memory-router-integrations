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
    globalSetup: ["./tests/build-packages.ts"],
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [...coverageConfigDefaults.exclude, "src/upstream/**"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});

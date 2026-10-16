import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@memory-router": new URL("../../src", import.meta.url).pathname },
  },
  test: { include: ["scripts/benchmarks/io.test.ts"], testTimeout: 120_000 },
});

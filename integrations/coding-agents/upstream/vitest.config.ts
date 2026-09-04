import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@memory-router": new URL("../../../src", import.meta.url).pathname } },
  test: { include: ["src/core/transcript*.test.ts", "src/core/missions.test.ts", "src/core/uuid.test.ts", "src/core/jsonl.test.ts", "src/core/retain-stamp.test.ts"] },
});

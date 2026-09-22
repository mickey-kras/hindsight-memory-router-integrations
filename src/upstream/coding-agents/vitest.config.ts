import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@memory-router": new URL("../../../src", import.meta.url).pathname } },
  test: { include: ["src/core/private-state.test.ts", "src/core/turn-journal.test.ts", "src/core/turn-journal-policy.test.ts", "src/core/router-survey.test.ts", "src/core/transcript*.test.ts", "src/core/missions.test.ts", "src/core/uuid.test.ts", "src/core/jsonl.test.ts", "src/core/retain-stamp.test.ts", "src/harness/registry.test.ts", "src/harness/hook-lifecycle.test.ts", "src/harness/plugin-entry.test.ts"] },
});

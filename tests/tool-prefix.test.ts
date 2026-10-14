import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadManagedConfig } from "../src/shared/managed-config.js";
import { prefixTools, renderCompanionSkill, validatedToolPrefix } from "../src/shared/tool-prefix.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function config(toolPrefix?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "tool-prefix-"));
  dirs.push(dir);
  const path = join(dir, "router.json");
  writeFileSync(
    path,
    JSON.stringify({
      routerUrl: "https://router.example.test",
      toolPrefix,
      queueDir: dir,
      principals: {
        codex: { tokenEnv: "TEST_TOKEN", writeBank: "private", additionalReadBanks: ["shared"] },
        opencode2: { tokenEnv: "TEST_TOKEN", writeBank: "private" },
      },
    }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
  vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "codex");
  vi.stubEnv("TEST_TOKEN", `mr_codex_${"a".repeat(64)}`);
  return dir;
}
it.each(["", "Hindsight_", "prefix", "with space_", "_", "a/", "a_".repeat(17), null, 1])(
  "rejects invalid config prefix %s",
  (value) => {
    config(value);
    expect(() => loadManagedConfig(process.env, "codex")).toThrow("memory access denied");
    expect(() => validatedToolPrefix(value)).toThrow("invalid toolPrefix");
  },
);
it("rejects collisions and inconsistent namespaces before registration", () => {
  expect(() =>
    prefixTools(
      [
        { name: "memory_router_recall", description: "" },
        { name: "hindsight_recall", description: "" },
      ],
      "team_",
    ),
  ).toThrow("collision");
  expect(() => prefixTools([{ name: "hindsight_recall", description: "" }], "team_", ["team_recall"])).toThrow(
    "collision",
  );
  expect(() => prefixTools([{ name: "other_recall", description: "" }], "team_")).toThrow("inconsistent");
});
it("requires explicit reinstall for legacy or changed skill namespaces", () => {
  const raw = "Call hindsight_reflect and hindsight_ingest_document.";
  const old = renderCompanionSkill(raw, "memory_router_");
  expect(() => renderCompanionSkill(raw, "team_", old)).toThrow("mismatch");
  expect(() => renderCompanionSkill(raw, "hindsight_", "Call agent_knowledge_ingest.")).toThrow("inconsistent");
  expect(() => renderCompanionSkill(`${raw} Call agent_knowledge_ingest.`, "team_")).toThrow("inconsistent");
  expect(renderCompanionSkill(raw, "team_")).toContain("team_reflect");
  expect(renderCompanionSkill(raw, "team_", renderCompanionSkill(raw, "team_"))).toContain("team_ingest_document");
});

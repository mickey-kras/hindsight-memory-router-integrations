import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompanionSkill } from "../src/shared/tool-prefix.js";

const pkgRoot = join(process.cwd(), "src/upstream/coding-agents");
const packaged = () => readFileSync(join(pkgRoot, "skill/SKILL.md"), "utf8");

describe("managed router companion skill", () => {
  it("regenerates exactly from managed operational sources", () => {
    expect(() => execFileSync(process.execPath, [join(pkgRoot, "scripts/build-skill.mjs"), "--check"])).not.toThrow();
  });
  it.each(["hindsight_", "team_"])("renders supported %s tools and managed setup guidance", (prefix) => {
    const skill = renderCompanionSkill(packaged(), prefix);
    for (const suffix of [
      "ingest_document",
      "capture_initiative",
      "search_knowledge_pages",
      "read_knowledge_page",
      "list_knowledge_pages",
      "reflect",
      "sync_status",
      "diagnose",
    ]) {
      expect(skill).toContain(`${prefix}${suffix}`);
    }
    expect(skill).toContain("HINDSIGHT_ROUTER_CONFIG");
    expect(skill).toContain("HINDSIGHT_MCP_HARNESS");
    expect(skill).toContain("PACKAGE_SHA256");
    expect(skill).toContain("--package=/absolute/path/verified-coding-agents.tgz");
    expect(skill).toContain(
      "releases/download/v<release>/mickey-kras-hindsight-memory-router-coding-agents-<package-version>.tgz",
    );
    expect(skill).toContain("Read-only principals skip ingestion and write-back");
    expect(skill).toContain("Session-start and prompt hooks");
    expect(skill).toContain("Correction:");
    expect(skill).not.toContain(`${prefix}list_banks`);
    expect(skill).toContain("ask the operator to check assigned bank");
    expect(skill).not.toMatch(
      /npx|apiToken|apiUrl|HINDSIGHT_API|hindsight\.vectorize\.io|localhost:8888|cloud|daemon|--api-url|--api-token|--server/i,
    );
    expect(skill).toContain("Do not ask the user to paste JSON or credentials.");
    expect(skill).toContain("Do not edit the managed JSON");
    if (prefix === "team_") expect(skill).not.toMatch(/hindsight_(?:reflect|ingest_document|diagnose|sync_status)/);
  });
});

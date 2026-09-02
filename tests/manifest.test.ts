import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

describe("openclaw.plugin.json", () => {
  it("declares the per-agent token SecretRef wildcard contract", () => {
    expect(manifest.configContracts.secretInputs.paths).toEqual([
      { path: "agents.*.token", expected: "string" },
    ]);
  });

  it("declares no other secret input (no global fallback token)", () => {
    const paths = manifest.configContracts.secretInputs.paths.map(
      (entry: { path: string }) => entry.path
    );
    expect(paths).toEqual(["agents.*.token"]);
    expect(JSON.stringify(manifest)).not.toContain("hindsightApiToken");
  });

  it("requires routerUrl and agents in the config schema", () => {
    expect(manifest.configSchema.required).toEqual(["routerUrl", "agents"]);
  });

  it("advertises the knowledge tool contract", () => {
    expect(manifest.contracts.tools).toContain("agent_knowledge_recall");
    expect(manifest.contracts.tools).toContain("agent_knowledge_ingest");
  });
});

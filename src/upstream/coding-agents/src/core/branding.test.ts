import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderCompanionSkill, toolBrand } from "@memory-router/shared/tool-prefix";
import { loadConfig } from "./config";
import { HindsightClient } from "./hindsight";
import { buildKnowledgeTools } from "./knowledge-tools";
import { buildKnowledgePreamble, buildRosterRefresh } from "./knowledge-injection";
import { buildSystemInjection } from "./inject";
import { buildSeedBanner } from "./session-start";
import { assertCompanionSkillPrefix, readPackagedSkill } from "./skill-sync";
import { buildMcpServer } from "../mcp-server";
import { createPluginEntry } from "../harness/plugin-entry";
import { summarizeTurns } from "./usage";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function setup(prefix?: string) {
  const dir = mkdtempSync(join(tmpdir(), "branding-")); dirs.push(dir);
  const path = join(dir, "router.json");
  writeFileSync(path, JSON.stringify({ routerUrl: "https://router.test", toolPrefix: prefix,
    principals: Object.fromEntries(["kilo", "codex", "opencode2"].map(name => [name, { tokenEnv: "TEST_TOKEN", writeBank: "bank", mapPathToBank: { [dir]: "bank" } }])) }));
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path); vi.stubEnv("TEST_TOKEN", `mr_test_${"a".repeat(64)}`);
  vi.stubEnv("HINDSIGHT_CONFIG", join(dir, "normal.json")); vi.stubEnv("HINDSIGHT_DISABLE_HOOKS", "1");
  return dir;
}
it.each([undefined, "abc_", "chatgpt_", "memory_"])("uses one brand for upstream tools, guidance, MCP identity and Kilo native registration: %s", async prefix => {
  const dir = setup(prefix); const brand = toolBrand(prefix);
  const cfg = loadConfig({ harness: "kilo" }); const client = new HindsightClient({ apiUrl: cfg.apiUrl, bank: "bank", routerHarness: "kilo" });
  const tools = buildKnowledgeTools(client, "bank", { toolPrefix: brand.prefix, harness: "kilo" });
  expect(tools).toHaveLength(8); expect(tools.map(tool => tool.name)).not.toContain(brand.prefix + "list_banks");
  expect(tools.every(tool => tool.name.startsWith(brand.prefix))).toBe(true);
  const entry = createPluginEntry("kilo"); const runtime = await entry({ directory: dir, worktree: dir } as Parameters<typeof entry>[0]);
  const host: Parameters<NonNullable<typeof runtime.config>>[0] = {};
  if (!runtime.config) throw new Error("native config hook missing"); await runtime.config(host);
  expect(host.agent?.[`${brand.id}-survey`]?.permission).toEqual({ "*": "deny", read: "allow", grep: "allow", glob: "allow", [`${brand.prefix}ingest_document`]: "allow" });
  expect(runtime.tool).toHaveProperty(`${brand.prefix}reflect`);
  const protocolClient = new Client({ name: "test-host", version: "1.0.0" }); const server = buildMcpServer(tools, brand.prefix);
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(transport); await protocolClient.connect(peer);
    expect(protocolClient.getServerVersion()?.name).toBe(brand.id);
    expect((await protocolClient.listTools()).tools.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
  } finally { await protocolClient.close(); await server.close(); }
  const rendered = readPackagedSkill(undefined, "opencode2"); expect(rendered?.description).toContain(brand.displayName);
  for (const body of [buildKnowledgePreamble([], { toolPrefix: brand.prefix }), buildRosterRefresh([], { toolPrefix: brand.prefix }), buildSystemInjection("unchanged historical Hindsight memory", brand.prefix)]) {
    expect(body).toContain(`From ${brand.displayName} memory`);
    if (prefix) expect(body).not.toContain("call hindsight_ingest_document");
  }
  expect(stripVTControlCharacters(buildSeedBanner("bank", false, undefined, brand.prefix))).toContain(brand.displayName);
  const usage = summarizeTurns([{ role: "user", content: "question" }, { role: "action", content: `${brand.prefix}reflect query` }, { role: "assistant", content: `> From ${brand.displayName} memory` }], brand.prefix);
  expect(usage[0].credited).toBe(true);
});
it("rejects stale skill branding and preserves unmarked user skills", () => {
  const home = setup("abc_"); const base = join(home, ".agents/skills"); const old = join(base, "hindsight-coding-agent"); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "SKILL.md"), renderCompanionSkill("Call hindsight_reflect", "hindsight_"));
  expect(() => assertCompanionSkillPrefix("codex", "abc_", home)).toThrow("reinstall");
  writeFileSync(join(old, "SKILL.md"), "User-owned unmarked content");
  expect(() => assertCompanionSkillPrefix("codex", "abc_", home)).not.toThrow();
  expect(readFileSync(join(old, "SKILL.md"), "utf8")).toBe("User-owned unmarked content");
});
it("rejects MCP identity mismatches and duplicates", () => {
  setup(); const cfg = loadConfig({ harness: "kilo" }); const client = new HindsightClient({ apiUrl: cfg.apiUrl, bank: "bank", routerHarness: "kilo" });
  const tools = buildKnowledgeTools(client, "bank", { harness: "kilo" });
  expect(() => buildMcpServer(tools, "abc_")).toThrow("inconsistent");
  expect(() => buildMcpServer([tools[0], tools[0]])).toThrow("collision");
});

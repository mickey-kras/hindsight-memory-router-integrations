import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadManagedConfig } from "../src/shared/managed-config.js";
import { renderToolText } from "../src/shared/tool-prefix.js";
import { loadConfig } from "../src/upstream/coding-agents/src/core/config";
import { HindsightClient } from "../src/upstream/coding-agents/src/core/hindsight";
import { buildSystemInjection, formatPageFallback } from "../src/upstream/coding-agents/src/core/inject";
import { buildKnowledgePreamble, buildRosterRefresh } from "../src/upstream/coding-agents/src/core/knowledge-injection";
import { buildKnowledgeTools } from "../src/upstream/coding-agents/src/core/knowledge-tools";
import { RuntimeCore } from "../src/upstream/coding-agents/src/core/runtime";
import { readPackagedSkill, syncCompanionSkill } from "../src/upstream/coding-agents/src/core/skill-sync";
import { opencodeAdapter } from "../src/upstream/coding-agents/src/harness/opencode";
import { createPluginEntry } from "../src/upstream/coding-agents/src/harness/plugin-entry";
import { selectTools } from "../src/upstream/coding-agents/src/mcp-server";

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
it.each([undefined, "team_", "memory_router_", "agent_knowledge_"])(
  "uses one configured namespace %s across tools and guidance",
  (value) => {
    config(value);
    const prefix = value ?? "hindsight_";
    expect(loadManagedConfig(process.env, "codex").config.toolPrefix).toBe(prefix);
    const client = new HindsightClient({
      apiUrl: "https://router.example.test",
      bank: "private",
      routerHarness: "codex",
    });
    const tools = selectTools(loadConfig({ harness: "codex" }), client, "private", { harness: "codex" });
    expect(tools.every((tool) => tool.name.startsWith(prefix))).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain(`${prefix}reflect`);
    expect(tools.map((tool) => tool.name)).toContain(`${prefix}read_knowledge_page`);
    const knowledge = buildKnowledgeTools(client, "private", { harness: "codex", toolPrefix: prefix });
    expect(knowledge.every((tool) => tool.name.startsWith(prefix))).toBe(true);
    const opts = { toolPrefix: prefix };
    for (const body of [
      buildKnowledgePreamble([], opts),
      buildRosterRefresh([], opts),
      buildSystemInjection("historical hindsight_ingest_document", prefix),
      formatPageFallback([], undefined, prefix),
    ]) {
      expect(body).toContain(
        prefix +
          (body.includes("knowledge pages matched")
            ? "read_knowledge_page"
            : body.includes("Automatically retrieved")
              ? "ingest_document"
              : "search_knowledge_pages"),
      );
    }
    const skill = readPackagedSkill(undefined, "opencode2")!;
    expect(skill.content).toContain(`${prefix}search_knowledge_pages`);
  },
);
it("rewrites tool references once and preserves retrieval tags and retrieved content", () => {
  expect(renderToolText("hindsight_ingest_document <hindsight_memory>", "hindsight_hindsight_")).toBe(
    "hindsight_hindsight_ingest_document <hindsight_memory>",
  );
  const body = buildSystemInjection("historical hindsight_ingest_document", "team_");
  expect(body).toContain("call team_ingest_document");
  expect(body).toContain("historical hindsight_ingest_document");
  expect(body).toContain("</hindsight_memory>");
});
it("preserves explicit read-bank authorization under a custom prefix", async () => {
  config("team_");
  const client = new HindsightClient({
    apiUrl: "https://router.example.test",
    bank: "private",
    routerHarness: "codex",
  });
  const list = vi.spyOn(HindsightClient.prototype, "listPages").mockResolvedValue({ items: [] });
  const tool = buildKnowledgeTools(client, "private", { toolPrefix: "team_" }).find(
    (tool) => tool.name === "team_list_knowledge_pages",
  )!;
  expect((await tool.handler({ bankId: "shared" })).isError).toBeUndefined();
  expect(list).toHaveBeenCalledOnce();
  expect((await tool.handler({ bankId: "unassigned" })).isError).toBe(true);
});

it("fails closed on installed skill drift without rewriting it", () => {
  const home = config("team_");
  const src = join(home, "source");
  const dst = join(home, ".agents", "skills", "hindsight-coding-agent");
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(src, "SKILL.md"), "Call hindsight_reflect.");
  const previous = "Call memory_router_reflect.\n<!-- hindsight-tool-prefix: memory_router_ -->\n";
  writeFileSync(join(dst, "SKILL.md"), previous);
  expect(() => syncCompanionSkill("codex", { home, srcDir: src, install: true })).toThrow("mismatch");
  expect(readFileSync(join(dst, "SKILL.md"), "utf8")).toBe(previous);
});

it.each([undefined, "team_"])(
  "Kilo-only principal uses its namespace for native tools and survey permissions: %s",
  async (toolPrefix) => {
    const dir = config(toolPrefix);
    writeFileSync(
      join(dir, "router.json"),
      JSON.stringify({
        routerUrl: "https://router.example.test",
        toolPrefix,
        principals: { kilo: { tokenEnv: "TEST_TOKEN", writeBank: "private", mapPathToBank: { [dir]: "private" } } },
      }),
    );
    vi.stubEnv("HINDSIGHT_CONFIG", join(dir, "normal-config.json"));
    vi.stubEnv("HINDSIGHT_DISABLE_HOOKS", "1");
    const entry = createPluginEntry("kilo");
    const runtime = await entry({ worktree: dir, directory: dir } as Parameters<typeof entry>[0]);
    const cfg: { agent?: Record<string, { permission?: Record<string, string> }> } = {};
    if (!runtime.config) throw new Error("Kilo runtime omitted config hook");
    await runtime.config(cfg);
    const prefix = toolPrefix ?? "hindsight_";
    expect(Object.keys(runtime.tool ?? {}).every((name) => name.startsWith(prefix))).toBe(true);
    expect(runtime.tool).toHaveProperty(`${prefix}ingest_document`);
    expect(cfg.agent?.[`${prefix.slice(0, -1).replaceAll("_", "-")}-survey`].permission).toEqual({
      "*": "deny",
      read: "allow",
      grep: "allow",
      glob: "allow",
      [`${prefix}ingest_document`]: "allow",
    });
    if (toolPrefix)
      expect(cfg.agent?.[`${prefix.slice(0, -1).replaceAll("_", "-")}-survey`].permission).not.toHaveProperty(
        "hindsight_ingest_document",
      );
    const resolved = loadConfig({ harness: "kilo" });
    const client = new HindsightClient({ apiUrl: resolved.apiUrl, bank: "private", routerHarness: "kilo" });
    const core = new RuntimeCore(client, "private", resolved, "kilo", dir);
    const spec = core.toolSpecs()[0];
    vi.spyOn(core, "toolSpecs").mockReturnValue([spec, { ...spec }]);
    expect(() => opencodeAdapter.createRuntime(core)).toThrow("collision");
  },
);

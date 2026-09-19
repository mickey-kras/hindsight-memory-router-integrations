import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMcpStack } from "../src/mcp/managed-config.js";
import type { buildMcpServer } from "../src/mcp/server.js";
import { buildTools } from "../src/mcp/tools.js";

interface McpSdk {
  Client: typeof Client;
  InMemoryTransport: typeof InMemoryTransport;
  buildMcpServer: typeof buildMcpServer;
  serverName: string;
}

async function loadSdk(): Promise<McpSdk | undefined> {
  try {
    const [{ Client: ClientImpl }, { InMemoryTransport: Transport }, server] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
      import("../src/mcp/server.js"),
    ]);
    return {
      Client: ClientImpl,
      InMemoryTransport: Transport,
      buildMcpServer: server.buildMcpServer,
      serverName: server.SERVER_NAME,
    };
  } catch {
    // The main-workflow coverage job runs the root suite without installing src/mcp deps.
    return undefined;
  }
}

const sdk = await loadSdk();

const TOKEN = `mr_agent-key_${"a".repeat(64)}`;
const ROUTER = "https://router.example.test";
const dirs: string[] = [];
const logger = { warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function configure(principal: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-server-test-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "router.json"),
    JSON.stringify({ routerUrl: ROUTER, queueDir: join(dir, "queue"), principals: { agent: principal } }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", join(dir, "router.json"));
  vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "agent");
  vi.stubEnv("TEST_AGENT_TOKEN", TOKEN);
}

async function wiredClient(loaded: McpSdk) {
  const stack = loadMcpStack(process.env, logger);
  const [clientTransport, serverTransport] = loaded.InMemoryTransport.createLinkedPair();
  const server = loaded.buildMcpServer(buildTools(stack));
  const client = new loaded.Client({ name: "test-client", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe.runIf(sdk !== undefined)("MCP wire protocol", () => {
  const loaded = sdk as McpSdk;

  it("advertises the routed tools with explicit safety annotations", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank", additionalReadBanks: ["shared-bank"] });
    const { client, close } = await wiredClient(loaded);
    try {
      expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
      expect(client.getServerVersion()).toMatchObject({ name: loaded.serverName });
      const listed = await client.listTools();
      const annotations = Object.fromEntries(listed.tools.map((entry) => [entry.name, entry.annotations]));
      expect(Object.keys(annotations).sort()).toEqual(
        [
          "memory_router_retain",
          "memory_router_recall",
          "agent_knowledge_list_pages",
          "agent_knowledge_get_page",
          "agent_knowledge_create_page",
          "agent_knowledge_update_page",
          "agent_knowledge_delete_page",
          "agent_knowledge_ingest",
        ].sort(),
      );
      expect(annotations.memory_router_recall).toMatchObject({ readOnlyHint: true });
      expect(annotations.memory_router_retain).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(annotations.agent_knowledge_delete_page).toMatchObject({ destructiveHint: true });
      const createPage = listed.tools.find((entry) => entry.name === "agent_knowledge_create_page");
      const properties = createPage?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined;
      expect(properties?.bankId.enum?.slice().sort()).toEqual(["agent-bank", "shared-bank"]);
    } finally {
      await close();
    }
  });

  it("exposes only read tools for a read-only principal", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", additionalReadBanks: ["shared-bank"] });
    const { client, close } = await wiredClient(loaded);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((entry) => entry.name);
      expect(names).toEqual(
        expect.arrayContaining(["memory_router_recall", "agent_knowledge_list_pages", "agent_knowledge_get_page"]),
      );
      expect(names).not.toContain("memory_router_retain");
      expect(names).not.toContain("agent_knowledge_ingest");
    } finally {
      await close();
    }
  });

  it("retains through the wire into the write bank only", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank", additionalReadBanks: ["shared-bank"] });
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    const { client, close } = await wiredClient(loaded);
    try {
      const result = await client.callTool({
        name: "memory_router_retain",
        arguments: { content: "remember this", tags: ["ops"] },
      });
      expect(result.isError).toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
      const [url, init] = send.mock.calls[0];
      expect(String(url)).toBe(`${ROUTER}/v1/default/banks/agent-bank/memories`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    } finally {
      await close();
    }
  });

  it("recalls through the wire across every visible bank", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank", additionalReadBanks: ["shared-bank"] });
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("shared-bank")) return Response.json({ results: [{ text: "shared fact", score: 0.9 }] });
      return Response.json({ results: [{ text: "own fact", score: 0.8 }] });
    });
    const { client, close } = await wiredClient(loaded);
    try {
      const result = await client.callTool({ name: "memory_router_recall", arguments: { query: "facts" } });
      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      const payload = JSON.parse(text);
      expect(payload.results).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
      const urls = send.mock.calls.map(([url]) => String(url));
      expect(urls).toContain(`${ROUTER}/v1/default/banks/agent-bank/memories/recall`);
      expect(urls).toContain(`${ROUTER}/v1/default/banks/shared-bank/memories/recall`);
    } finally {
      await close();
    }
  });

  it("answers unknown tools with a bounded error", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank" });
    const { client, close } = await wiredClient(loaded);
    try {
      const result = await client.callTool({ name: "memory_router_admin", arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toBe(
        "MCP error -32602: Tool memory_router_admin not found",
      );
    } finally {
      await close();
    }
  });

  it("fails closed over the wire on router 401 without echoing token, banks or grants", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank", additionalReadBanks: ["shared-bank"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ grants: ["agent-bank"], token: TOKEN }, { status: 401 }),
    );
    const { client, close } = await wiredClient(loaded);
    try {
      const denied = await client.callTool({ name: "memory_router_recall", arguments: { query: "q" } });
      expect(denied.isError).toBe(true);
      const text = JSON.stringify(denied.content);
      expect(text).toContain("memory access denied");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("agent-bank");
      expect(text).not.toContain("shared-bank");
      expect(text).not.toContain("grants");
      const again = await client.callTool({ name: "memory_router_retain", arguments: { content: "x" } });
      expect(again.isError).toBe(true);
      expect(JSON.stringify(again.content)).toContain("memory access denied");
    } finally {
      await close();
    }
  });

  it("serves concurrent retain and recall calls without cross-talk", async () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank", additionalReadBanks: ["shared-bank"] });
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const url = String(input);
      return url.endsWith("/memories/recall")
        ? Response.json({ results: [{ text: `hit from ${url.split("/banks/")[1]}` }] })
        : Response.json({});
    });
    const { client, close } = await wiredClient(loaded);
    try {
      const calls = Array.from({ length: 12 }, (_, index) =>
        index % 2 === 0
          ? client.callTool({ name: "memory_router_recall", arguments: { query: `q${index}` } })
          : client.callTool({ name: "memory_router_retain", arguments: { content: `c${index}` } }),
      );
      const results = await Promise.all(calls);
      for (const result of results) {
        expect(result.isError).toBeUndefined();
      }
      const recallUrls = send.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith("/memories/recall"));
      expect(recallUrls).toHaveLength(12);
      expect(new Set(recallUrls).size).toBe(2);
    } finally {
      await close();
    }
  });
});

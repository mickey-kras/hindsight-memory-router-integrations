import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RecallCoordinator } from "../src/shared/recall-coordinator.js";
import { RetainCoordinator } from "../src/shared/retain-coordinator.js";
import type { McpStack } from "../src/mcp/managed-config.js";
import { buildTools, type McpTool } from "../src/mcp/tools.js";

// Knowledge tool definitions are supplied by the upstream SDK; swap them to
// exercise schema-shim branches the pinned upstream definitions never hit.
const sdkDefinitions = vi.hoisted(() => ({ tools: [] as unknown[] }));

vi.mock("@vectorize-io/hindsight-agent-sdk", () => ({
  createKnowledgeTools: () => sdkDefinitions.tools,
}));

const TOKEN = `mr_agent-key_${"a".repeat(64)}`;
const ROUTER = "https://router.example.test";
const dirs: string[] = [];
const logger = { warn: vi.fn(), error: vi.fn() };

const LIST_PAGES = {
  name: "agent_knowledge_list_pages",
  description: "List pages.",
  parameters: { type: "object", properties: {} },
};
const GET_PAGE_WITHOUT_DESCRIPTIONS = {
  name: "agent_knowledge_get_page",
  description: "Get a page.",
  parameters: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
};
const RECALL_PASSTHROUGH = {
  name: "agent_knowledge_recall",
  description: "Upstream recall passthrough; never advertised.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

beforeEach(() => {
  sdkDefinitions.tools = [LIST_PAGES, GET_PAGE_WITHOUT_DESCRIPTIONS, RECALL_PASSTHROUGH];
});

afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function makeStack(options: { writeBank?: string | null }): McpStack {
  const queueDir = mkdtempSync(join(tmpdir(), "mcp-tools-branches-test-"));
  dirs.push(queueDir);
  const writeBank = options.writeBank === undefined ? "agent-bank" : options.writeBank;
  const credentials = new PrincipalCredentialResolver({
    principals: {
      agent: {
        token: TOKEN,
        writeBank: writeBank ?? undefined,
        additionalReadBanks: ["shared-bank"],
      },
    },
  });
  credentials.validateConfiguredPrincipals();
  const clients = new AuthenticatedClientFactory({ routerUrl: ROUTER, userAgent: "mcp-test/0" });
  return {
    principalId: "agent",
    recallTimeoutMs: 1000,
    recallMaxTokens: 512,
    credentials,
    clients,
    recall: new RecallCoordinator(),
    retain: new RetainCoordinator({ credentials, clients, queueDir, logger }),
    audit: vi.fn(),
  };
}

function tool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    Promise.resolve(handler(String(input), init ?? {})),
  );
}

describe("argument validation branches", () => {
  it("rejects non-object arguments with the root issue message", async () => {
    const stack = makeStack({});
    const args = "not-an-object" as unknown as Record<string, unknown>;
    const result = await tool(buildTools(stack), "memory_router_retain").handler(args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid arguments for memory_router_retain: ");
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_retain",
      outcome: "failure",
      errorClass: "invalid_arguments",
    });
  });
});

describe("retain option normalization branches", () => {
  it("strips blank documentId and context instead of forwarding them", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "memory_router_retain").handler({
      content: "remember this",
      documentId: "   ",
      context: "\t",
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(String(send.mock.calls[0][1]?.body));
    expect("document_id" in body.items[0]).toBe(false);
  });

  it("audits an undefined bankId when the write bank disappears before the handler runs", async () => {
    const stack = makeStack({});
    const tools = buildTools(stack);
    vi.spyOn(stack.credentials, "resolveOptionalWriteBank").mockReturnValue(null);
    const result = await tool(tools, "memory_router_retain").handler({ content: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("memory operation failed");
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_retain",
      outcome: "failure",
      bankId: undefined,
      errorClass: "identity_resolution_failed",
    });
  });
});

describe("knowledge schema shim branches", () => {
  it("rejects knowledge tools whose schema uses an unsupported argument type", () => {
    sdkDefinitions.tools = [
      {
        name: "agent_knowledge_create_page",
        description: "Create a page.",
        parameters: {
          type: "object",
          properties: { page_id: { type: "string" }, weight: { type: "number" } },
        },
      },
    ];
    const stack = makeStack({});
    expect(() => buildTools(stack)).toThrow(new TypeError("unsupported knowledge tool argument type for weight"));
  });

  it("builds input schemas for properties without descriptions", async () => {
    const send = stubFetch(() => Response.json({ pages: [] }));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "agent_knowledge_get_page").handler({ page_id: "p 1" });
    expect(result.isError).toBeUndefined();
    expect(String(send.mock.calls[0][0])).toBe(`${ROUTER}/v1/default/banks/agent-bank/mental-models/p%201`);
  });

  it("audits an undefined bankId for a read-only principal when no explicit bank is given", async () => {
    const stack = makeStack({ writeBank: null });
    const result = await tool(buildTools(stack), "agent_knowledge_list_pages").handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("memory access denied");
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "agent_knowledge_list_pages",
      outcome: "failure",
      errorClass: "access_denied",
    });
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory, type RouterClient } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver, UnknownPrincipalError } from "../src/shared/principal-credential-resolver.js";
import { RecallCoordinator } from "../src/shared/recall-coordinator.js";
import { RetainCoordinator } from "../src/shared/retain-coordinator.js";
import type { McpStack } from "../src/mcp/managed-config.js";
import { buildTools, type McpTool } from "../src/mcp/tools.js";

const TOKEN = `mr_agent-key_${"a".repeat(64)}`;
const ROUTER = "https://router.example.test";
const dirs: string[] = [];
const logger = { warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function makeStack(options: {
  writeBank?: string | null;
  additionalReadBanks?: string[];
  source?: string;
  construct?: (options: { baseUrl: string; apiKey: string; headers: Record<string, string> }) => RouterClient;
}): McpStack {
  const queueDir = mkdtempSync(join(tmpdir(), "mcp-tools-test-"));
  dirs.push(queueDir);
  const writeBank = options.writeBank === undefined ? "agent-bank" : options.writeBank;
  const credentials = new PrincipalCredentialResolver({
    principals: {
      agent: {
        token: TOKEN,
        writeBank: writeBank ?? undefined,
        additionalReadBanks: options.additionalReadBanks ?? ["shared-bank"],
      },
    },
  });
  credentials.validateConfiguredPrincipals();
  const clients = new AuthenticatedClientFactory({
    routerUrl: ROUTER,
    userAgent: "mcp-test/0",
    construct: options.construct,
  });
  return {
    principalId: "agent",
    source: options.source,
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
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => Promise.resolve(handler(String(input), init ?? {})));
}

describe("memory_router_retain", () => {
  it("retains only into the principal's write bank", async () => {
    const retained: Array<{ bank: string; content: string; options?: Record<string, unknown> }> = [];
    const stack = makeStack({
      construct: () => ({
        retain: async (bank, content, options) => {
          retained.push({ bank, content, options });
        },
        recall: async () => ({ results: [] }),
      }),
    });
    const result = await tool(buildTools(stack), "memory_router_retain").handler({ content: "remember this" });
    expect(result.isError).toBeUndefined();
    expect(retained).toHaveLength(1);
    expect(retained[0].bank).toBe("agent-bank");
    expect(JSON.parse(result.content[0].text)).toEqual({ retained: true, queued: false });
  });

  it("POSTs /memories to the write bank URL with the principal bearer token", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    await tool(buildTools(stack), "memory_router_retain").handler({
      content: "remember this",
      documentId: "doc-1",
      tags: ["ops"],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(String(url)).toBe(`${ROUTER}/v1/default/banks/agent-bank/memories`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init?.body));
    expect(body.items[0].document_id).toBe("doc-1");
    expect(body.items[0].tags).toEqual(["ops"]);
  });

  it("stamps the configured source into retain metadata, never a hardcoded product name", async () => {
    const metadata: unknown[] = [];
    const stack = makeStack({
      source: "my-product",
      construct: () => ({
        retain: async (_bank, _content, options) => {
          metadata.push(options?.metadata);
        },
        recall: async () => ({ results: [] }),
      }),
    });
    await tool(buildTools(stack), "memory_router_retain").handler({ content: "x" });
    expect(metadata[0]).toMatchObject({ agent: "agent", source: "my-product" });
    expect(JSON.stringify(metadata[0])).not.toContain("openclaw");
  });

  it("omits the source metadata key when none is configured", async () => {
    const metadata: unknown[] = [];
    const stack = makeStack({
      construct: () => ({
        retain: async (_bank, _content, options) => {
          metadata.push(options?.metadata);
        },
        recall: async () => ({ results: [] }),
      }),
    });
    await tool(buildTools(stack), "memory_router_retain").handler({ content: "x" });
    expect(metadata[0]).toEqual({ agent: "agent" });
  });

  it("queues the retain on a transient router failure and replays it later", async () => {
    let calls = 0;
    const send = stubFetch(() => {
      calls += 1;
      return calls === 1 ? Response.json({}, { status: 503 }) : Response.json({});
    });
    const stack = makeStack({});
    const retainCall = tool(buildTools(stack), "memory_router_retain").handler({ content: "buffer me" });
    const result = await retainCall;
    expect(JSON.parse(result.content[0].text)).toEqual({ retained: true, queued: true });
    const queueDir = dirs[0];
    const queueFile = join(queueDir, "hindsight-retain-queue.agent.jsonl");
    expect(JSON.parse(readFileSync(queueFile, "utf8").trim()).bankId).toBe("agent-bank");
    await stack.retain.flushQueues();
    expect(calls).toBe(2);
    expect(existsSync(queueFile) ? readFileSync(queueFile, "utf8").trim() : "").toBe("");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("answers a bounded denial on router 401 and latches the credential for the session", async () => {
    const send = stubFetch(() => Response.json({}, { status: 401 }));
    const stack = makeStack({});
    const retainTool = tool(buildTools(stack), "memory_router_retain");
    const first = await retainTool.handler({ content: "x" });
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toBe("memory access denied");
    const second = await retainTool.handler({ content: "y" });
    expect(second.isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    for (const result of [first, second]) {
      expect(result.content[0].text).not.toContain(TOKEN);
      expect(result.content[0].text).not.toContain("agent-bank");
    }
  });

  it("maps unexpected retain failures to a generic bounded error", async () => {
    const stack = makeStack({
      construct: () => ({
        retain: async () => {
          throw new TypeError(`payload echo ${TOKEN} agent-bank`);
        },
        recall: async () => ({ results: [] }),
      }),
    });
    const result = await tool(buildTools(stack), "memory_router_retain").handler({ content: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("memory operation failed");
    expect(result.content[0].text).not.toContain(TOKEN);
    expect(result.content[0].text).not.toContain("agent-bank");
  });

  it.each([
    ["non-array", { content: "x", tags: "ops" }, "tags"],
    ["empty array", { content: "x", tags: [] }, "tags"],
    ["non-string member", { content: "x", tags: ["ops", 7] }, "tags.1"],
    ["blank member", { content: "x", tags: ["ops", " "] }, "tags.1"],
  ])("rejects malformed tags (%s) without touching the router", async (_label, args, path) => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "memory_router_retain").handler(args);
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(
      `invalid arguments for memory_router_retain: ${path}: tags must be a non-empty string array`,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an empty content without touching the router", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "memory_router_retain").handler({ content: "   " });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe("invalid arguments for memory_router_retain: content: content is required");
    expect(send).not.toHaveBeenCalled();
  });

  it("is not exposed for a read-only principal", () => {
    const stack = makeStack({ writeBank: null });
    const names = buildTools(stack).map((candidate) => candidate.name);
    expect(names).not.toContain("memory_router_retain");
    expect(names).toContain("memory_router_recall");
  });
});

describe("memory_router_recall", () => {
  function recallStub(results: Record<string, unknown[]>) {
    const calls: string[] = [];
    return {
      calls,
      construct: () => ({
        retain: async () => {
          throw new Error("read-only test");
        },
        recall: async (bank: string) => {
          calls.push(bank);
          return { results: results[bank] ?? [] };
        },
      }),
    };
  }

  it("fans out to the write bank and additional read banks and merges deterministically", async () => {
    const stub = recallStub({
      "agent-bank": [{ text: "alpha", score: 0.9 }],
      "shared-bank": [
        { text: "beta", score: 0.95 },
        { text: "alpha", score: 0.9 },
      ],
    });
    const stack = makeStack({ construct: stub.construct });
    const result = await tool(buildTools(stack), "memory_router_recall").handler({ query: "deploy" });
    expect(result.isError).toBeUndefined();
    expect(stub.calls.sort()).toEqual(["agent-bank", "shared-bank"]);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.partial).toBe(false);
    expect(payload.results.map((item: { text: string }) => item.text)).toEqual(["beta", "alpha"]);
  });

  it("marks the result partial without naming failed banks", async () => {
    const send = stubFetch((url) =>
      url.includes("shared-bank")
        ? Response.json({}, { status: 503 })
        : Response.json({ results: [{ text: "alpha" }] }),
    );
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "memory_router_recall").handler({ query: "deploy" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.partial).toBe(true);
    expect(payload.results).toEqual([{ text: "alpha" }]);
    expect(result.content[0].text).not.toContain("shared-bank");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drops the effective read set for the session after a router 403", async () => {
    const send = stubFetch(() => Response.json({}, { status: 403 }));
    const stack = makeStack({});
    const recall = tool(buildTools(stack), "memory_router_recall");
    const first = await recall.handler({ query: "deploy" });
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toBe("memory access denied");
    expect(first.content[0].text).not.toContain("agent-bank");
    expect(first.content[0].text).not.toContain("shared-bank");
    expect(first.content[0].text).not.toContain(TOKEN);
    const second = await recall.handler({ query: "again" });
    expect(second.isError).toBe(true);
    expect(send.mock.calls.length).toBeLessThanOrEqual(2);
    expect(logger.error.mock.calls.flat().join(" ")).not.toContain(TOKEN);
  });

  it.each([
    ["empty query", { query: " " }, "query: query is required"],
    ["bad budget", { query: "q", budget: "max" }, "budget: budget must be low, mid or high"],
    ["bad maxTokens", { query: "q", maxTokens: 0 }, "maxTokens: maxTokens must be a positive integer"],
    ["bad timeoutMs", { query: "q", timeoutMs: -5 }, "timeoutMs: timeoutMs must be a positive integer"],
    [
      "bad preferObservations",
      { query: "q", preferObservations: "yes" },
      "preferObservations: preferObservations must be a boolean",
    ],
    ["non-array types", { query: "q", types: "world" }, "types: types must be a non-empty string array"],
    ["empty types", { query: "q", types: [] }, "types: types must be a non-empty string array"],
    ["mixed types", { query: "q", types: ["world", 3] }, "types.1: types must be a non-empty string array"],
  ])("rejects %s with a bounded message", async (_label, args, detail) => {
    const send = stubFetch(() => Response.json({ results: [] }));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "memory_router_recall").handler(args);
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(`invalid arguments for memory_router_recall: ${detail}`);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports all-transient failures as partial without leaking response bodies", async () => {
    stubFetch(() => Response.json({ secret: "grants" }, { status: 502 }));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "memory_router_recall").handler({ query: "q" });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ results: [], partial: true });
    expect(result.content[0].text).not.toContain("grants");
  });
});

describe("agent_knowledge tools", () => {
  it("constrains bankId to the principal's visible banks in the advertised schema", () => {
    const stack = makeStack({});
    const createPage = tool(buildTools(stack), "agent_knowledge_create_page");
    const bankId = createPage.inputSchema.bankId;
    expect(bankId.safeParse("agent-bank").success).toBe(true);
    expect(bankId.safeParse("shared-bank").success).toBe(true);
    expect(bankId.safeParse("other-bank").success).toBe(false);
    expect(bankId.safeParse(undefined).success).toBe(true);
  });

  it("denies knowledge operations against banks outside the visible set", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "agent_knowledge_list_pages").handler({ bankId: "other-bank" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid arguments for agent_knowledge_list_pages: bankId:");
    expect(send).not.toHaveBeenCalled();
  });

  it("denies write operations against an additional read bank", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "agent_knowledge_ingest").handler({
      bankId: "shared-bank",
      title: "Runbook",
      content: "steps",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("memory access denied");
    expect(send).not.toHaveBeenCalled();
  });

  it("routes ingest to the write bank only", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "agent_knowledge_ingest").handler({
      title: "Runbook",
      content: "steps",
    });
    expect(result.isError).toBeUndefined();
    expect(String(send.mock.calls[0][0])).toBe(`${ROUTER}/v1/default/banks/agent-bank/memories`);
  });

  it("hides write knowledge tools for a read-only principal but keeps reads", () => {
    const stack = makeStack({ writeBank: null });
    const names = buildTools(stack).map((candidate) => candidate.name);
    for (const write of [
      "agent_knowledge_create_page",
      "agent_knowledge_update_page",
      "agent_knowledge_delete_page",
      "agent_knowledge_ingest",
    ]) {
      expect(names).not.toContain(write);
    }
    expect(names).toContain("agent_knowledge_list_pages");
    expect(names).toContain("agent_knowledge_get_page");
  });

  it("advertises the destructive delete annotation only for delete_page", () => {
    const stack = makeStack({});
    const tools = buildTools(stack);
    const annotations = Object.fromEntries(tools.map((candidate) => [candidate.name, candidate.annotations]));
    expect(annotations.agent_knowledge_delete_page).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(annotations.agent_knowledge_ingest).toMatchObject({ destructiveHint: false, readOnlyHint: false });
    expect(annotations.agent_knowledge_list_pages).toMatchObject({ readOnlyHint: true });
    expect(annotations.memory_router_recall).toMatchObject({ readOnlyHint: true });
    expect(annotations.memory_router_retain).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("never advertises the denied agent_knowledge_recall or reflect passthroughs", () => {
    const stack = makeStack({});
    const names = buildTools(stack).map((candidate) => candidate.name);
    expect(names).not.toContain("agent_knowledge_recall");
    expect(names).not.toContain("agent_knowledge_reflect");
  });

  it("maps a knowledge read router failure to a bounded error", async () => {
    stubFetch(() => Response.json({}, { status: 500 }));
    const stack = makeStack({});
    const result = await tool(buildTools(stack), "agent_knowledge_list_pages").handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("memory request failed (500)");
  });
});

describe("tool audit logging", () => {
  function auditEvents(stack: McpStack): Array<Record<string, unknown>> {
    return (stack.audit as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event);
  }

  it("records a successful retain with principal, op, and bank, never the content", async () => {
    const stack = makeStack({
      construct: () => ({
        retain: async () => ({}),
        recall: async () => ({ results: [] }),
      }),
    });
    await tool(buildTools(stack), "memory_router_retain").handler({ content: "remember this" });
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_retain",
      outcome: "success",
      bankId: "agent-bank",
    });
    expect(JSON.stringify(auditEvents(stack))).not.toContain("remember this");
  });

  it("records a bounded error class for a denied retain", async () => {
    stubFetch(() => Response.json({}, { status: 401 }));
    const stack = makeStack({});
    await tool(buildTools(stack), "memory_router_retain").handler({ content: "x" });
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_retain",
      outcome: "failure",
      bankId: "agent-bank",
      errorClass: "access_denied",
    });
  });

  it("records malformed arguments as a failure before any router call", async () => {
    const send = stubFetch(() => Response.json({}));
    const stack = makeStack({});
    await tool(buildTools(stack), "memory_router_retain").handler({ content: "   " });
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_retain",
      outcome: "failure",
      errorClass: "invalid_arguments",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("records a successful recall with the full read set as bankId", async () => {
    const stack = makeStack({
      construct: () => ({
        retain: async () => {
          throw new Error("read-only test");
        },
        recall: async () => ({ results: [] }),
      }),
    });
    await tool(buildTools(stack), "memory_router_recall").handler({ query: "deploy" });
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_recall",
      outcome: "success",
      bankId: "agent-bank,shared-bank",
    });
  });

  it("records a router failure class for a failed knowledge read", async () => {
    stubFetch(() => Response.json({}, { status: 500 }));
    const stack = makeStack({});
    await tool(buildTools(stack), "agent_knowledge_list_pages").handler({});
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "agent_knowledge_list_pages",
      outcome: "failure",
      bankId: "agent-bank",
      errorClass: "router_request_failed",
    });
  });

  it("records a successful knowledge write with the explicit bankId", async () => {
    stubFetch(() => Response.json({}));
    const stack = makeStack({});
    await tool(buildTools(stack), "agent_knowledge_ingest").handler({
      bankId: "agent-bank",
      title: "Runbook",
      content: "steps",
    });
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "agent_knowledge_ingest",
      outcome: "success",
      bankId: "agent-bank",
    });
  });

  it("a throwing audit sink on the success path never breaks the op or reclassifies it", async () => {
    const retained: string[] = [];
    const stack = makeStack({
      construct: () => ({
        retain: async () => {
          retained.push("x");
        },
        recall: async () => ({ results: [] }),
      }),
    });
    (stack.audit as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sink down");
    });
    const result = await tool(buildTools(stack), "memory_router_retain").handler({ content: "x" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ retained: true, queued: false });
    expect(retained).toHaveLength(1);
    expect(stack.audit).toHaveBeenCalledTimes(1);
  });

  it("a throwing audit sink on the invalid-arguments and failure paths still returns bounded errors", async () => {
    stubFetch(() => Response.json({}, { status: 401 }));
    const stack = makeStack({});
    (stack.audit as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sink down");
    });
    const retain = tool(buildTools(stack), "memory_router_retain");
    const invalid = await retain.handler({ content: "   " });
    expect(invalid.content[0].text).toContain("invalid arguments for memory_router_retain");
    const denied = await retain.handler({ content: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toBe("memory access denied");
  });

  it("a credential-resolution throw while deriving bankId stays inside the guarded path", async () => {
    const stack = makeStack({});
    const tools = buildTools(stack);
    vi.spyOn(stack.credentials, "resolveReadBanks").mockImplementation(() => {
      throw new UnknownPrincipalError("agent");
    });
    const result = await tool(tools, "memory_router_recall").handler({ query: "deploy" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("memory operation failed");
    expect(stack.audit).toHaveBeenCalledWith({
      principal: "agent",
      op: "memory_router_recall",
      outcome: "failure",
      errorClass: "identity_resolution_failed",
    });
  });
});

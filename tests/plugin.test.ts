import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin, {
  PLUGIN_ID,
  registerWithStack,
  type RoutingStack,
} from "../src/plugin.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import {
  AuthenticatedClientFactory,
  type RouterClient,
} from "../src/shared/authenticated-client-factory.js";
import { ReadBankResolver } from "../src/shared/read-bank-resolver.js";
import {
  RecallAuthorizationError,
  RecallCoordinator,
} from "../src/shared/recall-coordinator.js";
import {
  RetainAuthorizationError,
  RetainCoordinator,
} from "../src/shared/retain-coordinator.js";
import { WriteBankResolver } from "../src/shared/write-bank-resolver.js";

const TOKEN_MAIN = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_BACKEND = `mr_backend-key_${"b".repeat(64)}`;

function pluginConfig(queueDir: string) {
  return {
    routerUrl: "https://router.example.test",
    agents: {
      main: { token: TOKEN_MAIN, writeBank: "main", additionalReadBanks: ["main", "dev"] },
      backend: {
        token: TOKEN_BACKEND,
        writeBank: "dev",
        additionalReadBanks: ["dev", "dev-best-practices"],
      },
    },
    queueDir,
    enableKnowledgeTools: true,
  };
}

interface FakeApi {
  config: any;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  handlers: Map<string, (event: any, ctx?: any) => unknown>;
  services: Array<{ id: string; start(): Promise<void>; stop(): Promise<void> }>;
  toolFactories: Array<{ factory: (ctx: any) => unknown; opts?: { names?: string[] } }>;
  on(event: string, handler: (event: any, ctx?: any) => unknown): void;
  registerService(service: { id: string; start(): Promise<void>; stop(): Promise<void> }): void;
  registerTool(factory: (ctx: any) => unknown, opts?: { names?: string[] }): void;
}

function makeApi(queueDir: string): FakeApi {
  const api: FakeApi = {
    config: { plugins: { entries: { [PLUGIN_ID]: { config: pluginConfig(queueDir) } } } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    handlers: new Map(),
    services: [],
    toolFactories: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    registerService(service) {
      this.services.push(service);
    },
    registerTool(factory, opts) {
      this.toolFactories.push({ factory, opts });
    },
  };
  return api;
}

/** Stack whose clients record their credentials and serve canned responses. */
function instrumentedStack(
  queueDir: string,
  sink: {
    constructed: Array<{ apiKey: string; agentHeader: string }>;
    recalls: Array<{ bank: string; query: string }>;
    retains: Array<{ bank: string; content: string }>;
    recallResults?: Record<string, Array<{ text: string; score: number }>>;
  }
): RoutingStack {
  const config = pluginConfig(queueDir);
  const credentials = new PrincipalCredentialResolver({ ...config, principals: config.agents });
  const clients = new AuthenticatedClientFactory({
    routerUrl: config.routerUrl,
    userAgent: "test/0",
    construct: (options) => {
      sink.constructed.push({
        apiKey: options.apiKey,
        agentHeader: options.headers["x-memory-router-agent"],
      });
      const client: RouterClient = {
        async retain(bank, content) {
          sink.retains.push({ bank, content });
          return {};
        },
        async recall(bank, query) {
          sink.recalls.push({ bank, query });
          return { results: sink.recallResults?.[bank] ?? [] };
        },
      };
      return client;
    },
  });
  const logger = { warn: () => {}, error: () => {} };
  return {
    config,
    credentials,
    clients,
    recallBanks: new ReadBankResolver(credentials),
    writeBanks: new WriteBankResolver(credentials),
    recall: new RecallCoordinator(),
    retain: new RetainCoordinator({
      credentials,
      writeBanks: new WriteBankResolver(credentials),
      clients,
      queueDir,
      logger,
    }),
  };
}

describe("plugin wiring", () => {
  let queueDir: string;
  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), "plugin-test-"));
  });
  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
  });

  it("registers hooks, service, and knowledge tools", () => {
    const api = makeApi(queueDir);
    plugin(api as any);
    expect(api.handlers.has("before_prompt_build")).toBe(true);
    expect(api.handlers.has("agent_end")).toBe(true);
    expect(api.handlers.has("session_end")).toBe(true);
    expect(api.services[0]?.id).toBe(PLUGIN_ID);
    expect(api.toolFactories).toHaveLength(1);
  });

  it("auto-recall selects credentials and banks from trusted ctx.agentId", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
      recallResults: {
        main: [{ text: "main memory", score: 0.9 }],
        dev: [{ text: "dev memory", score: 0.8 }],
      },
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));

    const result = (await api.handlers.get("before_prompt_build")!(
      { prompt: "what do you remember?" },
      { agentId: "main" }
    )) as { prependContext?: string };

    expect(sink.constructed).toEqual([{ apiKey: TOKEN_MAIN, agentHeader: "main" }]);
    expect(sink.recalls.map((r) => r.bank)).toEqual(["main", "dev"]);
    expect(result.prependContext).toContain("<hindsight_memories>");
    expect(result.prependContext).toContain("main memory");
    expect(result.prependContext).toContain("dev memory");
  });

  it("auto-retain routes to the agent's default write bank", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));

    await api.handlers.get("agent_end")!(
      {
        context: {
          sessionEntry: { messages: [{ role: "user", content: "remember this" }] },
        },
      },
      { agentId: "backend", sessionKey: "agent:backend:telegram:dm:1" }
    );

    expect(sink.constructed).toEqual([{ apiKey: TOKEN_BACKEND, agentHeader: "backend" }]);
    expect(sink.retains).toHaveLength(1);
    expect(sink.retains[0].bank).toBe("dev");
    expect(sink.retains[0].content).toContain("remember this");
  });

  it("normalizes structured messages and does not retain the same turn twice", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    const event = {
      messages: [
        { role: "user", content: [{ type: "text", text: "remember this" }] },
        { role: "assistant", content: [{ type: "text", text: "saved" }] },
      ],
    };
    const ctx = { agentId: "main", sessionKey: "agent:main:main" };
    await api.handlers.get("agent_end")!(event, ctx);
    await api.handlers.get("session_end")!(event, ctx);
    expect(sink.retains).toHaveLength(1);
    expect(sink.retains[0].content).not.toContain("[object Object]");
    expect(JSON.parse(sink.retains[0].content)).toEqual([
      { role: "user", content: "remember this" },
      { role: "assistant", content: "saved" },
    ]);
    await api.handlers.get("agent_end")!(event, ctx);
    expect(sink.retains).toHaveLength(2);
  });

  it("auto-recall fails closed for unknown agents: no client, no injection", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    const result = await api.handlers.get("before_prompt_build")!(
      { prompt: "hello there" },
      { agentId: "unknown-agent" }
    );
    expect(result).toBeUndefined();
    expect(sink.constructed).toHaveLength(0);
    expect(sink.recalls).toHaveLength(0);
  });

  it("auto-recall fails closed when ctx.agentId is missing", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    expect(
      await api.handlers.get("before_prompt_build")!({ prompt: "hello there" }, undefined)
    ).toBeUndefined();
    expect(
      await api.handlers.get("before_prompt_build")!({ prompt: "hello there" }, {})
    ).toBeUndefined();
    expect(sink.constructed).toHaveLength(0);
  });

  it("retain hook fails closed for unknown agents without queueing", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    await api.handlers.get("agent_end")!(
      { context: { sessionEntry: { messages: [{ role: "user", content: "hi there" }] } } },
      { agentId: "ghost" }
    );
    expect(sink.constructed).toHaveLength(0);
    expect(sink.retains).toHaveLength(0);
  });

  it("knowledge tools resolve identity per tool context; unknown agent gets no tools", () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    const { factory, opts } = api.toolFactories[0];
    expect(opts?.names).toContain("agent_knowledge_recall");

    const tools = factory({ agentId: "main" }) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain("agent_knowledge_create_page");
    expect(tools.map((t) => t.name)).toContain("agent_knowledge_recall");
    expect(sink.constructed).toHaveLength(0); // no client until a tool executes

    expect(factory({ agentId: "stranger" })).toBeNull();
    expect(factory({})).toBeNull();
  });

  it("knowledge recall tool routes through the multi-bank coordinator", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
      recallResults: {
        dev: [{ text: "dev note", score: 0.9 }],
        "dev-best-practices": [{ text: "bp note", score: 0.8 }],
      },
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    const { factory } = api.toolFactories[0];
    const tools = factory({ agentId: "backend" }) as Array<{
      name: string;
      execute(id: string, params: Record<string, unknown>): Promise<any>;
    }>;
    const recallTool = tools.find((t) => t.name === "agent_knowledge_recall")!;
    const response = await recallTool.execute("call-1", { query: "testing" });
    expect(sink.constructed).toEqual([{ apiKey: TOKEN_BACKEND, agentHeader: "backend" }]);
    expect(sink.recalls.map((r) => r.bank)).toEqual(["dev", "dev-best-practices"]);
    expect(response.content[0].text).toContain("dev note");
    expect(response.content[0].text).toContain("bp note");
  });

  it("exposes recall only for a read-only agent", () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    const stack = instrumentedStack(queueDir, sink);
    stack.config.agents = {
      reader: { token: TOKEN_MAIN, additionalReadBanks: ["main"] },
    };
    const credentials = new PrincipalCredentialResolver({ ...stack.config, principals: stack.config.agents });
    stack.credentials = credentials;
    stack.recallBanks = new ReadBankResolver(credentials);
    stack.writeBanks = new WriteBankResolver(credentials);
    registerWithStack(api as any, stack);
    const tools = api.toolFactories[0].factory({ agentId: "reader" }) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["agent_knowledge_list_pages", "agent_knowledge_get_page", "agent_knowledge_recall"]);
  });

  it("never logs raw tokens in warnings or errors", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    await api.handlers.get("before_prompt_build")!({ prompt: "hello there" }, { agentId: "main" });
    await api.handlers.get("agent_end")!(
      { context: { sessionEntry: { messages: [{ role: "user", content: "hi" }] } } },
      { agentId: "backend" }
    );
    const sinkText = [
      ...api.logger.warn.mock.calls,
      ...api.logger.error.mock.calls,
      ...api.logger.info.mock.calls,
    ]
      .flat()
      .map(String)
      .join("\n");
    expect(sinkText).not.toContain(TOKEN_MAIN);
    expect(sinkText).not.toContain(TOKEN_BACKEND);
  });

  it("extracts structured prompts and supports system-context positions", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
      recallResults: { main: [{ content: "structured memory", type: "fact", score: 1 }] },
    };
    const stack = instrumentedStack(queueDir, sink);
    stack.config.recallInjectionPosition = "append";
    registerWithStack(api as any, stack);

    const append = (await api.handlers.get("before_prompt_build")!(
      {
        messages: [
          { role: "assistant", content: "not the query" },
          { role: "user", content: [{ type: "text", text: "structured query" }] },
        ],
      },
      { agentId: "main" }
    )) as { appendSystemContext?: string };
    expect(append.appendSystemContext).toContain("structured memory [fact]");

    stack.config.recallInjectionPosition = "prepend";
    const prepend = (await api.handlers.get("before_prompt_build")!(
      { messages: ["plain string query"] },
      { agentId: "main" }
    )) as { prependSystemContext?: string };
    expect(prepend.prependSystemContext).toContain("structured memory");
    expect(sink.recalls.at(-1)?.query).toBe("plain string query");
  });

  it("fails closed on disabled, empty-route, and empty-prompt recall", async () => {
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    const disabledApi = makeApi(queueDir);
    const disabledStack = instrumentedStack(queueDir, sink);
    disabledStack.config.autoRecall = false;
    registerWithStack(disabledApi as any, disabledStack);
    expect(
      await disabledApi.handlers.get("before_prompt_build")!(
        { prompt: "ignored prompt" },
        { agentId: "main" }
      )
    ).toBeUndefined();

    const api = makeApi(queueDir);
    const stack = instrumentedStack(queueDir, sink);
    stack.config.agents = { writer: { token: TOKEN_MAIN, writeBank: "main" } };
    stack.credentials = new PrincipalCredentialResolver({ ...stack.config, principals: stack.config.agents });
    stack.recallBanks = new ReadBankResolver(stack.credentials);
    registerWithStack(api as any, stack);
    expect(
      await api.handlers.get("before_prompt_build")!(
        { prompt: "valid prompt" },
        { agentId: "writer" }
      )
    ).toBeUndefined();

    const noPromptApi = makeApi(queueDir);
    const noPromptStack = instrumentedStack(queueDir, sink);
    registerWithStack(noPromptApi as any, noPromptStack);
    expect(
      await noPromptApi.handlers.get("before_prompt_build")!(
        { messages: [{ role: "assistant", content: "no user prompt" }] },
        { agentId: "main" }
      )
    ).toBeUndefined();
  });

  it("records partial and denied recall without injecting untrusted results", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    const stack = instrumentedStack(queueDir, sink);
    stack.recall.recall = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ text: "partial memory" }],
        partial: true,
        failedBanks: ["dev"],
      })
      .mockRejectedValueOnce(new RecallAuthorizationError("main"))
      .mockRejectedValueOnce(new Error("network down"));
    registerWithStack(api as any, stack);
    const handler = api.handlers.get("before_prompt_build")!;

    expect(await handler({ prompt: "first query" }, { agentId: "main" })).toBeDefined();
    expect(api.logger.warn).toHaveBeenCalledWith("partial recall: banks unavailable: dev");
    expect(await handler({ prompt: "second query" }, { agentId: "main" })).toBeUndefined();
    expect(api.logger.error).toHaveBeenCalledWith(
      "auto-recall denied: recall authorization denied for bank main"
    );
    expect(await handler({ prompt: "third query" }, { agentId: "main" })).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith("auto-recall failed: memory operation failed");
  });

  it("enforces retain filters, reports failures, and manages the flush service", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    const stack = instrumentedStack(queueDir, sink);
    stack.config.ignoreSessionPatterns = ["ignore:*"];
    stack.config.statelessSessionPatterns = ["stateless:*"];
    stack.config.excludeProviders = ["blocked"];
    const retainMock = vi
      .fn()
      .mockResolvedValueOnce({ queued: true, bank: "main" })
      .mockRejectedValueOnce(new RetainAuthorizationError("main"))
      .mockRejectedValueOnce(new Error("retain unavailable"));
    stack.retain.retain = retainMock;
    const flush = vi.spyOn(stack.retain, "flushQueues").mockResolvedValue();
    registerWithStack(api as any, stack);
    const handler = api.handlers.get("agent_end")!;
    const event = { messages: [{ role: "user", content: "remember this" }] };

    await handler(event, { agentId: "main", sessionKey: "ignore:one" });
    await handler(event, { agentId: "main", sessionKey: "stateless:one" });
    await handler(event, {
      agentId: "main",
      sessionKey: "normal:one",
      messageProvider: "blocked",
    });
    await handler({ messages: [] }, { agentId: "main", sessionKey: "normal:empty" });
    await handler(event, { agentId: "main", sessionKey: "normal:queued" });
    expect(api.logger.warn).toHaveBeenCalledWith("retain buffered for agent main (bank: main)");
    await handler(event, { agentId: "main", sessionKey: "normal:denied" });
    expect(api.logger.error).toHaveBeenCalledWith(
      "retain denied: retain authorization denied for bank main"
    );
    await handler(event, { agentId: "main", sessionKey: "normal:failed" });
    expect(api.logger.error).toHaveBeenCalledWith("retain failed: memory operation failed");

    expect(retainMock).toHaveBeenCalledTimes(3);
    expect(retainMock.mock.calls.map(([, request]) => request.documentId)).toEqual([
      expect.stringContaining("openclaw:normal:queued:"),
      expect.stringContaining("openclaw:normal:denied:"),
      expect.stringContaining("openclaw:normal:failed:"),
    ]);

    await api.services[0].start();
    expect(flush).toHaveBeenCalledOnce();
    await api.services[0].stop();
  });

  it("does not retain when autoRetain is disabled", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    const stack = instrumentedStack(queueDir, sink);
    stack.config.autoRetain = false;
    const retainSpy = vi.spyOn(stack.retain, "retain");
    registerWithStack(api as any, stack);
    await api.handlers.get("agent_end")!(
      { context: { sessionEntry: { messages: [{ role: "user", content: "remember this" }] } } },
      { agentId: "main", sessionKey: "agent:main:main" }
    );
    expect(retainSpy).not.toHaveBeenCalled();
    expect(sink.constructed).toHaveLength(0);
  });

  it("skips retain for read-only agents without a write bank", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    const stack = instrumentedStack(queueDir, sink);
    stack.config.agents = {
      reader: { token: TOKEN_MAIN, additionalReadBanks: ["main"] },
    };
    stack.credentials = new PrincipalCredentialResolver({ ...stack.config, principals: stack.config.agents });
    const retainSpy = vi.spyOn(stack.retain, "retain");
    registerWithStack(api as any, stack);
    await api.handlers.get("agent_end")!(
      { context: { sessionEntry: { messages: [{ role: "user", content: "remember this" }] } } },
      { agentId: "reader", sessionKey: "agent:reader:main" }
    );
    expect(retainSpy).not.toHaveBeenCalled();
    expect(sink.constructed).toHaveLength(0);
  });

  it("non-recall knowledge tools pass through to the bank API with details attached", async () => {
    const api = makeApi(queueDir);
    const sink = {
      constructed: [] as Array<{ apiKey: string; agentHeader: string }>,
      recalls: [] as Array<{ bank: string; query: string }>,
      retains: [] as Array<{ bank: string; content: string }>,
    };
    registerWithStack(api as any, instrumentedStack(queueDir, sink));
    const tools = api.toolFactories[0].factory({ agentId: "main" }) as Array<{
      name: string;
      execute(id: string, params: Record<string, unknown>): Promise<any>;
    }>;
    const createPage = tools.find((t) => t.name === "agent_knowledge_create_page")!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "preferences", name: "Preferences" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    try {
      const result = await createPage.execute("call-1", {
        page_id: "preferences",
        name: "Preferences",
        source_query: "What are the user's preferences?",
      });
      expect(result.details).toEqual({});
      expect(result.content[0].text).toContain("preferences");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/v1/default/banks/main/mental-models");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN_MAIN}`);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

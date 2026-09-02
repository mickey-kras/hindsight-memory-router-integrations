import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin, {
  PLUGIN_ID,
  registerWithStack,
  type RoutingStack,
} from "../src/plugin.js";
import { AgentCredentialResolver } from "../src/router/agent-credential-resolver.js";
import {
  AuthenticatedClientFactory,
  type RouterClient,
} from "../src/router/authenticated-client-factory.js";
import { RecallBankResolver } from "../src/router/recall-bank-resolver.js";
import { RecallCoordinator } from "../src/router/recall-coordinator.js";
import { RetainCoordinator } from "../src/router/retain-coordinator.js";
import { WriteBankResolver } from "../src/router/write-bank-resolver.js";

const TOKEN_MAIN = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_BACKEND = `mr_backend-key_${"b".repeat(64)}`;

function pluginConfig(queueDir: string) {
  return {
    routerUrl: "https://router.example.test",
    agents: {
      main: { token: TOKEN_MAIN, writeBank: "main", recallBanks: ["main", "dev"] },
      backend: {
        token: TOKEN_BACKEND,
        writeBank: "dev",
        recallBanks: ["dev", "dev-best-practices"],
      },
    },
    queueDir,
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
  const credentials = new AgentCredentialResolver(config);
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
    recallBanks: new RecallBankResolver(credentials),
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

  it("never logs raw tokens in warnings or errors", async () => {
    const api = makeApi(queueDir);
    plugin(api as any);
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
});

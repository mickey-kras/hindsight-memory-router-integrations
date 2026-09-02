/**
 * hindsight-memory-router OpenClaw plugin.
 *
 * Composition root only. All identity, credential, bank-routing, and
 * multi-bank coordination decisions live in src/router/; the vendored
 * upstream integration in src/upstream/ provides the reusable, identity-free
 * helpers (retain queue, session patterns) and the published Vectorize
 * client/SDK packages provide the wire protocol.
 *
 * Identity rule: the trusted OpenClaw `ctx.agentId` selects credentials.
 * Identity is never taken from prompts, model output, tool arguments, tags,
 * session keys, or user content. Missing/unknown agent mapping fails closed.
 */

import { createKnowledgeTools, TOOL_NAMES } from "@vectorize-io/hindsight-agent-sdk";

import type {
  MoltbotPluginAPI,
  PluginHookAgentContext,
  PluginPromptHookResult,
  PluginToolContext,
} from "./upstream/src/types.js";
import {
  compileSessionPatterns,
  matchesSessionPattern,
} from "./upstream/src/session-patterns.js";
import {
  AgentCredentialResolver,
  CredentialResolutionError,
  UnknownAgentError,
  type RouterPluginConfig,
} from "./router/agent-credential-resolver.js";
import { AuthenticatedClientFactory } from "./router/authenticated-client-factory.js";
import { RecallBankResolver } from "./router/recall-bank-resolver.js";
import { WriteBankResolver } from "./router/write-bank-resolver.js";
import {
  RecallAuthorizationError,
  RecallCoordinator,
  type RecallItem,
} from "./router/recall-coordinator.js";
import {
  RetainAuthorizationError,
  RetainCoordinator,
} from "./router/retain-coordinator.js";

export const PLUGIN_ID = "hindsight-memory-router";
export const PLUGIN_VERSION = "0.11.1-router.1";

const DEFAULT_RECALL_TIMEOUT_MS = 5000;
const DEFAULT_RECALL_MAX_TOKENS = 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 30000;
const DEFAULT_RECALL_PROMPT_PREAMBLE =
  "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:";

interface RuntimePluginConfig extends RouterPluginConfig {
  autoRecall?: boolean;
  autoRetain?: boolean;
  recallBudget?: "low" | "mid" | "high";
  recallTypes?: string[];
  preferObservations?: boolean;
  recallTopK?: number;
  recallPromptPreamble?: string;
  recallInjectionPosition?: "user" | "prepend" | "append";
  retainTags?: string[];
  retainContext?: string;
  retainSource?: string;
  enableKnowledgeTools?: boolean;
  retainQueueFlushIntervalMs?: number;
  retainQueueMaxAgeMs?: number;
  ignoreSessionPatterns?: string[];
  statelessSessionPatterns?: string[];
  excludeProviders?: string[];
}

interface RoutingStack {
  config: RuntimePluginConfig;
  credentials: AgentCredentialResolver;
  clients: AuthenticatedClientFactory;
  recallBanks: RecallBankResolver;
  writeBanks: WriteBankResolver;
  recall: RecallCoordinator;
  retain: RetainCoordinator;
}

function getPluginConfig(api: MoltbotPluginAPI): RuntimePluginConfig {
  const entries = api.config.plugins?.entries ?? {};
  return (entries[PLUGIN_ID]?.config ?? {}) as RuntimePluginConfig;
}

function formatCurrentTimeForRecall(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function formatMemories(results: RecallItem[]): string {
  return results
    .map((item) => {
      const text = typeof item.text === "string" ? item.text : String(item.content ?? "");
      const type = typeof item.type === "string" ? ` [${item.type}]` : "";
      const doc = typeof item.document_id === "string" ? ` [doc:${item.document_id}]` : "";
      return `- ${text}${type}${doc}`;
    })
    .join("\n\n");
}

function extractPrompt(event: {
  prompt?: unknown;
  messages?: unknown;
  rawMessage?: unknown;
}): string | null {
  const candidates = [event.rawMessage, event.prompt];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length >= 5) {
      return candidate.trim();
    }
  }
  if (Array.isArray(event.messages)) {
    const last = [...event.messages].reverse().find((message) => {
      if (typeof message === "string") {
        return message.trim().length >= 5;
      }
      return (
        typeof message === "object" &&
        message !== null &&
        (message as { role?: unknown }).role === "user" &&
        typeof (message as { content?: unknown }).content === "string"
      );
    });
    if (typeof last === "string") {
      return last.trim();
    }
    if (last && typeof last === "object") {
      const content = (last as { content: string }).content;
      if (content.trim().length >= 5) {
        return content.trim();
      }
    }
  }
  return null;
}

function extractTranscript(event: {
  messages?: unknown;
  context?: { sessionEntry?: { messages?: Array<{ role: string; content: string }> } };
}): string | null {
  const entryMessages = event.context?.sessionEntry?.messages;
  if (Array.isArray(entryMessages) && entryMessages.length > 0) {
    return entryMessages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  }
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    return event.messages.map((message) => String(message)).join("\n\n");
  }
  return null;
}

function sanitizeDocumentIdPart(value: string | undefined, fallback: string): string {
  const normalized = (value || "").trim();
  if (!normalized) {
    return fallback;
  }
  return (
    normalized
      .replace(/[^a-zA-Z0-9:_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || fallback
  );
}

function isIdentityError(error: unknown): boolean {
  return error instanceof UnknownAgentError || error instanceof CredentialResolutionError;
}

export function buildRoutingStack(config: RuntimePluginConfig, logger: {
  warn(msg: string): void;
  error(msg: string): void;
}): RoutingStack {
  const credentials = new AgentCredentialResolver(config);
  const clients = new AuthenticatedClientFactory({
    routerUrl: config.routerUrl,
    userAgent: `hindsight-memory-router-openclaw/${PLUGIN_VERSION}`,
  });
  const recallBanks = new RecallBankResolver(credentials);
  const writeBanks = new WriteBankResolver(credentials);
  const retain = new RetainCoordinator({
    credentials,
    writeBanks,
    clients,
    queueDir: config.queueDir ?? ".openclaw/hindsight-retain-queue",
    queueMaxAgeMs: config.retainQueueMaxAgeMs,
    logger,
  });
  return { config, credentials, clients, recallBanks, writeBanks, recall: new RecallCoordinator(), retain };
}

export default function hindsightMemoryRouterPlugin(api: MoltbotPluginAPI): void {
  const log = api.logger;
  const config = getPluginConfig(api);
  let stack: RoutingStack;
  try {
    stack = buildRoutingStack(config, log);
  } catch (error) {
    // Invalid routerUrl etc.: fail closed at load time, never partially armed.
    log.error(`plugin disabled: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  registerWithStack(api, stack);
}

/** Registration, separated from stack construction for tests. */
export function registerWithStack(api: MoltbotPluginAPI, stack: RoutingStack): void {
  const log = api.logger;
  const config = stack.config;

  const ignorePatterns = compileSessionPatterns(config.ignoreSessionPatterns ?? []);
  const statelessPatterns = compileSessionPatterns(config.statelessSessionPatterns ?? []);
  const sessionSequences = new Map<string, number>();

  api.on(
    "before_prompt_build",
    async (event: any, ctx?: PluginHookAgentContext): Promise<PluginPromptHookResult | void> => {
      if (config.autoRecall === false) {
        return;
      }
      const agentId = ctx?.agentId;
      try {
        const credentials = stack.credentials.resolve(agentId);
        const banks = stack.recallBanks.resolve(credentials.agentId);
        if (banks.length === 0) {
          return;
        }
        const query = extractPrompt(event ?? {});
        if (!query) {
          return;
        }
        const client = stack.clients.forAgent(credentials);
        const recalled = await stack.recall.recall(client, {
          query,
          banks,
          timeoutMs: config.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS,
          maxTokens: config.recallMaxTokens ?? DEFAULT_RECALL_MAX_TOKENS,
          budget: config.recallBudget,
          types: config.recallTypes,
          preferObservations: config.preferObservations,
        });
        if (recalled.partial) {
          log.warn(`partial recall: banks unavailable: ${recalled.failedBanks.join(", ")}`);
        }
        const ranked = config.recallTopK ? recalled.results.slice(0, config.recallTopK) : recalled.results;
        if (ranked.length === 0) {
          return;
        }
        const contextMessage = `<hindsight_memories>\n${
          config.recallPromptPreamble || DEFAULT_RECALL_PROMPT_PREAMBLE
        }\nCurrent time - ${formatCurrentTimeForRecall()}\n\n${formatMemories(ranked)}\n</hindsight_memories>`;
        switch (config.recallInjectionPosition ?? "user") {
          case "append":
            return { appendSystemContext: contextMessage };
          case "prepend":
            return { prependSystemContext: contextMessage };
          case "user":
          default:
            return { prependContext: contextMessage };
        }
      } catch (error) {
        if (isIdentityError(error)) {
          log.warn(`auto-recall skipped: ${(error as Error).message}`);
          return;
        }
        if (error instanceof RecallAuthorizationError) {
          log.error(`auto-recall denied: ${error.message}`);
          return;
        }
        log.warn(`auto-recall failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  const runRetain = async (
    event: any,
    ctx: PluginHookAgentContext | undefined,
    hookName: "agent_end" | "session_end"
  ): Promise<void> => {
    if (config.autoRetain === false) {
      return;
    }
    const agentId = ctx?.agentId;
    const sessionKey =
      typeof ctx?.sessionKey === "string"
        ? ctx.sessionKey
        : typeof event?.sessionKey === "string"
          ? event.sessionKey
          : undefined;
    if (sessionKey && matchesSessionPattern(sessionKey, ignorePatterns)) {
      return;
    }
    if (sessionKey && matchesSessionPattern(sessionKey, statelessPatterns)) {
      return;
    }
    if (ctx?.messageProvider && config.excludeProviders?.includes(ctx.messageProvider)) {
      return;
    }
    try {
      const credentials = stack.credentials.resolve(agentId);
      const transcript = extractTranscript(event ?? {});
      if (!transcript) {
        return;
      }
      const sequenceKey = sessionKey ?? "session";
      const sequence = (sessionSequences.get(sequenceKey) ?? 0) + 1;
      sessionSequences.set(sequenceKey, sequence);
      const outcome = await stack.retain.retain(credentials.agentId, {
        content: transcript,
        documentId: `openclaw:${sanitizeDocumentIdPart(sessionKey, "session")}:${sequence}`,
        context: config.retainContext,
        metadata: {
          source: config.retainSource ?? "openclaw",
          agent: credentials.agentId,
          hook: hookName,
        },
        tags: [...(config.retainTags ?? []), "source_system:openclaw", `agent:${credentials.agentId}`],
      });
      if (outcome.queued) {
        log.warn(`retain buffered for agent ${credentials.agentId} (bank: ${outcome.bank})`);
      }
    } catch (error) {
      if (isIdentityError(error)) {
        log.warn(`retain skipped: ${(error as Error).message}`);
        return;
      }
      if (error instanceof RetainAuthorizationError) {
        log.error(`retain denied: ${error.message}`);
        return;
      }
      log.error(`retain failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  api.on("agent_end", (event: any, ctx?: PluginHookAgentContext) => runRetain(event, ctx, "agent_end"));
  api.on("session_end", (event: any, ctx?: PluginHookAgentContext) =>
    runRetain(event, ctx, "session_end")
  );

  let flushTimer: ReturnType<typeof setInterval> | undefined;
  api.registerService({
    id: PLUGIN_ID,
    async start() {
      flushTimer = setInterval(() => {
        void stack.retain.flushQueues().catch((error: unknown) => {
          log.error(`retain queue flush failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, config.retainQueueFlushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
      flushTimer.unref?.();
      await stack.retain.flushQueues();
    },
    async stop() {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }
    },
  });

  if (config.enableKnowledgeTools !== false && typeof api.registerTool === "function") {
    api.registerTool(
      (ctx: PluginToolContext) => {
        let credentials;
        let writeBank: string;
        let recallBanks: string[];
        try {
          credentials = stack.credentials.resolve(ctx.agentId);
          writeBank = stack.writeBanks.resolve(credentials.agentId);
          recallBanks = stack.recallBanks.resolve(credentials.agentId);
        } catch (error) {
          if (isIdentityError(error)) {
            log.warn(`knowledge tools disabled: ${(error as Error).message}`);
            return null; // fail closed: no tools for unknown agents
          }
          throw error;
        }
        const tools = createKnowledgeTools({
          apiUrl: validateRouterUrlForTools(config.routerUrl),
          apiToken: credentials.token,
          bankId: writeBank,
        });
        return tools.map((tool) => {
          if (tool.name !== "agent_knowledge_recall") {
            return {
              name: tool.name,
              label: tool.label,
              description: tool.description,
              parameters: tool.parameters,
              async execute(_id: string, params: Record<string, unknown>) {
                return { ...(await tool.execute(params)), details: {} };
              },
            };
          }
          // Recall tool routes through the multi-bank coordinator: same
          // identity, same recall banks, same shared budget and timeout.
          return {
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            async execute(_id: string, params: Record<string, unknown>) {
              const query = typeof params.query === "string" ? params.query : "";
              const client = stack.clients.forAgent(credentials);
              const recalled = await stack.recall.recall(client, {
                query,
                banks: recallBanks,
                timeoutMs: config.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS,
                maxTokens: config.recallMaxTokens ?? DEFAULT_RECALL_MAX_TOKENS,
                budget: config.recallBudget,
                types: config.recallTypes,
                preferObservations: config.preferObservations,
              });
              if (recalled.partial) {
                log.warn(`partial recall: banks unavailable: ${recalled.failedBanks.join(", ")}`);
              }
              return {
                content: [
                  {
                    type: "text",
                    text: formatMemories(recalled.results) || "No memories found.",
                  },
                ],
                details: {},
              };
            },
          };
        });
      },
      { names: [...TOOL_NAMES], optional: false }
    );
    log.info("knowledge tools registered");
  }
}

function validateRouterUrlForTools(value: unknown): string {
  // The stack constructor already validated this; the closure needs the plain
  // string for the SDK tools.
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("routerUrl is required for knowledge tools");
  }
  return value;
}

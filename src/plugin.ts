import { routedKnowledgeTools } from "./shared/knowledge-tools.js";
import { RouterTransport } from "./shared/router-transport.js";
/** Plugin composition root. Identity comes only from trusted `ctx.agentId`. */

import { TOOL_NAMES } from "@vectorize-io/hindsight-agent-sdk";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

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
  PrincipalCredentialResolver,
  CredentialResolutionError,
  UnknownPrincipalError,
  type RouterPluginConfig,
} from "./shared/principal-credential-resolver.js";
import { AuthenticatedClientFactory } from "./shared/authenticated-client-factory.js";
import { ReadBankResolver } from "./shared/read-bank-resolver.js";
import { WriteBankResolver } from "./shared/write-bank-resolver.js";
import {
  RecallAuthorizationError,
  RecallCoordinator,
  type RecallItem,
} from "./shared/recall-coordinator.js";
import {
  RetainAuthorizationError,
  RetainCoordinator,
} from "./shared/retain-coordinator.js";

export const PLUGIN_ID = "hindsight-memory-router";
export const PLUGIN_VERSION = "0.11.1-router.2";

const DEFAULT_RECALL_TIMEOUT_MS = 5000;
const DEFAULT_RECALL_MAX_TOKENS = 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 30000;
const DEFAULT_RECALL_PROMPT_PREAMBLE =
  "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:";
const DEFAULT_RETAIN_CONTEXT =
  "OpenClaw conversation transcript. User messages are human input; assistant messages are AI output. Routing IDs and tags are metadata, not people or organizations.";
const PROCESS_ID = randomUUID();

interface RuntimePluginConfig extends RouterPluginConfig {
  agents?: Record<string, import("./shared/principal-credential-resolver.js").PrincipalConfig>;
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
  credentials: PrincipalCredentialResolver;
  clients: AuthenticatedClientFactory;
  recallBanks: ReadBankResolver;
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
        messageText((message as { content?: unknown }).content) !== null
      );
    });
    if (typeof last === "string") {
      return last.trim();
    }
    if (last && typeof last === "object") {
      const content = messageText((last as { content?: unknown }).content) ?? "";
      if (content.trim().length >= 5) {
        return content.trim();
      }
    }
  }
  return null;
}

function messageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => (block as { text?: unknown }).text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return text || null;
}

function stripInjectedMemories(content: string): string {
  return content.replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/gi, "").trim();
}

function extractTranscript(event: {
  messages?: unknown;
  context?: { sessionEntry?: { messages?: Array<{ role?: unknown; content?: unknown }> } };
}): string | null {
  const messages = Array.isArray(event.context?.sessionEntry?.messages)
    ? event.context.sessionEntry.messages
    : Array.isArray(event.messages)
      ? event.messages
      : [];
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return null;
  const normalized = messages
    .slice(lastUser)
    .flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const role = (message as { role?: unknown }).role;
      if (role !== "user" && role !== "assistant") return [];
      const content = messageText((message as { content?: unknown }).content);
      if (!content) return [];
      const clean = stripInjectedMemories(content);
      return clean ? [{ role, content: clean }] : [];
    });
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
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
  return error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError;
}

export function buildRoutingStack(config: RuntimePluginConfig, logger: {
  warn(msg: string): void;
  error(msg: string): void;
}): RoutingStack {
  const credentials = new PrincipalCredentialResolver({ ...config, principals: config.agents });
  credentials.validateConfiguredPrincipals();
  const clients = new AuthenticatedClientFactory({
    routerUrl: config.routerUrl,
    userAgent: `hindsight-memory-router-openclaw/${PLUGIN_VERSION}`,
  });
  const recallBanks = new ReadBankResolver(credentials);
  const writeBanks = new WriteBankResolver(credentials);
  const retain = new RetainCoordinator({
    credentials,
    writeBanks,
    clients,
    queueDir: config.queueDir ?? join(homedir(), ".openclaw", "data", "hindsight-retain-queue"),
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
    log.error(`plugin disabled: ${error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError ? error.message : "memory operation failed"}`);
    throw error;
  }
  registerWithStack(api, stack);
}

/** Registration, separated from stack construction for tests. */
export function registerWithStack(api: MoltbotPluginAPI, stack: RoutingStack): void {
  registerRecallHook(api, stack);
  registerRetainHooks(api, stack);
  registerKnowledgeTools(api, stack);
}

function registerRecallHook(api: MoltbotPluginAPI, stack: RoutingStack): void {
  const log = api.logger;
  const config = stack.config;
  api.on(
    "before_prompt_build",
    async (event: any, ctx?: PluginHookAgentContext): Promise<PluginPromptHookResult | void> => {
      if (config.autoRecall === false) {
        return;
      }
      const agentId = ctx?.agentId;
      try {
        const credentials = stack.credentials.resolve(agentId);
        const banks = stack.recallBanks.resolve(credentials.principalId);
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
        log.warn(`auto-recall failed: ${error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError ? error.message : "memory operation failed"}`);
      }
    }
  );
}

function registerRetainHooks(api: MoltbotPluginAPI, stack: RoutingStack): void {
  const log = api.logger;
  const config = stack.config;
  const ignorePatterns = compileSessionPatterns(config.ignoreSessionPatterns ?? []);
  const statelessPatterns = compileSessionPatterns(config.statelessSessionPatterns ?? []);
  const sessionSequences = new Map<string, number>();
  const retainedDigests = new Map<string, string>();

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
    let sequenceKey: string | undefined;
    try {
      const credentials = stack.credentials.resolve(agentId);
      if (stack.credentials.resolveOptionalWriteBank(credentials.principalId) === null) {
        return;
      }
      const transcript = extractTranscript(event ?? {});
      if (!transcript) {
        return;
      }
      sequenceKey = `${credentials.principalId}:${sessionKey ?? "session"}`;
      const digest = createHash("sha256").update(transcript).digest("hex");
      if (retainedDigests.get(sequenceKey) === digest) {
        return;
      }
      const sequence = (sessionSequences.get(sequenceKey) ?? 0) + 1;
      sessionSequences.set(sequenceKey, sequence);
      const outcome = await stack.retain.retain(credentials.principalId, {
        content: transcript,
        documentId: `openclaw:${sanitizeDocumentIdPart(sessionKey, "session")}:${PROCESS_ID}:${sequence}`,
        context: config.retainContext ?? DEFAULT_RETAIN_CONTEXT,
        metadata: {
          source: config.retainSource ?? "openclaw",
          agent: credentials.principalId,
          hook: hookName,
        },
        tags: [...(config.retainTags ?? []), "source_system:openclaw", `agent:${credentials.principalId}`],
      });
      retainedDigests.set(sequenceKey, digest);
      if (outcome.queued) {
        log.warn(`retain buffered for agent ${credentials.principalId} (bank: ${outcome.bank})`);
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
      log.error(`retain failed: ${error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError ? error.message : "memory operation failed"}`);
    } finally {
      if (hookName === "session_end" && sequenceKey) {
        sessionSequences.delete(sequenceKey);
        retainedDigests.delete(sequenceKey);
      }
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
          log.error(`retain queue flush failed: ${error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError ? error.message : "memory operation failed"}`);
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
}

function registerKnowledgeTools(api: MoltbotPluginAPI, stack: RoutingStack): void {
  const log = api.logger;
  const config = stack.config;
  if (config.enableKnowledgeTools === true && typeof api.registerTool === "function") {
    api.registerTool(
      (ctx: PluginToolContext) => {
        let credentials;
        let writeBank: string | null;
        let recallBanks: string[];
        try {
          credentials = stack.credentials.resolve(ctx.agentId);
          writeBank = stack.credentials.resolveOptionalWriteBank(credentials.principalId);
          recallBanks = stack.recallBanks.resolve(credentials.principalId);
          if (writeBank === null && recallBanks.length === 0) {
            return null;
          }
        } catch (error) {
          if (isIdentityError(error)) {
            log.warn(`knowledge tools disabled: ${(error as Error).message}`);
            return null; // fail closed: no tools for unknown agents
          }
          throw error;
        }
        const tools = routedKnowledgeTools(new RouterTransport({
          routerUrl: validateRouterUrlForTools(config.routerUrl),
          token: () => credentials.token,
          access: { writeBank: writeBank ?? undefined, additionalReadBanks: recallBanks },
        }));
        return tools.filter((tool) => {
          if (["agent_knowledge_recall", "agent_knowledge_list_pages", "agent_knowledge_get_page"].includes(tool.name)) return recallBanks.length > 0;
          return writeBank !== null;
        }).map((tool) => {
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

import { routedKnowledgeTools } from "./shared/knowledge-tools.js";

/** Plugin composition root. Identity comes only from trusted `ctx.agentId`. */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOL_NAMES } from "@vectorize-io/hindsight-agent-sdk";
import {
  formatMemoryOperationAudit,
  type MemoryAuditLogger,
  memoryOperationErrorClass,
  safeAuditLogger,
} from "./shared/audit.js";
import { AuthenticatedClientFactory } from "./shared/authenticated-client-factory.js";
import { PACKAGE_VERSION } from "./shared/package-version.js";
import {
  CredentialResolutionError,
  PrincipalCredentialResolver,
  type RouterPluginConfig,
  UnknownPrincipalError,
} from "./shared/principal-credential-resolver.js";
import { RecallAuthorizationError, RecallCoordinator, type RecallItem } from "./shared/recall-coordinator.js";
import { formatRecallItem } from "./shared/recall-item.js";
import {
  RetainAuthorizationError,
  RetainCoordinator,
  RetainQueueBusyError,
  RetainQueueCapacityError,
} from "./shared/retain-coordinator.js";
import { DEFAULT_QUEUE_MAX_BYTES, DEFAULT_QUEUE_MAX_ITEMS } from "./shared/retain-queue-storage.js";
import { compileSessionPatterns, matchesSessionPattern } from "./upstream/src/session-patterns.js";
import type {
  MoltbotPluginAPI,
  PluginHookAgentContext,
  PluginHookEvent,
  PluginPromptHookResult,
  PluginToolContext,
} from "./upstream/src/types.js";

export const PLUGIN_ID = "hindsight-memory-router";
export const PLUGIN_VERSION = PACKAGE_VERSION;

export const RUNTIME_DEFAULTS = Object.freeze({
  autoRecall: true,
  autoRetain: true,
  recallTimeoutMs: 5000,
  recallMaxTokens: 1024,
  recallInjectionPosition: "user" as const,
  retainSource: "openclaw",
  enableKnowledgeTools: false,
  retainQueueFlushIntervalMs: 30000,
  retainQueueMaxAgeMs: -1,
  retainQueueMaxItems: DEFAULT_QUEUE_MAX_ITEMS,
  retainQueueMaxBytes: DEFAULT_QUEUE_MAX_BYTES,
});
const MAX_SESSION_STATE_ENTRIES = 1000;
const DEFAULT_RECALL_PROMPT_PREAMBLE =
  "Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:";
const DEFAULT_RETAIN_CONTEXT =
  "OpenClaw conversation transcript. User messages are human input; assistant messages are AI output. Routing IDs and tags are metadata, not people or organizations.";

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
  retainQueueMaxItems?: number;
  retainQueueMaxBytes?: number;
  ignoreSessionPatterns?: string[];
  statelessSessionPatterns?: string[];
  excludeProviders?: string[];
}

export interface RoutingStack {
  config: RuntimePluginConfig;
  credentials: PrincipalCredentialResolver;
  clients: AuthenticatedClientFactory;
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
  return results.map(formatRecallItem).join("\n\n");
}

function extractPrompt(event: { prompt?: unknown; messages?: unknown; rawMessage?: unknown }): string | null {
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
  return content.replaceAll(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/gi, "").trim();
}

function extractTranscript(event: {
  messages?: unknown;
  context?: {
    sessionEntry?: { messages?: Array<{ role?: unknown; content?: unknown }> };
  };
}): string | null {
  let messages: unknown[] = [];
  if (Array.isArray(event.context?.sessionEntry?.messages)) {
    messages = event.context.sessionEntry.messages;
  } else if (Array.isArray(event.messages)) {
    messages = event.messages;
  }
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return null;
  const normalized = messages.slice(lastUser).flatMap((message) => {
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

function isIdentityError(error: unknown): boolean {
  return error instanceof UnknownPrincipalError || error instanceof CredentialResolutionError;
}

function memoryErrorMessage(error: unknown): string {
  return isIdentityError(error) || error instanceof RetainQueueCapacityError || error instanceof RetainQueueBusyError
    ? (error as Error).message
    : "memory operation failed";
}

function auditLogger(log: { info(msg: string): void }): MemoryAuditLogger {
  return safeAuditLogger((event) => log.info(formatMemoryOperationAudit(event)));
}

function sessionKeyFor(event: PluginHookEvent, ctx: PluginHookAgentContext | undefined): string | undefined {
  if (typeof ctx?.sessionKey === "string") {
    return ctx.sessionKey;
  }
  return typeof event.sessionKey === "string" ? event.sessionKey : undefined;
}

function shouldSkipRetain(
  sessionKey: string | undefined,
  ctx: PluginHookAgentContext | undefined,
  config: RuntimePluginConfig,
  ignorePatterns: RegExp[],
  statelessPatterns: RegExp[],
): boolean {
  const ignoredSession = sessionKey !== undefined && matchesSessionPattern(sessionKey, ignorePatterns);
  const statelessSession = sessionKey !== undefined && matchesSessionPattern(sessionKey, statelessPatterns);
  const excludedProvider =
    ctx?.messageProvider !== undefined && config.excludeProviders?.includes(ctx.messageProvider) === true;
  return (
    (config.autoRetain ?? RUNTIME_DEFAULTS.autoRetain) === false ||
    ignoredSession ||
    statelessSession ||
    excludedProvider
  );
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_SESSION_STATE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function buildRoutingStack(
  config: RuntimePluginConfig,
  logger: {
    warn(msg: string): void;
    error(msg: string): void;
  },
): RoutingStack {
  if (config.agents && config.principals) {
    throw new TypeError("configure agents or principals, not both");
  }
  for (const [name, value] of [
    ["recallTimeoutMs", config.recallTimeoutMs],
    ["recallMaxTokens", config.recallMaxTokens],
    ["recallTopK", config.recallTopK],
    ["retainQueueFlushIntervalMs", config.retainQueueFlushIntervalMs],
    ["retainQueueMaxItems", config.retainQueueMaxItems],
    ["retainQueueMaxBytes", config.retainQueueMaxBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (
    config.retainQueueMaxAgeMs !== undefined &&
    (config.retainQueueMaxAgeMs < -1 || !Number.isSafeInteger(config.retainQueueMaxAgeMs))
  ) {
    throw new RangeError("retainQueueMaxAgeMs must be -1 or a non-negative integer");
  }
  const credentials = new PrincipalCredentialResolver({
    ...config,
    principals: config.agents ?? config.principals,
  });
  credentials.validateConfiguredPrincipals();
  const clients = new AuthenticatedClientFactory({
    routerUrl: config.routerUrl,
    userAgent: `hindsight-memory-router-openclaw/${PLUGIN_VERSION}`,
  });
  const retain = new RetainCoordinator({
    credentials,
    clients,
    queueDir: config.queueDir ?? join(homedir(), ".openclaw", "data", "hindsight-retain-queue"),
    queueMaxAgeMs: config.retainQueueMaxAgeMs ?? RUNTIME_DEFAULTS.retainQueueMaxAgeMs,
    queueMaxItems: config.retainQueueMaxItems,
    queueMaxBytes: config.retainQueueMaxBytes,
    logger,
  });
  return {
    config,
    credentials,
    clients,
    recall: new RecallCoordinator(),
    retain,
  };
}

export default function hindsightMemoryRouterPlugin(api: MoltbotPluginAPI): void {
  const log = api.logger;
  const config = getPluginConfig(api);
  let stack: RoutingStack;
  try {
    stack = buildRoutingStack(config, log);
  } catch (error) {
    // Invalid routerUrl etc.: fail closed at load time, never partially armed.
    log.error(`plugin disabled: ${memoryErrorMessage(error)}`);
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
  const audit = auditLogger(log);
  const config = stack.config;
  api.on(
    "before_prompt_build",
    async (event: PluginHookEvent, ctx?: PluginHookAgentContext): Promise<PluginPromptHookResult | undefined> => {
      if ((config.autoRecall ?? RUNTIME_DEFAULTS.autoRecall) === false) {
        return;
      }
      const agentId = ctx?.agentId;
      let principal = agentId ?? "unknown";
      try {
        const credentials = stack.credentials.resolve(agentId);
        principal = credentials.principalId;
        const banks = stack.credentials.resolveReadBanks(credentials.principalId);
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
          timeoutMs: config.recallTimeoutMs ?? RUNTIME_DEFAULTS.recallTimeoutMs,
          maxTokens: config.recallMaxTokens ?? RUNTIME_DEFAULTS.recallMaxTokens,
          budget: config.recallBudget,
          types: config.recallTypes,
          preferObservations: config.preferObservations,
        });
        audit({ principal, op: "recall", outcome: "success", bankId: banks.join(",") });
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
        switch (config.recallInjectionPosition ?? RUNTIME_DEFAULTS.recallInjectionPosition) {
          case "append":
            return { appendSystemContext: contextMessage };
          case "prepend":
            return { prependSystemContext: contextMessage };
          default:
            return { prependContext: contextMessage };
        }
      } catch (error) {
        audit({ principal, op: "recall", outcome: "failure", errorClass: memoryOperationErrorClass(error) });
        if (isIdentityError(error)) {
          log.warn(`auto-recall skipped: ${(error as Error).message}`);
          return;
        }
        if (error instanceof RecallAuthorizationError) {
          log.error(`auto-recall denied: ${error.message}`);
          return;
        }
        log.warn(`auto-recall failed: ${memoryErrorMessage(error)}`);
      }
    },
  );
}

function registerRetainHooks(api: MoltbotPluginAPI, stack: RoutingStack): void {
  const log = api.logger;
  const audit = auditLogger(log);
  const config = stack.config;
  const ignorePatterns = compileSessionPatterns(config.ignoreSessionPatterns ?? []);
  const statelessPatterns = compileSessionPatterns(config.statelessSessionPatterns ?? []);
  const retainedDigests = new Map<string, string>();

  const runRetain = async (
    event: PluginHookEvent,
    ctx: PluginHookAgentContext | undefined,
    hookName: "agent_end" | "session_end",
  ): Promise<void> => {
    const agentId = ctx?.agentId;
    const sessionKey = sessionKeyFor(event, ctx);
    if (shouldSkipRetain(sessionKey, ctx, config, ignorePatterns, statelessPatterns)) {
      return;
    }
    let digestKey: string | undefined;
    let principal = agentId ?? "unknown";
    try {
      const credentials = stack.credentials.resolve(agentId);
      principal = credentials.principalId;
      if (stack.credentials.resolveOptionalWriteBank(credentials.principalId) === null) {
        return;
      }
      const transcript = extractTranscript(event ?? {});
      if (!transcript) {
        return;
      }
      digestKey = JSON.stringify([credentials.principalId, sessionKey ?? null]);
      const digest = createHash("sha256").update(transcript).digest("hex");
      if (retainedDigests.get(digestKey) === digest) {
        return;
      }
      const scopeId = createHash("sha256").update(digestKey).digest("hex");
      const outcome = await stack.retain.retain(credentials.principalId, {
        content: transcript,
        documentId: `openclaw:${scopeId}:${randomUUID()}`,
        context: config.retainContext ?? DEFAULT_RETAIN_CONTEXT,
        metadata: {
          source: config.retainSource ?? RUNTIME_DEFAULTS.retainSource,
          agent: credentials.principalId,
          hook: hookName,
        },
        tags: [...(config.retainTags ?? []), "source_system:openclaw", `agent:${credentials.principalId}`],
      });
      setBounded(retainedDigests, digestKey, digest);
      audit({ principal, op: "retain", outcome: "success", bankId: outcome.bank });
      if (outcome.queued) {
        log.warn(`retain buffered for agent ${credentials.principalId} (bank: ${outcome.bank})`);
      }
    } catch (error) {
      audit({ principal, op: "retain", outcome: "failure", errorClass: memoryOperationErrorClass(error) });
      if (isIdentityError(error)) {
        log.warn(`retain skipped: ${(error as Error).message}`);
        return;
      }
      if (error instanceof RetainAuthorizationError) {
        log.error(`retain denied: ${error.message}`);
        return;
      }
      log.error(`retain failed: ${memoryErrorMessage(error)}`);
    } finally {
      if (hookName === "session_end" && digestKey) {
        retainedDigests.delete(digestKey);
      }
    }
  };

  api.on("agent_end", (event, ctx) => runRetain(event, ctx, "agent_end"));
  api.on("session_end", (event, ctx) => runRetain(event, ctx, "session_end"));

  let flushTimer: ReturnType<typeof setInterval> | undefined;
  api.registerService({
    id: PLUGIN_ID,
    async start() {
      flushTimer = setInterval(() => {
        void stack.retain.flushQueues().catch((error: unknown) => {
          log.error(`retain queue flush failed: ${memoryErrorMessage(error)}`);
        });
      }, config.retainQueueFlushIntervalMs ?? RUNTIME_DEFAULTS.retainQueueFlushIntervalMs);
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

type RoutedKnowledgeTool = ReturnType<typeof routedKnowledgeTools>[number];

interface KnowledgeRoute {
  credentials: ReturnType<PrincipalCredentialResolver["resolve"]>;
  writeBank: string | null;
  recallBanks: string[];
}

const SUPPORTED_KNOWLEDGE_TOOLS: readonly string[] = TOOL_NAMES.filter((name) => name !== "agent_knowledge_reflect");

const READ_KNOWLEDGE_TOOLS = new Set([
  "agent_knowledge_recall",
  "agent_knowledge_list_pages",
  "agent_knowledge_get_page",
]);

function resolveKnowledgeRoute(
  stack: RoutingStack,
  log: { warn(msg: string): void },
  ctx: PluginToolContext,
): KnowledgeRoute | null {
  try {
    const credentials = stack.credentials.resolve(ctx.agentId);
    const writeBank = stack.credentials.resolveOptionalWriteBank(credentials.principalId);
    const recallBanks = stack.credentials.resolveReadBanks(credentials.principalId);
    if (writeBank === null && recallBanks.length === 0) {
      return null;
    }
    return { credentials, writeBank, recallBanks };
  } catch (error) {
    if (isIdentityError(error)) {
      log.warn(`knowledge tools disabled: ${(error as Error).message}`);
      return null; // fail closed: no tools for unknown agents
    }
    throw error;
  }
}

function knowledgeBankTool(tool: RoutedKnowledgeTool, route: KnowledgeRoute, audit: MemoryAuditLogger) {
  const bankIdFor = (params: Record<string, unknown>) =>
    typeof params.bankId === "string" ? params.bankId : (route.writeBank ?? undefined);
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const result = { ...(await tool.execute(params)), details: {} };
        audit({
          principal: route.credentials.principalId,
          op: tool.name,
          outcome: "success",
          bankId: bankIdFor(params),
        });
        return result;
      } catch (error) {
        audit({
          principal: route.credentials.principalId,
          op: tool.name,
          outcome: "failure",
          bankId: bankIdFor(params),
          errorClass: memoryOperationErrorClass(error),
        });
        throw error;
      }
    },
  };
}

function requestedRecallOptions(params: Record<string, unknown>, config: RuntimePluginConfig) {
  if (typeof params.query !== "string" || params.query.trim() === "") {
    throw new TypeError("query must be a non-empty string");
  }
  if (
    params.max_tokens !== undefined &&
    (typeof params.max_tokens !== "number" || !Number.isSafeInteger(params.max_tokens) || params.max_tokens <= 0)
  ) {
    throw new RangeError("max_tokens must be a positive integer");
  }
  const requestedTypes = params.fact_types ?? params.types;
  if (
    requestedTypes !== undefined &&
    (!Array.isArray(requestedTypes) ||
      requestedTypes.length === 0 ||
      requestedTypes.some((type) => typeof type !== "string" || !["world", "experience", "observation"].includes(type)))
  ) {
    throw new TypeError("fact_types must contain supported memory types");
  }
  const types =
    requestedTypes && config.recallTypes
      ? (requestedTypes as string[]).filter((type) => config.recallTypes?.includes(type))
      : ((requestedTypes as string[] | undefined) ?? config.recallTypes);
  if (types?.length === 0) throw new RangeError("fact_types must overlap configured recall types");
  return {
    query: params.query,
    maxTokens: Math.min(
      params.max_tokens ?? Number.POSITIVE_INFINITY,
      config.recallMaxTokens ?? RUNTIME_DEFAULTS.recallMaxTokens,
    ),
    types,
  };
}

// The recall tool routes through the multi-bank coordinator: same
// identity, same recall banks, same shared budget and timeout.
function knowledgeRecallTool(
  tool: RoutedKnowledgeTool,
  stack: RoutingStack,
  route: KnowledgeRoute,
  log: { warn(msg: string): void },
  audit: MemoryAuditLogger,
) {
  const config = stack.config;
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: {
      ...tool.parameters,
      properties: {
        ...(tool.parameters.properties as Record<string, unknown>),
        max_tokens: {
          type: "integer",
          minimum: 1,
          maximum: config.recallMaxTokens ?? RUNTIME_DEFAULTS.recallMaxTokens,
          description: "Shared recall token budget, capped by the configured maximum.",
        },
        fact_types: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["world", "experience", "observation"] },
          description: "Recall types within the configured filter; omitted uses the configured filter.",
        },
      },
    },
    async execute(_id: string, params: Record<string, unknown>) {
      const client = stack.clients.forAgent(route.credentials);
      try {
        const request = requestedRecallOptions(params, config);
        const recalled = await stack.recall.recall(client, {
          ...request,
          banks: route.recallBanks,
          timeoutMs: config.recallTimeoutMs ?? RUNTIME_DEFAULTS.recallTimeoutMs,
          budget: config.recallBudget,
          preferObservations: config.preferObservations,
        });
        audit({
          principal: route.credentials.principalId,
          op: tool.name,
          outcome: "success",
          bankId: route.recallBanks.join(","),
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
      } catch (error) {
        audit({
          principal: route.credentials.principalId,
          op: tool.name,
          outcome: "failure",
          bankId: route.recallBanks.join(","),
          errorClass: memoryOperationErrorClass(error),
        });
        throw error;
      }
    },
  };
}

function knowledgeToolsForContext(
  stack: RoutingStack,
  log: { warn(msg: string): void },
  audit: MemoryAuditLogger,
  ctx: PluginToolContext,
) {
  const route = resolveKnowledgeRoute(stack, log, ctx);
  if (route === null) {
    return null;
  }
  return routedKnowledgeTools(stack.clients.transportFor(route.credentials))
    .filter((tool) => SUPPORTED_KNOWLEDGE_TOOLS.includes(tool.name))
    .filter((tool) => (READ_KNOWLEDGE_TOOLS.has(tool.name) ? route.recallBanks.length > 0 : route.writeBank !== null))
    .map((tool) =>
      tool.name === "agent_knowledge_recall"
        ? knowledgeRecallTool(tool, stack, route, log, audit)
        : knowledgeBankTool(tool, route, audit),
    );
}

function registerKnowledgeTools(api: MoltbotPluginAPI, stack: RoutingStack): void {
  const log = api.logger;
  const config = stack.config;
  const enabled = (config.enableKnowledgeTools ?? RUNTIME_DEFAULTS.enableKnowledgeTools) === true;
  if (!enabled || typeof api.registerTool !== "function") {
    return;
  }
  const audit = auditLogger(log);
  api.registerTool((ctx: PluginToolContext) => knowledgeToolsForContext(stack, log, audit, ctx), {
    names: [...SUPPORTED_KNOWLEDGE_TOOLS],
    optional: false,
  });
  log.info("knowledge tools registered");
}

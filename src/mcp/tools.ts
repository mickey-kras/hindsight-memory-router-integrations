import { AccessDeniedError } from "../shared/bank-access.js";
import { routedKnowledgeTools } from "../shared/knowledge-tools.js";
import { RecallAuthorizationError } from "../shared/recall-coordinator.js";
import { RouterRequestError } from "../shared/router-transport.js";
import { RetainAuthorizationError } from "../shared/retain-coordinator.js";
import type { McpStack } from "./managed-config.js";

export interface ToolResult {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolSafetyAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolSafetyAnnotations;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

const READ_ONLY: ToolSafetyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const NON_DESTRUCTIVE_WRITE: ToolSafetyAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const DESTRUCTIVE_DELETE: ToolSafetyAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const KNOWLEDGE_TOOL_ANNOTATIONS: Record<string, ToolSafetyAnnotations> = {
  agent_knowledge_list_pages: READ_ONLY,
  agent_knowledge_get_page: READ_ONLY,
  agent_knowledge_create_page: NON_DESTRUCTIVE_WRITE,
  agent_knowledge_update_page: NON_DESTRUCTIVE_WRITE,
  agent_knowledge_delete_page: DESTRUCTIVE_DELETE,
  agent_knowledge_ingest: NON_DESTRUCTIVE_WRITE,
};

const WRITE_KNOWLEDGE_TOOLS = new Set([
  "agent_knowledge_create_page",
  "agent_knowledge_update_page",
  "agent_knowledge_delete_page",
  "agent_knowledge_ingest",
]);

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function rejected(reason: string): ToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}

function boundedError(error: unknown): ToolResult {
  if (
    error instanceof AccessDeniedError ||
    error instanceof RecallAuthorizationError ||
    error instanceof RetainAuthorizationError
  ) {
    return rejected("memory access denied");
  }
  if (error instanceof RouterRequestError) {
    return rejected(`memory request failed (${error.statusCode})`);
  }
  return rejected("memory operation failed");
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringListArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name} must be a non-empty string array`);
  if (value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${name} must be a non-empty string array`);
  }
  return value as string[];
}

function positiveIntArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function retainTool(stack: McpStack): McpTool {
  return {
    name: "memory_router_retain",
    description:
      "Retain a memory through Memory Router into this principal's assigned write bank. " +
      "Mutations are restricted to that bank; transient router failures are queued for later delivery.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content to retain." },
        documentId: { type: "string", description: "Stable document id; re-retains update the same document." },
        context: { type: "string", description: "Provenance context stored alongside the memory." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: NON_DESTRUCTIVE_WRITE,
    async handler(args) {
      try {
        const content = stringArg(args, "content");
        if (!content) return rejected("content is required");
        let tags: string[] | undefined;
        try {
          tags = stringListArg(args, "tags");
        } catch {
          return rejected("tags must be a non-empty string array");
        }
        const outcome = await stack.retain.retain(stack.principalId, {
          content,
          documentId: stringArg(args, "documentId"),
          context: stringArg(args, "context"),
          tags,
          metadata: { agent: stack.principalId, ...(stack.source ? { source: stack.source } : {}) },
        });
        return ok({ retained: true, queued: outcome.queued });
      } catch (error) {
        return boundedError(error);
      }
    },
  };
}

function recallTool(stack: McpStack): McpTool {
  return {
    name: "memory_router_recall",
    description:
      "Recall memories through Memory Router across this principal's write bank and additional read banks, " +
      "merged under one shared deadline and token budget.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Recall query." },
        maxTokens: { type: "integer", minimum: 1, description: "Shared context token budget across all banks." },
        timeoutMs: { type: "integer", minimum: 1, description: "Shared deadline across all banks (ms)." },
        budget: { type: "string", enum: ["low", "mid", "high"], description: "Router-side recall budget." },
        types: { type: "array", items: { type: "string" }, description: "Restrict to these memory types." },
        preferObservations: { type: "boolean", description: "Prefer observation-type memories." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async handler(args) {
      try {
        const query = stringArg(args, "query");
        if (!query) return rejected("query is required");
        const budget = args.budget;
        if (budget !== undefined && budget !== "low" && budget !== "mid" && budget !== "high") {
          return rejected("budget must be low, mid or high");
        }
        if (args.maxTokens !== undefined && positiveIntArg(args, "maxTokens") === undefined) {
          return rejected("maxTokens must be a positive integer");
        }
        if (args.timeoutMs !== undefined && positiveIntArg(args, "timeoutMs") === undefined) {
          return rejected("timeoutMs must be a positive integer");
        }
        if (args.preferObservations !== undefined && typeof args.preferObservations !== "boolean") {
          return rejected("preferObservations must be a boolean");
        }
        let types: string[] | undefined;
        try {
          types = stringListArg(args, "types");
        } catch {
          return rejected("types must be a non-empty string array");
        }
        const credentials = stack.credentials.resolve(stack.principalId);
        const banks = stack.credentials.resolveReadBanks(stack.principalId);
        const recalled = await stack.recall.recall(stack.clients.forAgent(credentials), {
          query,
          banks,
          timeoutMs: positiveIntArg(args, "timeoutMs") ?? stack.recallTimeoutMs,
          maxTokens: positiveIntArg(args, "maxTokens") ?? stack.recallMaxTokens,
          budget,
          types,
          preferObservations: args.preferObservations as boolean | undefined,
        });
        return ok({ results: recalled.results, partial: recalled.partial });
      } catch (error) {
        return boundedError(error);
      }
    },
  };
}

function knowledgeTools(stack: McpStack): McpTool[] {
  const credentials = stack.credentials.resolve(stack.principalId);
  const writeBank = stack.credentials.resolveOptionalWriteBank(stack.principalId);
  return routedKnowledgeTools(stack.clients.transportFor(credentials))
    .filter((tool) => Object.hasOwn(KNOWLEDGE_TOOL_ANNOTATIONS, tool.name))
    .filter((tool) => !(WRITE_KNOWLEDGE_TOOLS.has(tool.name) && writeBank === null))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      annotations: KNOWLEDGE_TOOL_ANNOTATIONS[tool.name],
      async handler(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          return await tool.execute(args);
        } catch (error) {
          return boundedError(error);
        }
      },
    }));
}

export function buildTools(stack: McpStack): McpTool[] {
  const tools = [recallTool(stack), ...knowledgeTools(stack)];
  if (stack.credentials.resolveOptionalWriteBank(stack.principalId) !== null) {
    tools.unshift(retainTool(stack));
  }
  return tools;
}

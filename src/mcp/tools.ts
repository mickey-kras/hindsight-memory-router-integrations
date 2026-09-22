import { z } from "zod";
import { type MemoryAuditLogger, memoryOperationErrorClass, safeAuditLogger } from "../shared/audit.js";
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

type ToolInputShape = Record<string, z.ZodType>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputShape;
  annotations: ToolSafetyAnnotations;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
  auditInvalidArguments?(): void;
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

function invalidArguments(name: string, error: z.ZodError): ToolResult {
  const detail = error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
  return rejected(`invalid arguments for ${name}: ${detail}`);
}

interface ToolAudit {
  logger: MemoryAuditLogger;
  principal: string;
  bankId?: (args: Record<string, unknown>) => string | undefined;
}

function validated<Schema extends ToolInputShape>(
  name: string,
  inputSchema: Schema,
  audit: ToolAudit,
  run: (args: z.output<z.ZodObject<Schema>>) => Promise<ToolResult>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  const schema = z.object(inputSchema);
  const logger = safeAuditLogger(audit.logger);
  return async (args) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      logger({ principal: audit.principal, op: name, outcome: "failure", errorClass: "invalid_arguments" });
      return invalidArguments(name, parsed.error);
    }
    let bankId: string | undefined;
    try {
      bankId = audit.bankId?.(parsed.data);
      const result = await run(parsed.data as z.output<z.ZodObject<Schema>>);
      logger({ principal: audit.principal, op: name, outcome: "success", bankId });
      return result;
    } catch (error) {
      logger({
        principal: audit.principal,
        op: name,
        outcome: "failure",
        bankId,
        errorClass: memoryOperationErrorClass(error),
      });
      return boundedError(error);
    }
  };
}

const nonBlank = (value: string): boolean => value.trim() !== "";

function requiredString(message: string) {
  return z.string({ error: message }).refine(nonBlank, message);
}

function optionalStringList(message: string) {
  return z
    .array(z.string({ error: message }).refine(nonBlank, message), { error: message })
    .min(1, message)
    .optional();
}

function optionalPositiveInt(message: string) {
  return z.number({ error: message }).int(message).positive(message).optional();
}

function absentWhenBlank(value: string | undefined): string | undefined {
  return value?.trim() === "" ? undefined : value;
}

function retainTool(stack: McpStack): McpTool {
  const inputSchema = {
    content: requiredString("content is required").describe("Memory content to retain."),
    documentId: z.string().optional().describe("Stable document id; re-retains update the same document."),
    context: z.string().optional().describe("Provenance context stored alongside the memory."),
    tags: optionalStringList("tags must be a non-empty string array").describe("Optional tags."),
  };
  const audit: ToolAudit = {
    logger: stack.audit,
    principal: stack.principalId,
    bankId: () => stack.credentials.resolveOptionalWriteBank(stack.principalId) ?? undefined,
  };
  return {
    name: "memory_router_retain",
    description:
      "Retain a memory through Memory Router into this principal's assigned write bank. " +
      "Mutations are restricted to that bank; transient router failures are queued for later delivery.",
    inputSchema,
    annotations: NON_DESTRUCTIVE_WRITE,
    handler: validated("memory_router_retain", inputSchema, audit, async (args) => {
      const outcome = await stack.retain.retain(stack.principalId, {
        content: args.content,
        documentId: absentWhenBlank(args.documentId),
        context: absentWhenBlank(args.context),
        tags: args.tags,
        metadata: { agent: stack.principalId, ...(stack.source ? { source: stack.source } : {}) },
      });
      return ok({ retained: true, queued: outcome.queued });
    }),
  };
}

function recallTool(stack: McpStack): McpTool {
  const inputSchema = {
    query: requiredString("query is required").describe("Recall query."),
    maxTokens: optionalPositiveInt("maxTokens must be a positive integer").describe(
      "Shared context token budget across all banks.",
    ),
    timeoutMs: optionalPositiveInt("timeoutMs must be a positive integer").describe(
      "Shared deadline across all banks (ms).",
    ),
    budget: z
      .enum(["low", "mid", "high"], { error: "budget must be low, mid or high" })
      .optional()
      .describe("Router-side recall budget."),
    types: optionalStringList("types must be a non-empty string array").describe("Restrict to these memory types."),
    preferObservations: z
      .boolean({ error: "preferObservations must be a boolean" })
      .optional()
      .describe("Prefer observation-type memories."),
  };
  return {
    name: "memory_router_recall",
    description:
      "Recall memories through Memory Router across this principal's write bank and additional read banks, " +
      "merged under one shared deadline and token budget.",
    inputSchema,
    annotations: READ_ONLY,
    handler: validated(
      "memory_router_recall",
      inputSchema,
      {
        logger: stack.audit,
        principal: stack.principalId,
        bankId: () => stack.credentials.resolveReadBanks(stack.principalId).join(","),
      },
      async (args) => {
        const credentials = stack.credentials.resolve(stack.principalId);
        const banks = stack.credentials.resolveReadBanks(stack.principalId);
        const recalled = await stack.recall.recall(stack.clients.forAgent(credentials), {
          query: args.query,
          banks,
          timeoutMs: args.timeoutMs ?? stack.recallTimeoutMs,
          maxTokens: args.maxTokens ?? stack.recallMaxTokens,
          budget: args.budget,
          types: args.types,
          preferObservations: args.preferObservations,
        });
        return ok({ results: recalled.results, partial: recalled.partial });
      },
    ),
  };
}

function knowledgeInputSchema(parameters: Record<string, unknown>, banks: string[]): ToolInputShape {
  const properties = (parameters.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
  const required = new Set<unknown>(Array.isArray(parameters.required) ? parameters.required : []);
  const shape: ToolInputShape = {};
  for (const [key, property] of Object.entries(properties)) {
    let schema: z.ZodType;
    if (key === "bankId") {
      schema = z.enum(banks as [string, ...string[]]);
    } else if (property.type === "string") {
      schema = z.string();
    } else {
      throw new TypeError(`unsupported knowledge tool argument type for ${key}`);
    }
    if (typeof property.description === "string") schema = schema.describe(property.description);
    shape[key] = required.has(key) ? schema : schema.optional();
  }
  return shape;
}

function knowledgeTools(stack: McpStack): McpTool[] {
  const credentials = stack.credentials.resolve(stack.principalId);
  const writeBank = stack.credentials.resolveOptionalWriteBank(stack.principalId);
  const banks = stack.credentials.resolveReadBanks(stack.principalId);
  return routedKnowledgeTools(stack.clients.transportFor(credentials))
    .filter((tool) => Object.hasOwn(KNOWLEDGE_TOOL_ANNOTATIONS, tool.name))
    .filter((tool) => !(WRITE_KNOWLEDGE_TOOLS.has(tool.name) && writeBank === null))
    .map((tool) => {
      const inputSchema = knowledgeInputSchema(tool.parameters, banks);
      const audit: ToolAudit = {
        logger: stack.audit,
        principal: stack.principalId,
        bankId: (args) => (typeof args.bankId === "string" ? args.bankId : (writeBank ?? undefined)),
      };
      return {
        name: tool.name,
        description: tool.description,
        inputSchema,
        annotations: KNOWLEDGE_TOOL_ANNOTATIONS[tool.name],
        handler: validated(tool.name, inputSchema, audit, (args) => tool.execute(args)),
      };
    });
}

export function buildTools(stack: McpStack): McpTool[] {
  const tools = [recallTool(stack), ...knowledgeTools(stack)];
  if (stack.credentials.resolveOptionalWriteBank(stack.principalId) !== null) {
    tools.unshift(retainTool(stack));
  }
  const audit = safeAuditLogger(stack.audit);
  return tools.map((tool) => ({
    ...tool,
    auditInvalidArguments: () =>
      audit({
        principal: stack.principalId,
        op: tool.name,
        outcome: "failure",
        errorClass: "invalid_arguments",
      }),
  }));
}

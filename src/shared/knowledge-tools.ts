import { createKnowledgeTools } from "@vectorize-io/hindsight-agent-sdk";
import { AccessDeniedError, requireBank, visibleBanks } from "./bank-access.js";
import type { RouterTransport } from "./router-transport.js";

const DEFAULT_PAGE_MAX_TOKENS = 4096;

interface ToolRequest {
  method: string;
  suffix: string;
  body?: unknown;
}

interface ToolSpec {
  read: boolean;
  request(params: Record<string, unknown>, page: string): ToolRequest;
}

const TOOL_SPECS: Record<string, ToolSpec> = {
  agent_knowledge_list_pages: {
    read: true,
    request: () => ({
      method: "GET",
      suffix: "/mental-models?detail=metadata",
    }),
  },
  agent_knowledge_get_page: {
    read: true,
    request: (_params, page) => ({
      method: "GET",
      suffix: `/mental-models/${page}`,
    }),
  },
  agent_knowledge_create_page: {
    read: false,
    request: (params) => ({
      method: "POST",
      suffix: "/mental-models",
      body: {
        id: params.page_id,
        name: params.name,
        source_query: params.source_query,
        max_tokens: DEFAULT_PAGE_MAX_TOKENS,
        trigger: {
          mode: "delta",
          refresh_after_consolidation: true,
          exclude_mental_models: true,
          fact_types: ["observation"],
        },
      },
    }),
  },
  agent_knowledge_update_page: {
    read: false,
    request: (params, page) => ({
      method: "PATCH",
      suffix: `/mental-models/${page}`,
      body: { name: params.name, source_query: params.source_query },
    }),
  },
  agent_knowledge_delete_page: {
    read: false,
    request: (_params, page) => ({
      method: "DELETE",
      suffix: `/mental-models/${page}`,
    }),
  },
  agent_knowledge_ingest: {
    read: false,
    request: (params) => {
      if (typeof params.title !== "string" || params.title.trim() === "") throw new TypeError("title is required");
      return {
        read: false,
        method: "POST",
        suffix: "/memories",
        body: {
          async: true,
          items: [
            {
              content: params.content,
              document_id: params.title.toLowerCase().replaceAll(" ", "-"),
            },
          ],
        },
      };
    },
  },
};

export function routedKnowledgeTools(transport: RouterTransport) {
  // Reuse upstream descriptions and schemas; all execution uses the guarded transport.
  const definitions = createKnowledgeTools({
    apiUrl: transport.baseUrl,
    bankId: "unused",
  });
  return definitions.map((tool) => ({
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...(tool.parameters.properties as Record<string, unknown>),
        bankId: {
          type: "string",
          enum: visibleBanks(transport.access),
          description: "Explicit assigned bank; required without a write bank.",
        },
      },
    },
    async execute(params: Record<string, unknown>) {
      const spec = TOOL_SPECS[tool.name];
      if (!spec) throw new AccessDeniedError();
      const bank = typeof params.bankId === "string" ? params.bankId : transport.access.writeBank;
      if (!bank) throw new AccessDeniedError();
      requireBank(transport.access, bank, spec.read ? "read" : "write");
      const page = typeof params.page_id === "string" ? encodeURIComponent(params.page_id) : "";
      const request = spec.request(params, page);
      const response = await transport.request(transport.bankUrl(bank, request.suffix), {
        method: request.method,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const data: unknown = request.method === "DELETE" ? { success: true } : await response.json();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  }));
}

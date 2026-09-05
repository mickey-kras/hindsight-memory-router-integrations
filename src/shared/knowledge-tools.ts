import { createKnowledgeTools } from "@vectorize-io/hindsight-agent-sdk";
import { AccessDeniedError, requireBank, visibleBanks } from "./bank-access.js";
import type { RouterTransport } from "./router-transport.js";

export function routedKnowledgeTools(transport: RouterTransport) {
  // Reuse upstream descriptions and schemas; all execution uses the guarded transport.
  const definitions = createKnowledgeTools({ apiUrl: transport.baseUrl, bankId: "unused" });
  return definitions.map(tool => ({ ...tool, parameters: { ...tool.parameters, properties: { ...(tool.parameters.properties as Record<string, unknown>), bankId: { type: "string", enum: visibleBanks(transport.access), description: "Explicit assigned bank; required without a write bank." } } }, async execute(params: Record<string, unknown>) {
    const read = ["agent_knowledge_list_pages", "agent_knowledge_get_page"].includes(tool.name);
    const bank = typeof params.bankId === "string" ? params.bankId : transport.access.writeBank;
    if (!bank) throw new AccessDeniedError();
    requireBank(transport.access, bank, read ? "read" : "write");
    const page = typeof params.page_id === "string" ? encodeURIComponent(params.page_id) : "";
    let suffix = "/mental-models";
    let method = "GET";
    let body: unknown;
    switch (tool.name) {
      case "agent_knowledge_list_pages": suffix += "?detail=metadata"; break;
      case "agent_knowledge_get_page": suffix += `/${page}`; break;
      case "agent_knowledge_create_page":
        method = "POST";
        body = { id: params.page_id, name: params.name, source_query: params.source_query, max_tokens: 4096,
          trigger: { mode: "delta", refresh_after_consolidation: true, exclude_mental_models: true, fact_types: ["observation"] } };
        break;
      case "agent_knowledge_update_page":
        suffix += `/${page}`; method = "PATCH";
        body = { name: params.name, source_query: params.source_query }; break;
      case "agent_knowledge_delete_page": suffix += `/${page}`; method = "DELETE"; break;
      case "agent_knowledge_ingest":
        method = "POST"; suffix = "/memories";
        body = { async: true, items: [{ content: params.content, document_id: String(params.title).toLowerCase().replace(/ /g, "-") }] }; break;
      default: throw new AccessDeniedError();
    }
    const response = await transport.request(transport.bankUrl(bank, suffix), { method, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error("memory operation unavailable");
    const data: unknown = method === "DELETE" ? { success: true } : await response.json();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } }));
}

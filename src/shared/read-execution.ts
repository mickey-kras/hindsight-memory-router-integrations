import { RecallCoordinator, type RecallItem } from "./recall-coordinator.js";
import { RouterTransport } from "./router-transport.js";
import { visibleBanks } from "./bank-access.js";

/** Recall and reflect share deadlines, budgets, failure handling and deterministic merging. */
export async function readAcrossBanks(
  transport: RouterTransport,
  operation: "recall" | "reflect",
  body: Record<string, unknown>,
  options: { timeoutMs: number; maxTokens: number },
) {
  return new RecallCoordinator().recall({
    retain: async () => { throw new Error("read-only execution"); },
    async recall(bank, _query, request) {
      const suffix = operation === "recall" ? "/memories/recall" : "/reflect";
      const response = await transport.request(transport.bankUrl(bank, suffix), {
        method: "POST", signal: request?.signal,
        body: JSON.stringify({ ...body, max_tokens: request?.maxTokens }),
      });
      if (!response.ok) throw new Error("memory read unavailable");
      const data = await response.json() as { text?: string; results?: RecallItem[] };
      return { results: operation === "reflect" ? (data.text ? [{ text: data.text }] : []) : data.results };
    },
  }, {
    banks: visibleBanks(transport.access), query: String(body.query ?? ""),
    timeoutMs: options.timeoutMs, maxTokens: options.maxTokens,
  });
}

import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/shared/bank-access.js";
import { routedKnowledgeTools } from "../src/shared/knowledge-tools.js";
import { RouterTransport } from "../src/shared/router-transport.js";

const TOKEN = `mr_agent-key_${"a".repeat(64)}`;

function makeTransport(): { transport: RouterTransport; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const transport = new RouterTransport({
    routerUrl: "https://router.example.test",
    access: { writeBank: "agent-bank", additionalReadBanks: [] },
    token: () => TOKEN,
    fetch: send as unknown as typeof fetch,
  });
  return { transport, send };
}

describe("routedKnowledgeTools", () => {
  it.each(["agent_knowledge_recall", "agent_knowledge_reflect"])(
    "denies execution of upstream passthrough %s without a guarded spec",
    async (name) => {
      const { transport, send } = makeTransport();
      const tools = routedKnowledgeTools(transport);
      const passthrough = tools.find((candidate) => candidate.name === name);
      if (!passthrough) throw new Error(`${name} missing from upstream definitions`);
      await expect(passthrough.execute({ query: "x" })).rejects.toBeInstanceOf(AccessDeniedError);
      expect(send).not.toHaveBeenCalled();
    },
  );
});

import { afterEach, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RouterTransport } from "../src/shared/router-transport.js";
import { routedKnowledgeTools } from "../src/shared/knowledge-tools.js";
const token = `mr_test_${"a".repeat(64)}`;
const access = { writeBank: "A", additionalReadBanks: ["B"] };
afterEach(() => vi.restoreAllMocks());
it("uses the production shared client for authenticated retain and recall", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ results: [{ text: "memory" }] }));
  const credentials = new PrincipalCredentialResolver({ principals: { test: { token, ...access } } }).resolve("test");
  const client = new AuthenticatedClientFactory({ routerUrl: "https://router.test", userAgent: "test" }).forAgent(credentials);
  await client.retain("A", "content", { documentId: "doc", operationId: "op", async: true });
  expect(await client.recall("B", "query", { maxTokens: 10 })).toEqual({ results: [{ text: "memory" }] });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ items: [{ content: "content", document_id: "doc" }], operation_id: "op" });
  await expect(client.retain("B", "denied")).rejects.toThrow("memory access denied");
  await expect(client.recall("hidden", "denied")).rejects.toThrow("memory access denied");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("routes knowledge reads and mutations through the same bank guard", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "page" }));
  const transport = new RouterTransport({ routerUrl: "https://router.test", access, token: () => token });
  const tools = routedKnowledgeTools(transport);
  for (const action of ["list_pages", "get_page", "create_page", "update_page", "delete_page", "ingest"]) {
    const tool = tools.find(t => t.name === `agent_knowledge_${action}`)!;
    const read = ["list_pages", "get_page"].includes(action);
    await tool.execute({ bankId: read ? "B" : "A", page_id: "page", title: "Doc", content: "body" });
    if (!read) await expect(tool.execute({ bankId: "B" })).rejects.toThrow("memory access denied");
    await expect(tool.execute({ bankId: "hidden" })).rejects.toThrow("memory access denied");
  }
  expect(fetch).toHaveBeenCalledTimes(6);
});

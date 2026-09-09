import { afterEach, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory } from "../src/shared/authenticated-client-factory.js";
import { routedKnowledgeTools } from "../src/shared/knowledge-tools.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RouterTransport } from "../src/shared/router-transport.js";

const token = `mr_test_${"a".repeat(64)}`;
const access = { writeBank: "A", additionalReadBanks: ["B"] };
afterEach(() => vi.restoreAllMocks());
it("uses the production shared client for authenticated retain and recall", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      Response.json({ results: [{ text: "memory" }] }),
    );
  const credentials = new PrincipalCredentialResolver({
    principals: { test: { token, ...access } },
  }).resolve("test");
  const client = new AuthenticatedClientFactory({
    routerUrl: "https://router.test",
    userAgent: "test",
  }).forAgent(credentials);
  await client.retain("A", "content", {
    documentId: "doc",
    operationId: "op",
    async: true,
  });
  expect(await client.recall("B", "query", { maxTokens: 10 })).toEqual({
    results: [{ text: "memory" }],
  });
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    items: [{ content: "content", document_id: "doc" }],
    operation_id: "op",
  });
  await expect(client.retain("B", "denied")).rejects.toThrow(
    "memory access denied",
  );
  await expect(client.recall("hidden", "denied")).rejects.toThrow(
    "memory access denied",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("routes knowledge reads and mutations through the same bank guard", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ id: "page" }));
  const transport = new RouterTransport({
    routerUrl: "https://router.test",
    access,
    token: () => token,
  });
  const tools = routedKnowledgeTools(transport);
  for (const action of [
    "list_pages",
    "get_page",
    "create_page",
    "update_page",
    "delete_page",
    "ingest",
  ]) {
    const tool = tools.find((t) => t.name === `agent_knowledge_${action}`)!;
    const read = ["list_pages", "get_page"].includes(action);
    await tool.execute({
      bankId: read ? "B" : "A",
      page_id: "page",
      title: "Doc",
      content: "body",
    });
    if (!read)
      await expect(tool.execute({ bankId: "B" })).rejects.toThrow(
        "memory access denied",
      );
    await expect(tool.execute({ bankId: "hidden" })).rejects.toThrow(
      "memory access denied",
    );
  }
  expect(fetch).toHaveBeenCalledTimes(6);
  const ingest = tools.find((tool) => tool.name === "agent_knowledge_ingest");
  await expect(ingest?.execute({ bankId: "A", content: "body" })).rejects.toThrow("title is required");
});

it("fails closed when production clients lack access or receive upstream failures", async () => {
  const factory = new AuthenticatedClientFactory({
    routerUrl: "https://router.test",
    userAgent: "test",
  });
  expect(() => factory.forAgent({ principalId: "test", token })).toThrow(
    "memory access denied",
  );

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 503 }),
  );
  const client = factory.forAgent({ principalId: "test", token, access });
  await expect(client.retain("A", "content")).rejects.toThrow(
    "memory request failed (503)",
  );
  await expect(client.recall("B", "query")).rejects.toThrow(
    "memory request failed (503)",
  );
});

it("requires an assigned bank and rejects failed knowledge operations", async () => {
  const readOnly = new RouterTransport({
    routerUrl: "https://router.test",
    access: { additionalReadBanks: ["B"] },
    token: () => token,
  });
  const list = routedKnowledgeTools(readOnly).find(
    (tool) => tool.name === "agent_knowledge_list_pages",
  );
  expect(list).toBeDefined();
  await expect(list?.execute({})).rejects.toThrow("memory access denied");

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 503 }),
  );
  await expect(list?.execute({ bankId: "B" })).rejects.toThrow(
    "memory request failed (503)",
  );

  vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ id: "page" }));
  const get = routedKnowledgeTools(readOnly).find(
    (tool) => tool.name === "agent_knowledge_get_page",
  );
  await expect(get?.execute({ bankId: "B" })).rejects.toThrow(
    "memory access denied",
  );
});

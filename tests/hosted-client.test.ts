import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, HostedRouterClient } from "../src/shared/hosted-client.js";

const token = `mr_hosted_${"a".repeat(64)}`;
const config = {
  routerUrl: "https://alpha.example/router",
  principalId: "hosted",
  token,
  writeBank: "write",
  additionalReadBanks: ["read"],
};
const operations = [
  {
    method: "POST",
    suffix: "/memories",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.retain(b, { items: [{ content: "fact", document_id: "doc" }] }),
  },
  {
    method: "POST",
    suffix: "/memories/recall",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.recall(b, { query: "fact", max_tokens: 100 }),
  },
  {
    method: "POST",
    suffix: "/reflect",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.reflect(b, { query: "fact", budget: "low" }),
  },
  {
    method: "POST",
    suffix: "/memories",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.ingestDocument(b, { content: "fact", document_id: "doc" }),
  },
  {
    method: "GET",
    suffix: "/documents?tags=a&tags=b&limit=2",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.listDocuments(b, { tags: ["a", "b"], limit: 2 }),
  },
  {
    method: "GET",
    suffix: "/documents/doc",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.getDocument(b, "doc"),
  },
  {
    method: "PATCH",
    suffix: "/documents/doc",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.updateDocument(b, "doc", { tags: ["updated"] }),
  },
  {
    method: "DELETE",
    suffix: "/documents/doc",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.deleteDocument(b, "doc"),
  },
  {
    method: "GET",
    suffix: "/documents/doc/chunks?offset=2",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.listDocumentChunks(b, "doc", { offset: 2 }),
  },
  {
    method: "POST",
    suffix: "/documents/doc/reprocess",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.reprocessDocument(b, "doc"),
  },
  {
    method: "GET",
    suffix: "/knowledge-base/tree?tags=tag",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.listKnowledgePages(b, { tags: ["tag"] }),
  },
  {
    method: "GET",
    suffix: "/knowledge-base/search?q=hello+world&limit=2",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.searchKnowledgePages(b, { q: "hello world", limit: 2 }),
  },
  {
    method: "POST",
    suffix: "/knowledge-base/pages",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.createKnowledgePage(b, { title: "page", content: "fact" }),
  },
  {
    method: "GET",
    suffix: "/knowledge-base/pages/page",
    write: false,
    run: (c: HostedRouterClient, b: string) => c.getKnowledgePage(b, "page"),
  },
  {
    method: "PATCH",
    suffix: "/knowledge-base/nodes/node",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.updateKnowledgePage(b, "node", { title: "updated" }),
  },
  {
    method: "DELETE",
    suffix: "/knowledge-base/nodes/node",
    write: true,
    run: (c: HostedRouterClient, b: string) => c.deleteKnowledgePage(b, "node"),
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("hosted router facade contract", () => {
  it.each(operations)("forwards $method $suffix through authenticated transport", async ({ method, suffix, run }) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [], text: "answer", ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await run(new HostedRouterClient(config), "write");
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://alpha.example/router/v1/default/banks/write${suffix}`);
    expect(init.method).toBe(method);
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      Authorization: `Bearer ${token}`,
      "x-memory-router-agent": "hosted",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (method === "POST" && suffix === "/memories") expect(JSON.parse(init.body).items[0].document_id).toBe("doc");
  });
  it.each(operations)("denies unassigned bank on $method $suffix before sending", async ({ run }) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(run(new HostedRouterClient(config), "unassigned")).rejects.toBeInstanceOf(AccessDeniedError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(operations.filter((operation) => operation.write))(
    "denies writes to read-only bank on $method $suffix",
    async ({ run }) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(run(new HostedRouterClient({ ...config, writeBank: undefined }), "read")).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(operations.filter((operation) => !operation.write))(
    "allows reads without a write bank on $method $suffix",
    async ({ run }) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [], text: "answer" }));
      vi.stubGlobal("fetch", fetcher);
      await run(new HostedRouterClient({ ...config, writeBank: undefined }), "read");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  for (const status of [401, 403]) {
    it.each(operations)(`fails closed on router ${status} for $method $suffix`, async ({ run }) => {
      const fetcher = vi.fn().mockResolvedValue(new Response(`secret ${token}`, { status }));
      vi.stubGlobal("fetch", fetcher);
      const client = new HostedRouterClient(config);
      await expect(run(client, "write")).rejects.toThrow("memory access denied");
      await expect(client.getDocument("write", "doc")).rejects.toBeInstanceOf(AccessDeniedError);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  }
  it("keeps deployments, caller mutation, and denial state isolated", async () => {
    const mutable = { ...config, additionalReadBanks: ["read"] };
    const alpha = new HostedRouterClient(mutable);
    const betaToken = `mr_hosted_${"b".repeat(64)}`;
    const beta = new HostedRouterClient({
      routerUrl: "https://beta.example",
      principalId: "hosted",
      token: betaToken,
      writeBank: "beta-write",
      additionalReadBanks: [],
    });
    mutable.token = betaToken;
    mutable.additionalReadBanks.push("beta-write");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await expect(alpha.getDocument("write", "doc")).rejects.toBeInstanceOf(AccessDeniedError);
    await beta.getDocument("beta-write", "doc");
    await expect(alpha.getDocument("beta-write", "doc")).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(beta.getDocument("write", "doc")).rejects.toBeInstanceOf(AccessDeniedError);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://alpha.example/router/v1/default/banks/write/documents/doc",
      "https://beta.example/v1/default/banks/beta-write/documents/doc",
    ]);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${betaToken}`);
  });
  it.each(["src/foo.ts", "coverage100%", "C:\\project", "../src/foo.ts", "bankId=hidden#fragment"])(
    "preserves ordinary hosted search text %s",
    async (q) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ results: [] }));
      vi.stubGlobal("fetch", fetcher);
      await new HostedRouterClient(config).searchKnowledgePages("read", { q });
      expect(fetcher).toHaveBeenCalledOnce();
      const url = new URL(fetcher.mock.calls[0][0]);
      expect(url.pathname).toBe("/router/v1/default/banks/read/knowledge-base/search");
      expect(url.searchParams.get("q")).toBe(q);
    },
  );
  it.each(["bankId", "bank_id", "bank_ids"])("rejects hosted search routing override %s", async (key) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new HostedRouterClient(config).searchKnowledgePages("read", { q: "ordinary", [key]: "hidden" }),
    ).rejects.toThrow(AccessDeniedError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["../hidden", "%2e%2e", "src/other", "C:\\project"])("rejects hosted search bank path %s", async (bank) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(new HostedRouterClient(config).searchKnowledgePages(bank, { q: "ordinary" })).rejects.toThrow(
      AccessDeniedError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects insecure URLs, malformed credentials and traversal", async () => {
    expect(() => new HostedRouterClient({ ...config, routerUrl: "http://alpha.example" })).toThrow();
    expect(() => new HostedRouterClient({ ...config, token: "invalid" })).toThrow();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(() => new HostedRouterClient(config).getDocument("write", "../other")).toThrow(AccessDeniedError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes network, server and malformed response errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(`secret ${token}`)));
    await expect(new HostedRouterClient(config).getDocument("write", "doc")).rejects.toThrow(
      "memory request failed (503)",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`secret ${token}`, { status: 500 })));
    await expect(new HostedRouterClient(config).getDocument("write", "doc")).rejects.toThrow(
      "memory request failed (500)",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`secret ${token}`)));
    await expect(new HostedRouterClient(config).getDocument("write", "doc")).rejects.toThrow(
      "memory request failed (502)",
    );
  });
  it.each(["caller", "deadline"])("honors %s cancellation with a combined deadline signal", async (source) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const fetcher = vi
        .fn()
        .mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) =>
              init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
            ),
        );
      vi.stubGlobal("fetch", fetcher);
      const request = new HostedRouterClient(config).getDocument("write", "doc", { signal: caller.signal });
      const result = expect(request).rejects.toMatchObject({ statusCode: 503 });
      (source === "caller" ? caller : deadline).abort();
      await result;
      expect(timeout).toHaveBeenCalledWith(15_000);
      expect(fetcher.mock.calls[0][1].signal).not.toBe(caller.signal);
    } finally {
      timeout.mockRestore();
    }
  });
  it("rejects invalid typed recall and reflect responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(Response.json({ wrong: true }))),
    );
    await expect(new HostedRouterClient(config).recall("read", { query: "fact" })).rejects.toMatchObject({
      statusCode: 502,
    });
    await expect(new HostedRouterClient(config).reflect("read", { query: "fact" })).rejects.toMatchObject({
      statusCode: 502,
    });
  });
  it("bounds payloads and response bodies, and handles missing/empty resources", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new HostedRouterClient(config).retain("write", { items: [{ content: "x".repeat(1024 * 1024) }] }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(new HostedRouterClient(config).getDocument("write", "doc")).rejects.toMatchObject({ statusCode: 502 });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(new HostedRouterClient(config).getDocument("write", "doc")).rejects.toMatchObject({ statusCode: 404 });
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(new HostedRouterClient(config).deleteDocument("write", "doc")).resolves.toEqual({});
  });
});

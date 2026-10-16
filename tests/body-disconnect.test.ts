import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory, type RouterClient } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver, type RouterPluginConfig } from "../src/shared/principal-credential-resolver.js";
import { RecallCoordinator } from "../src/shared/recall-coordinator.js";
import { RetainCoordinator } from "../src/shared/retain-coordinator.js";
import { isTransientRequestError } from "../src/shared/request-error.js";
import type { QueuedRetain } from "../src/upstream/src/retain-queue.js";

const routerUrl = "https://router.example";
const config: RouterPluginConfig = {
  routerUrl,
  principals: { main: { token: `mr_main_${"a".repeat(64)}`, writeBank: "main", additionalReadBanks: ["healthy"] } },
};

type ResponseMode = "disconnect" | "malformed" | "healthy";

// Only the destination is rewritten; body consumption uses native fetch.
async function loopback(): Promise<{
  operations: string[];
  setMode(value: ResponseMode): void;
  close(): Promise<void>;
}> {
  const pending = new Map<string, ServerResponse>();
  const operations: string[] = [];
  let mode: ResponseMode = "disconnect";
  let nextId = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req as AsyncIterable<Buffer>) body += chunk.toString("utf8");
    const parsed: { operation_id?: unknown } = JSON.parse(body);
    if (typeof parsed.operation_id === "string") operations.push(parsed.operation_id);
    if (req.url?.includes("/banks/healthy/") || mode === "healthy") {
      res.end(JSON.stringify({ results: [{ text: "healthy memory" }] }));
    } else if (mode === "malformed") {
      res.end('{"unfinished":');
    } else {
      const id = String(nextId++);
      pending.set(id, res);
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000", "x-disconnect": id });
      res.write('{"unfinished":');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await realFetch(String(input).replace(routerUrl, origin), init);
    const id = response.headers.get("x-disconnect");
    if (id !== null) {
      pending.get(id)?.socket?.destroy();
      pending.delete(id);
    }
    return response;
  });
  return {
    operations,
    setMode(value: ResponseMode): void {
      mode = value;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function stack(queueDir: string): { client: RouterClient; retain: RetainCoordinator } {
  const credentials = new PrincipalCredentialResolver(config);
  const clients = new AuthenticatedClientFactory({ routerUrl, userAgent: "test/0" });
  return {
    client: clients.forAgent(credentials.resolve("main")),
    retain: new RetainCoordinator({ credentials, clients, queueDir, logger: { warn() {}, error() {} } }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("response body network failures", () => {
  it("queues fresh retain, retries disconnected replay without quarantine, and preserves operation identity", async () => {
    const http = await loopback();
    const queueDir = mkdtempSync(join(tmpdir(), "body-disconnect-"));
    const file = join(queueDir, "hindsight-retain-queue.main.jsonl");
    try {
      await expect(stack(queueDir).retain.retain("main", { content: "pending", documentId: "doc" })).resolves.toEqual({
        queued: true,
        bank: "main",
      });
      const original: QueuedRetain = JSON.parse(readFileSync(file, "utf8"));
      expect(original.operationId).toBe(http.operations[0]);
      await stack(queueDir).retain.flushQueues();
      const retried: QueuedRetain = JSON.parse(readFileSync(file, "utf8"));
      expect(retried.operationId).toBe(original.operationId);
      expect(retried.replayAttempts).toBe(1);
      expect(retried.replayState?.quarantine).toBeUndefined();
      expect(retried.replayState?.sending).toBeUndefined();
      http.setMode("healthy");
      await stack(queueDir).retain.flushQueues();
      expect(existsSync(file)).toBe(false);
      expect(http.operations).toEqual(Array<string | undefined>(3).fill(original.operationId));
    } finally {
      await http.close();
      rmSync(queueDir, { recursive: true, force: true });
    }
  });

  it("keeps healthy recall results when another bank disconnects during JSON consumption", async () => {
    const http = await loopback();
    try {
      const result = await new RecallCoordinator().recall(stack(join(tmpdir(), "body-disconnect-unused")).client, {
        banks: ["main", "healthy"],
        query: "q",
        timeoutMs: 1000,
      });
      expect(result).toEqual({ results: [{ text: "healthy memory" }], partial: true, failedBanks: ["main"] });
    } finally {
      await http.close();
    }
  });

  it("does not turn a complete malformed JSON response into a transient outage", async () => {
    const http = await loopback();
    const queueDir = mkdtempSync(join(tmpdir(), "body-malformed-"));
    try {
      http.setMode("malformed");
      await expect(stack(queueDir).retain.retain("main", { content: "invalid response" })).rejects.toBeInstanceOf(
        SyntaxError,
      );
      expect(existsSync(join(queueDir, "hindsight-retain-queue.main.jsonl"))).toBe(false);
      await expect(
        new RecallCoordinator().recall(stack(queueDir).client, {
          banks: ["main", "healthy"],
          query: "q",
          timeoutMs: 1000,
        }),
      ).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      await http.close();
      rmSync(queueDir, { recursive: true, force: true });
    }
  });

  it.each([
    "UND_ERR_SOCKET",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
  ])("retries a terminated response body with transport cause %s", (code) => {
    expect(isTransientRequestError(new TypeError("terminated", { cause: { code } }))).toBe(true);
    expect(isTransientRequestError(new TypeError("programming error", { cause: { code } }))).toBe(false);
  });

  it.each([
    new TypeError("terminated"),
    new TypeError("terminated", { cause: new Error("programming bug") }),
    new TypeError("terminated", { cause: { code: "UND_ERR_INVALID_ARG" } }),
    new TypeError("Body is unusable: Body has already been read"),
    new SyntaxError("invalid JSON"),
  ])("does not retry unrelated %s", (error) => {
    expect(isTransientRequestError(error)).toBe(false);
  });
});

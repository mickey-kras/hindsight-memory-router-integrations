import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory, type RouterClient } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RetainAuthorizationError, RetainCoordinator } from "../src/shared/retain-coordinator.js";

const TOKEN_MAIN = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_BACKEND = `mr_backend-key_${"b".repeat(64)}`;

const silentLog = { warn: () => {}, error: () => {} };

type FakeClient = RouterClient & {
  retains: Array<{
    bank: string;
    content: string;
    options?: Record<string, unknown>;
  }>;
};

function makeStack(options: {
  queueDir: string;
  behavior?: (bank: string) => void;
  attempts?: FakeClient["retains"];
  apiKeys?: string[];
  logger?: { warn(msg: string): void; error(msg: string): void };
  queueMaxAgeMs?: number;
  queueMaxItems?: number;
  queueMaxBytes?: number;
  onAbandon?: (item: { bankId: string }, attempts: number) => void;
  maxAgeConfigKey?: string;
}) {
  const credentials = new PrincipalCredentialResolver({
    routerUrl: "https://router.example.test",
    principals: {
      main: {
        token: TOKEN_MAIN,
        writeBank: "main",
        additionalReadBanks: ["main", "dev"],
      },
      backend: {
        token: TOKEN_BACKEND,
        writeBank: "dev",
        additionalReadBanks: ["dev"],
      },
    },
  });
  const fakeClients = new Map<string, FakeClient>();
  const clients = new AuthenticatedClientFactory({
    routerUrl: "https://router.example.test",
    userAgent: "test/0",
    construct: (clientOptions) => {
      options.apiKeys?.push(clientOptions.apiKey);
      const client: FakeClient = {
        retains: [],
        async retain(bank, content, retainOptions) {
          options.attempts?.push({ bank, content, options: retainOptions });
          options.behavior?.(bank);
          this.retains.push({ bank, content, options: retainOptions });
        },
        async recall() {
          return { results: [] };
        },
      };
      fakeClients.set(clientOptions.headers["x-memory-router-agent"], client);
      return client;
    },
  });
  const retain = new RetainCoordinator({
    credentials,
    clients,
    queueDir: options.queueDir,
    queueMaxAgeMs: options.queueMaxAgeMs,
    queueMaxItems: options.queueMaxItems,
    queueMaxBytes: options.queueMaxBytes,
    logger: options.logger ?? silentLog,
    onAbandon: options.onAbandon,
    maxAgeConfigKey: options.maxAgeConfigKey,
  });
  return { retain, fakeClients };
}

const httpError = (statusCode: number) => Object.assign(new Error(`http ${statusCode}`), { statusCode });

describe("RetainCoordinator", () => {
  let queueDir: string;
  beforeEach(() => {
    queueDir = mkdtempSync(join(tmpdir(), "retain-queue-"));
  });
  afterEach(() => {
    rmSync(queueDir, { recursive: true, force: true });
  });

  it("retains into the agent's default write bank with that agent's client", async () => {
    const { retain, fakeClients } = makeStack({ queueDir });
    const outcome = await retain.retain("main", { content: "hello" });
    expect(outcome).toEqual({ queued: false, bank: "main" });
    expect(fakeClients.get("main")?.retains).toHaveLength(1);
    expect(fakeClients.get("main")?.retains[0].bank).toBe("main");

    const backendOutcome = await retain.retain("backend", { content: "work" });
    expect(backendOutcome.bank).toBe("dev");
    expect(fakeClients.get("backend")?.retains[0].bank).toBe("dev");
  });

  it("preserves an existing backlog when another coordinator opens its directory", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(503);
      },
    });
    await first.retain.retain("main", { content: "already queued" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const backlog = readFileSync(queueFile, "utf8");

    makeStack({ queueDir });

    expect(readFileSync(queueFile, "utf8")).toBe(backlog);
  });

  it("fails closed on authorization denial: typed error, nothing queued", async () => {
    const { retain } = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(403);
      },
    });
    await expect(retain.retain("main", { content: "hello" })).rejects.toThrow(RetainAuthorizationError);
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    expect(() => readFileSync(queueFile, "utf8")).toThrow();
  });

  it("queues transient failures and replay preserves agent identity and bank target", async () => {
    const apiKeys: string[] = [];
    let fail = true;
    const first = makeStack({
      queueDir,
      apiKeys,
      behavior: () => {
        if (fail) {
          throw httpError(500);
        }
      },
    });
    const outcome = await first.retain.retain("backend", {
      content: "queued work",
    });
    expect(outcome.queued).toBe(true);
    expect(first.fakeClients.get("backend")?.retains).toHaveLength(0);

    // The queue file encodes the agent; the item encodes the bank. The raw
    // token is never persisted.
    const raw = readFileSync(join(queueDir, "hindsight-retain-queue.backend.jsonl"), "utf8");
    const item = JSON.parse(raw.trim());
    expect(item.bankId).toBe("dev");
    expect(raw).not.toContain(TOKEN_BACKEND);

    // Replay with a fresh stack (new process): identity re-resolved from the
    // queue file name, credentials looked up again, bank from the item.
    fail = false;
    const second = makeStack({ queueDir, apiKeys });
    await second.retain.flushQueues();
    expect(second.fakeClients.get("backend")?.retains).toHaveLength(1);
    expect(second.fakeClients.get("backend")?.retains[0].bank).toBe("dev");
    expect(second.fakeClients.get("backend")?.retains[0].content).toBe("queued work");
    expect(apiKeys).toEqual([TOKEN_BACKEND, TOKEN_BACKEND]);
  });

  it("does not queue non-retryable client errors", async () => {
    const { retain } = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(400);
      },
    });
    await expect(retain.retain("main", { content: "invalid" })).rejects.toThrow("http 400");
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    expect(() => readFileSync(queueFile, "utf8")).toThrow();
  });

  it("keeps document IDs omitted when unrelated retains are queued and replayed after restart", async () => {
    const attempts: FakeClient["retains"] = [];
    const first = makeStack({
      queueDir,
      attempts,
      behavior: () => {
        throw httpError(503);
      },
    });
    await first.retain.retain("main", { content: "first memory" });
    await first.retain.retain("main", { content: "second memory" });

    const raw = readFileSync(join(queueDir, "hindsight-retain-queue.main.jsonl"), "utf8");
    for (const line of raw.trim().split("\n")) {
      expect(JSON.parse(line)).not.toHaveProperty("documentId");
    }

    const [firstAttempt, secondAttempt] = attempts;
    expect(firstAttempt.options?.operationId).not.toBe(secondAttempt.options?.operationId);
    const retry = makeStack({
      queueDir,
      attempts,
      behavior: () => {
        throw httpError(503);
      },
    });
    await retry.retain.flushQueues();

    const replay = makeStack({ queueDir, attempts });
    await replay.retain.flushQueues();
    expect(replay.fakeClients.get("main")?.retains).toMatchObject([
      { content: "first memory", options: { documentId: undefined } },
      { content: "second memory", options: { documentId: undefined } },
    ]);
    const identities = attempts.map(({ content, options }) => ({
      content,
      documentId: options?.documentId,
      operationId: options?.operationId,
    }));
    expect(identities).toEqual([identities[0], identities[1], identities[0], identities[0], identities[1]]);
  });

  it.each(["conversation", "", "docs/a", "docs_a"])(
    "preserves the explicit document ID %j through queueing and replay",
    async (documentId) => {
      const first = makeStack({
        queueDir,
        behavior: () => {
          throw httpError(503);
        },
      });
      await first.retain.retain("main", { content: "memory", documentId });

      const replay = makeStack({ queueDir });
      await replay.retain.flushQueues();
      expect(replay.fakeClients.get("main")?.retains[0].options?.documentId).toBe(documentId);
    },
  );

  it.each([undefined, "conversation", "existing/document"])(
    "replays legacy document ID %j unchanged",
    async (documentId) => {
      writeFileSync(
        join(queueDir, "hindsight-retain-queue.main.jsonl"),
        `${JSON.stringify({
          id: "legacy-queue-item",
          bankId: "main",
          content: "older memory",
          documentId,
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );

      const replay = makeStack({ queueDir });
      await replay.retain.flushQueues();
      expect(replay.fakeClients.get("main")?.retains[0].options?.documentId).toBe(documentId);
    },
  );

  it("replay keeps items queued for unknown agents (fail closed)", async () => {
    const apiKeys: string[] = [];
    const first = makeStack({
      queueDir,
      apiKeys,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "orphaned" });

    const credentials = new PrincipalCredentialResolver({
      routerUrl: "https://router.example.test",
      principals: {
        backend: {
          token: TOKEN_BACKEND,
          writeBank: "dev",
          additionalReadBanks: [],
        },
      },
    });
    const clients = new AuthenticatedClientFactory({
      routerUrl: "https://router.example.test",
      userAgent: "test/0",
      construct: () => {
        throw new Error("must not build a client for unknown agent");
      },
    });
    const retain = new RetainCoordinator({
      credentials,
      clients,
      queueDir,
      logger: silentLog,
    });
    await retain.flushQueues();
    const raw = readFileSync(join(queueDir, "hindsight-retain-queue.main.jsonl"), "utf8");
    expect(raw.trim()).not.toBe("");
  });

  it("replay denial keeps items queued, logs the denial, and stops the FIFO replay", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "first item" });
    await first.retain.retain("main", { content: "second item" });

    let attempts = 0;
    const log = { warn: () => {}, error: vi.fn() };
    const replay = makeStack({
      queueDir,
      logger: log,
      behavior: () => {
        attempts += 1;
        throw httpError(403);
      },
    });
    await replay.retain.flushQueues();

    expect(log.error).toHaveBeenCalledWith("retain replay denied for bank main; item stays queued for operator review");
    expect(attempts).toBe(1);
    const raw = readFileSync(join(queueDir, "hindsight-retain-queue.main.jsonl"), "utf8").trim();
    expect(raw.split("\n")).toHaveLength(2);
  });

  it("does not queue statusless programming errors", async () => {
    const { retain } = makeStack({
      queueDir,
      behavior: () => {
        throw new Error("connection reset");
      },
    });
    await expect(retain.retain("main", { content: "offline work" })).rejects.toThrow("connection reset");
    expect(() => readFileSync(join(queueDir, "hindsight-retain-queue.main.jsonl"), "utf8")).toThrow();
  });

  it("queues the fetch network TypeError emitted by Node", async () => {
    const { retain } = makeStack({
      queueDir,
      behavior: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(retain.retain("main", { content: "offline" })).resolves.toEqual({ queued: true, bank: "main" });
  });

  it.each([undefined, "93fbc267-ec50-40fb-b065-77e34d613ec9"])(
    "preserves the initial operation and payload across lost acknowledgements with operationId=%s",
    async (operationId) => {
      const attempts: FakeClient["retains"] = [];
      const request = {
        content: "accepted before the acknowledgement was lost",
        documentId: "document",
        context: "context",
        tags: ["original"],
        updateMode: "append" as const,
        operationId,
        metadata: { count: 2, large: 3n, nested: { value: "original" } },
      };
      const first = makeStack({
        queueDir,
        attempts,
        behavior: () => {
          request.content = "changed while the request was pending";
          request.tags.push("changed");
          request.metadata.nested.value = "changed";
          throw new TypeError("fetch failed");
        },
      });
      await expect(first.retain.retain("main", request)).resolves.toEqual({ queued: true, bank: "main" });
      const initial = attempts[0];
      const initialId = initial.options?.operationId;
      expect(initialId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (operationId !== undefined) expect(initialId).toBe(operationId);
      const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
      expect(JSON.parse(readFileSync(queueFile, "utf8"))).toMatchObject({
        content: initial.content,
        documentId: "document",
        context: "context",
        tags: ["original"],
        updateMode: "append",
        operationId: initialId,
        metadata: { count: "2", large: "3", nested: '{"value":"original"}' },
      });
      const retry = makeStack({
        queueDir,
        attempts,
        behavior: () => {
          throw httpError(503);
        },
      });
      await retry.retain.flushQueues();
      const restarted = makeStack({ queueDir, attempts });
      await restarted.retain.flushQueues();
      expect(attempts).toEqual([initial, initial, initial]);
      expect(() => readFileSync(queueFile, "utf8")).toThrow();
    },
  );

  it.each([401, 408, 429, 503])("classifies HTTP %i correctly", async (statusCode) => {
    const { retain } = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(statusCode);
      },
    });
    if (statusCode === 401) {
      await expect(retain.retain("main", { content: "work" })).rejects.toThrow(RetainAuthorizationError);
    } else {
      await expect(retain.retain("main", { content: "work" })).resolves.toMatchObject({ queued: true });
    }
  });

  it("serializes supported metadata values and omits nullish values", async () => {
    const { retain, fakeClients } = makeStack({ queueDir });
    await retain.retain("main", {
      content: "metadata",
      documentId: "doc",
      context: "ctx",
      tags: ["tag"],
      updateMode: "append",
      operationId: "operation",
      metadata: {
        text: "value",
        count: 2,
        enabled: false,
        large: 3n,
        object: { a: 1 },
        symbol: Symbol("value"),
        missing: undefined,
        empty: null,
      },
    });
    expect(fakeClients.get("main")?.retains[0].options).toMatchObject({
      documentId: "doc",
      context: "ctx",
      tags: ["tag"],
      updateMode: "append",
      operationId: "operation",
      metadata: {
        text: "value",
        count: "2",
        enabled: "false",
        large: "3",
        object: '{"a":1}',
        symbol: "Symbol(value)",
      },
    });
  });

  it("ignores unrelated queue files and a missing queue directory", async () => {
    const { retain } = makeStack({ queueDir });
    writeFileSync(join(queueDir, "notes.txt"), "ignore");
    await expect(retain.flushQueues()).resolves.toBeUndefined();
    rmSync(queueDir, { recursive: true, force: true });
    await expect(retain.flushQueues()).resolves.toBeUndefined();
  });

  it("keeps a replay item whose bank no longer matches the principal route", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "queued" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const item = JSON.parse(readFileSync(queueFile, "utf8"));
    item.bankId = "dev";
    writeFileSync(queueFile, `${JSON.stringify(item)}\n`);
    const replay = makeStack({ queueDir });
    await replay.retain.flushQueues();
    expect(readFileSync(queueFile, "utf8").trim()).not.toBe("");
    expect(replay.fakeClients.get("main")?.retains).toHaveLength(0);
  });

  it("does not replay an item with an invalid update mode", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "queued" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const item = JSON.parse(readFileSync(queueFile, "utf8"));
    item.updateMode = "overwrite";
    writeFileSync(queueFile, `${JSON.stringify(item)}\n`);
    const replay = makeStack({ queueDir });
    await replay.retain.flushQueues();
    expect(readFileSync(queueFile, "utf8").trim()).not.toBe("");
    expect(replay.fakeClients.get("main")?.retains).toHaveLength(0);
  });

  it("persists replay attempts and abandons a poison item after five failures", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "poison" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const log = { warn: () => {}, error: vi.fn() };
    const replay = makeStack({
      queueDir,
      logger: log,
      behavior: () => {
        throw httpError(503);
      },
    });
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await replay.retain.flushQueues();
      const item = JSON.parse(readFileSync(queueFile, "utf8"));
      expect(item.replayAttempts).toBe(attempt);
    }
    await replay.retain.flushQueues();
    expect(() => readFileSync(queueFile, "utf8")).toThrow();
    expect(log.error).toHaveBeenCalledWith(
      "retain replay abandoned after 5 attempts for bank main; transcript dropped from the queue without delivery",
    );
  });

  it("routes abandonment to a host onAbandon handler instead of the log", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "poison" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const onAbandon = vi.fn();
    const log = { warn: () => {}, error: vi.fn() };
    const replay = makeStack({
      queueDir,
      logger: log,
      onAbandon,
      behavior: () => {
        throw httpError(503);
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await replay.retain.flushQueues();
    }
    expect(onAbandon).toHaveBeenCalledOnce();
    expect(onAbandon.mock.calls[0][0]).toMatchObject({ bankId: "main", content: "poison" });
    expect(onAbandon.mock.calls[0][1]).toBe(5);
    expect(log.error).not.toHaveBeenCalled();
    expect(() => readFileSync(queueFile, "utf8")).toThrow();
  });

  it("drops the item and logs when a host onAbandon handler throws", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(500);
      },
    });
    await first.retain.retain("main", { content: "poison" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const log = { warn: () => {}, error: vi.fn() };
    const replay = makeStack({
      queueDir,
      logger: log,
      onAbandon: () => {
        throw new Error("webhook unreachable");
      },
      behavior: () => {
        throw httpError(503);
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await replay.retain.flushQueues();
    }
    expect(log.error).toHaveBeenCalledWith("retain abandonment handler failed for bank main: Error");
    expect(() => readFileSync(queueFile, "utf8")).toThrow();
    log.error.mockClear();
    await replay.retain.flushQueues();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("warns at startup while queue retention is unbounded, and stays quiet when bounded", () => {
    const unbounded = { warn: vi.fn(), error: () => {} };
    makeStack({ queueDir, logger: unbounded });
    expect(unbounded.warn).toHaveBeenCalledWith(
      `retain queue at ${queueDir} holds plaintext transcripts with no expiration; set retainQueueMaxAgeMs to bound retention and protect the directory with disk encryption`,
    );
    const bounded = { warn: vi.fn(), error: () => {} };
    makeStack({ queueDir, logger: bounded, queueMaxAgeMs: 604800000 });
    expect(bounded.warn).not.toHaveBeenCalled();
    const renamed = { warn: vi.fn(), error: () => {} };
    makeStack({ queueDir, logger: renamed, maxAgeConfigKey: "queueMaxAgeMs" });
    expect(renamed.warn.mock.calls.flat().join("\n")).toContain("set queueMaxAgeMs to bound retention");
  });
  it("caps outage writes across principals, preserves FIFO, and frees capacity after replay", async () => {
    let unavailable = true;
    const stack = makeStack({
      queueDir,
      queueMaxItems: 2,
      behavior: () => {
        if (unavailable) throw httpError(429);
      },
    });
    await stack.retain.retain("main", { content: "first" });
    await stack.retain.retain("backend", { content: "second" });
    await expect(stack.retain.retain("main", { content: "rejected" })).rejects.toMatchObject({
      name: "RetainQueueCapacityError",
      code: "RETAIN_QUEUE_CAPACITY",
      limit: "items",
    });
    unavailable = false;
    await stack.retain.flushQueues();
    expect(stack.fakeClients.get("main")?.retains.map((item) => item.content)).toEqual(["first"]);
    expect(stack.fakeClients.get("backend")?.retains.map((item) => item.content)).toEqual(["second"]);
    unavailable = true;
    await expect(stack.retain.retain("backend", { content: "after replay" })).resolves.toMatchObject({ queued: true });
  });

  it("counts metadata and UTF-8 payload bytes and retains accepted data on capacity rejection", async () => {
    const stack = makeStack({
      queueDir,
      queueMaxBytes: 1000,
      behavior: () => {
        throw httpError(503);
      },
    });
    await stack.retain.retain("main", { content: "accepted" });
    const file = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const before = readFileSync(file, "utf8");
    await expect(
      stack.retain.retain("backend", { content: "x", metadata: { junk: "🚀".repeat(200) } }),
    ).rejects.toMatchObject({ name: "RetainQueueCapacityError", limit: "bytes" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("counts queues belonging to unknown principals after restart", async () => {
    const first = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(429);
      },
    });
    await first.retain.retain("main", { content: "before restart" });
    writeFileSync(join(queueDir, "hindsight-retain-queue.retired.jsonl"), "malformed\n");
    const restarted = makeStack({
      queueDir,
      queueMaxItems: 2,
      behavior: () => {
        throw httpError(429);
      },
    });
    await expect(restarted.retain.retain("backend", { content: "after restart" })).rejects.toMatchObject({
      name: "RetainQueueCapacityError",
      limit: "items",
    });
  });

  it("serializes simultaneous enqueue and replay mutations without losing accepted writes", async () => {
    const failing = makeStack({
      queueDir,
      queueMaxItems: 10,
      behavior: () => {
        throw httpError(429);
      },
    });
    await failing.retain.retain("main", { content: "old" });
    const replay = makeStack({ queueDir, queueMaxItems: 10 });
    await Promise.all([
      replay.retain.flushQueues(),
      ...Array.from({ length: 5 }, (_, index) => failing.retain.retain("main", { content: `new-${index}` })),
    ]);
    await replay.retain.flushQueues();
    expect(
      replay.fakeClients
        .get("main")
        ?.retains.map((item) => item.content)
        .sort(),
    ).toEqual(["new-0", "new-1", "new-2", "new-3", "new-4", "old"]);
  });
  it("does not deserialize backlog records while accepting subsequent outage writes", async () => {
    const stack = makeStack({
      queueDir,
      behavior: () => {
        throw httpError(429);
      },
    });
    await stack.retain.retain("main", { content: "existing" });
    const parse = vi.spyOn(JSON, "parse");
    try {
      await stack.retain.retain("main", { content: "next" });
      await stack.retain.retain("backend", { content: "another principal" });
      expect(parse).not.toHaveBeenCalledWith(expect.stringContaining('"bankId":'));
    } finally {
      parse.mockRestore();
    }
  });
});

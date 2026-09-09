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
  apiKeys?: string[];
  logger?: { warn(msg: string): void; error(msg: string): void };
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
    logger: options.logger ?? silentLog,
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
    // Replay authenticated with the backend token, not any other agent's.
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

  it("assigns and persists an operation id for replay identity", async () => {
    const { retain, fakeClients } = makeStack({ queueDir });
    await retain.retain("main", { content: "with-op-id" });
    const options = fakeClients.get("main")?.retains[0].options;
    expect(typeof options?.operationId).toBe("string");
    expect(String(options?.operationId)).not.toBe("");
  });

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
    const replay = makeStack({
      queueDir,
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
  });
});

import {
  appendFileSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as lockDelay } from "node:timers/promises";

import { tryLock } from "fs-native-extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory, type RouterClient } from "../src/shared/authenticated-client-factory.js";
import { type PrincipalConfig, PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RetainAuthorizationError, RetainCoordinator } from "../src/shared/retain-coordinator.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

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
  principals?: Record<string, PrincipalConfig>;
}) {
  const credentials = new PrincipalCredentialResolver({
    routerUrl: "https://router.example.test",
    principals: options.principals ?? {
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

async function queuePrincipals(queueDir: string) {
  const first = makeStack({
    queueDir,
    behavior: () => {
      throw httpError(503);
    },
  });
  await first.retain.retain("backend", { content: "private backend transcript" });
  await first.retain.retain("main", { content: "private main transcript" });
  // Choose the failing queue from the actual directory order so each regression
  // proves that a later principal is reached on this filesystem.
  return readdirSync(queueDir)
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => {
      const path = join(queueDir, file);
      const raw = readFileSync(path, "utf8");
      const item = JSON.parse(raw);
      const principal = item.bankId === "dev" ? "backend" : "main";
      return { path, raw, item, principal };
    });
}

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

  it("discovers and replays the normalized queue directory after symlink-parent traversal", async () => {
    const safe = join(queueDir, "safe");
    const other = join(queueDir, "other");
    mkdirSync(join(safe, "queue"), { recursive: true, mode: 0o700 });
    mkdirSync(join(other, "child"), { recursive: true, mode: 0o700 });
    mkdirSync(join(other, "queue"), { mode: 0o700 });
    symlinkSync(join(other, "child"), join(safe, "link"));
    let fail = true;
    const { retain, fakeClients } = makeStack({
      queueDir: `${safe}/link/../queue`,
      behavior: () => {
        if (fail) throw httpError(503);
      },
    });
    await expect(retain.retain("main", { content: "pending" })).resolves.toMatchObject({ queued: true });
    expect(readdirSync(join(safe, "queue"))).toContain("hindsight-retain-queue.main.jsonl");
    fail = false;
    await retain.flushQueues();
    expect(fakeClients.get("main")?.retains).toEqual([expect.objectContaining({ content: "pending", bank: "main" })]);
    expect(readdirSync(join(safe, "queue"))).not.toContain("hindsight-retain-queue.main.jsonl");
    expect(readdirSync(join(other, "queue"))).toEqual([]);
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

  it("continues past an oversized queue without weakening aggregate enqueue capacity", async () => {
    const [blocked, ready] = await queuePrincipals(queueDir);
    const oversized = `${JSON.stringify({ ...blocked.item, content: "private transcript ".repeat(100) })}\n`;
    writeFileSync(blocked.path, oversized);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const replay = makeStack({ queueDir, queueMaxBytes: 1000, logger });

    await expect(replay.retain.flushQueues()).resolves.toBeUndefined();

    expect(readFileSync(blocked.path, "utf8")).toBe(oversized);
    expect(replay.fakeClients.get(blocked.principal)?.retains).toEqual([]);
    expect(replay.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
    expect(() => readFileSync(ready.path)).toThrow();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      `retain queue replay failed for agent ${blocked.principal}; remaining items stay queued for retry`,
    );

    const outage = makeStack({
      queueDir,
      queueMaxBytes: 1000,
      behavior: () => {
        throw httpError(503);
      },
    });
    await expect(outage.retain.retain(ready.principal, { content: "new work" })).rejects.toMatchObject({
      name: "RetainQueueCapacityError",
      limit: "bytes",
    });
    expect(readFileSync(blocked.path, "utf8")).toBe(oversized);

    await replay.retain.flushQueues();
    expect(replay.fakeClients.get(ready.principal)?.retains).toHaveLength(1);
    const restarted = makeStack({ queueDir, queueMaxBytes: 3000 });
    await restarted.retain.flushQueues();
    expect(restarted.fakeClients.get(blocked.principal)?.retains).toMatchObject([
      { content: JSON.parse(oversized).content, options: { operationId: blocked.item.operationId } },
    ]);
    expect(() => readFileSync(blocked.path)).toThrow();
  });

  it.each(["symlink", "hardlink"])(
    "isolates a rejected %s queue without reading or changing its target",
    async (kind) => {
      const [blocked, ready] = await queuePrincipals(queueDir);
      const target = join(queueDir, "private-target");
      writeFileSync(target, blocked.raw, { mode: 0o644 });
      rmSync(blocked.path);
      if (kind === "symlink") symlinkSync(target, blocked.path);
      else linkSync(target, blocked.path);
      const logger = { warn: vi.fn(), error: vi.fn() };
      const replay = makeStack({ queueDir, logger });

      await expect(replay.retain.flushQueues()).resolves.toBeUndefined();

      expect(readFileSync(target, "utf8")).toBe(blocked.raw);
      expect(statSync(target).mode & 0o777).toBe(0o644);
      expect(replay.fakeClients.get(blocked.principal)?.retains).toEqual([]);
      expect(replay.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        `retain queue replay failed for agent ${blocked.principal}; remaining items stay queued for retry`,
      );

      rmSync(blocked.path);
      writeFileSync(blocked.path, blocked.raw, { mode: 0o600 });
      const restarted = makeStack({ queueDir });
      await restarted.retain.flushQueues();
      expect(restarted.fakeClients.get(blocked.principal)?.retains).toMatchObject([
        { content: blocked.item.content, options: { operationId: blocked.item.operationId } },
      ]);
      expect(readFileSync(target, "utf8")).toBe(blocked.raw);
      expect(statSync(target).mode & 0o777).toBe(0o644);
    },
  );

  it("isolates recovery filesystem failures and retries the intact backlog after repair and restart", async () => {
    const [blocked, ready] = await queuePrincipals(queueDir);
    const corrupt = "private malformed transcript\n";
    appendFileSync(blocked.path, corrupt);
    const before = readFileSync(blocked.path, "utf8");
    const recoveryDir = `${blocked.path}.recovery`;
    writeFileSync(recoveryDir, "recovery path is unavailable");
    const logger = { warn: vi.fn(), error: vi.fn() };
    const replay = makeStack({ queueDir, logger });

    await expect(replay.retain.flushQueues()).resolves.toBeUndefined();
    await expect(replay.retain.flushQueues()).resolves.toBeUndefined();

    expect(readFileSync(blocked.path, "utf8")).toBe(before);
    // Recovery and ordinal barriers must become durable before any HTTP request.
    expect(replay.fakeClients.get(blocked.principal)?.retains).toEqual([]);
    expect(replay.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls.flat().join("\n")).not.toContain("private");
    expect(logger.error.mock.calls.flat().join("\n")).not.toContain(queueDir);

    rmSync(recoveryDir);
    const restarted = makeStack({ queueDir });
    await restarted.retain.flushQueues();
    expect(restarted.fakeClients.get(blocked.principal)?.retains).toMatchObject([
      { content: blocked.item.content, options: { operationId: blocked.item.operationId } },
    ]);
    const archive = readdirSync(recoveryDir).find((file) => file.endsWith(".jsonl"));
    expect(readFileSync(join(recoveryDir, archive as string), "utf8")).toBe(corrupt);
    expect(JSON.parse(readFileSync(blocked.path, "utf8")).replayState.quarantine).toBe("corrupt");
  });

  it("defers every principal after a shared lock timeout and retries on the next flush", async () => {
    const [blocked, ready] = await queuePrincipals(queueDir);
    let lock: number | undefined = openSync(join(queueDir, ".retain-queue.lock"), "a", 0o600);
    expect(tryLock(lock)).toBe(true);
    const logger = { warn: vi.fn(), error: vi.fn() };
    try {
      const replay = makeStack({ queueDir, logger });
      await expect(replay.retain.flushQueues()).resolves.toBeUndefined();
      expect(readFileSync(blocked.path, "utf8")).toBe(blocked.raw);
      expect(readFileSync(ready.path, "utf8")).toBe(ready.raw);
      expect(replay.fakeClients.get(blocked.principal)?.retains).toEqual([]);
      expect(replay.fakeClients.has(ready.principal)).toBe(false);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "retain queue replay paused: shared storage unavailable; remaining items stay queued for retry",
      );
      closeSync(lock);
      lock = undefined;
      const restarted = makeStack({ queueDir });
      await restarted.retain.flushQueues();
      expect(restarted.fakeClients.get(blocked.principal)?.retains).toMatchObject([{ content: blocked.item.content }]);
      expect(restarted.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
    } finally {
      if (lock !== undefined) closeSync(lock);
    }
  }, 10000);

  it.each([2, 64])("uses one shared-lock retry budget for %i principal queues", async (count) => {
    const fixtures = Array.from({ length: count }, (_, index) => {
      const principal = `agent-${index}`;
      const path = join(queueDir, `hindsight-retain-queue.${principal}.jsonl`);
      const raw = `${JSON.stringify({
        id: principal,
        bankId: principal,
        content: "private queued fixture",
        metadata: {},
        operationId: `operation-${index}`,
        createdAt: new Date().toISOString(),
      })}\n`;
      writeFileSync(path, raw, { mode: 0o600 });
      return { principal, path, raw };
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const replay = makeStack({
      queueDir,
      logger,
      principals: Object.fromEntries(
        fixtures.map(({ principal }) => [principal, { token: TOKEN_MAIN, writeBank: principal }]),
      ),
    });
    let lock: number | undefined = openSync(join(queueDir, ".retain-queue.lock"), "a", 0o600);
    expect(tryLock(lock)).toBe(true);
    vi.mocked(lockDelay).mockClear().mockResolvedValue(undefined);
    try {
      await replay.retain.flushQueues();
      expect(lockDelay).toHaveBeenCalledTimes(30);
      expect(replay.fakeClients.size).toBe(1);
      expect([...replay.fakeClients.values()].flatMap((client) => client.retains)).toEqual([]);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "retain queue replay paused: shared storage unavailable; remaining items stay queued for retry",
      );
      for (const { path, raw } of fixtures) expect(readFileSync(path, "utf8")).toBe(raw);

      closeSync(lock);
      lock = undefined;
      await replay.retain.flushQueues();
      expect([...replay.fakeClients.values()].flatMap((client) => client.retains)).toHaveLength(count);
      expect(lockDelay).toHaveBeenCalledTimes(30);
    } finally {
      if (lock !== undefined) closeSync(lock);
      vi.mocked(lockDelay).mockRestore();
    }
  });

  it("stops after a shared failure following delivery without changing operation IDs or retrying the lock", async () => {
    const [blocked, ready] = await queuePrincipals(queueDir);
    const second = { ...blocked.item, id: "second-item", content: "second item", operationId: "second-operation" };
    const before = `${blocked.raw}${JSON.stringify(second)}\n`;
    writeFileSync(blocked.path, before, { mode: 0o600 });
    let lock: number | undefined;
    let heldOnce = false;
    const logger = { warn: vi.fn(), error: vi.fn() };
    const replay = makeStack({
      queueDir,
      logger,
      behavior: (bank) => {
        if (bank === blocked.item.bankId && !heldOnce) {
          heldOnce = true;
          lock = openSync(join(queueDir, ".retain-queue.lock"), "a", 0o600);
          expect(tryLock(lock)).toBe(true);
        }
      },
    });
    vi.mocked(lockDelay).mockClear().mockResolvedValue(undefined);
    try {
      await replay.retain.flushQueues();
      expect(lockDelay).toHaveBeenCalledTimes(30);
      expect(readFileSync(blocked.path, "utf8")).toBe(
        `${JSON.stringify({ ...blocked.item, replayState: { sending: true } })}\n${JSON.stringify(second)}\n`,
      );
      expect(readFileSync(ready.path, "utf8")).toBe(ready.raw);
      expect(replay.fakeClients.get(blocked.principal)?.retains).toMatchObject([
        { content: blocked.item.content, options: { operationId: blocked.item.operationId } },
      ]);
      expect(replay.fakeClients.has(ready.principal)).toBe(false);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "retain queue replay paused: shared storage unavailable; remaining items stay queued for retry",
      );

      if (lock !== undefined) closeSync(lock);
      lock = undefined;
      await replay.retain.flushQueues();
      expect(replay.fakeClients.get(blocked.principal)?.retains).toHaveLength(1);
      // Explicit operator recovery after reconciling the uncertain HTTP outcome.
      writeFileSync(blocked.path, before, { mode: 0o600 });
      await replay.retain.flushQueues();
      expect(replay.fakeClients.get(blocked.principal)?.retains).toMatchObject([
        { content: blocked.item.content, options: { operationId: blocked.item.operationId } },
        { content: blocked.item.content, options: { operationId: blocked.item.operationId } },
        { content: second.content, options: { operationId: second.operationId } },
      ]);
      expect(replay.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
      expect(lockDelay).toHaveBeenCalledTimes(30);
    } finally {
      if (lock !== undefined) closeSync(lock);
      vi.mocked(lockDelay).mockRestore();
    }
  });

  it.each([".retain-queue.lock", ".retain-replay.lock", "hindsight-retain-queue.backend.jsonl.probe.tmp"])(
    "stops once for unsafe shared storage at %s and resumes after repair",
    async (name) => {
      const fixtures = await queuePrincipals(queueDir);
      const target = join(queueDir, "private-target");
      writeFileSync(target, "untouched private target", { mode: 0o644 });
      const mode = statSync(target).mode & 0o777;
      const unsafe = join(queueDir, name);
      rmSync(unsafe, { force: true });
      symlinkSync(target, unsafe);
      const logger = { warn: vi.fn(), error: vi.fn() };
      const replay = makeStack({ queueDir, logger });

      await replay.retain.flushQueues();

      for (const { path, raw } of fixtures) expect(readFileSync(path, "utf8")).toBe(raw);
      expect([...replay.fakeClients.values()].flatMap((client) => client.retains)).toEqual([]);
      expect(readFileSync(target, "utf8")).toBe("untouched private target");
      expect(statSync(target).mode & 0o777).toBe(mode);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        "retain queue replay paused: shared storage unavailable; remaining items stay queued for retry",
      );

      rmSync(unsafe);
      await replay.retain.flushQueues();
      for (const { principal, item } of fixtures) {
        expect(replay.fakeClients.get(principal)?.retains).toMatchObject([{ content: item.content }]);
      }
      expect(readFileSync(target, "utf8")).toBe("untouched private target");
      expect(statSync(target).mode & 0o777).toBe(mode);
    },
  );

  it.each(["retired", "private prompt", "x".repeat(129), ".", ".."])(
    "skips an unknown or invalid principal without logging its filename: %j",
    async (principal) => {
      const [first, second] = await queuePrincipals(queueDir);
      const unknownPath = join(queueDir, `hindsight-retain-queue.${principal}.jsonl`);
      writeFileSync(unknownPath, "private orphaned transcript\n");
      const logger = { warn: vi.fn(), error: vi.fn() };
      const replay = makeStack({ queueDir, logger });

      await replay.retain.flushQueues();

      expect(readFileSync(unknownPath, "utf8")).toBe("private orphaned transcript\n");
      expect([...replay.fakeClients.keys()].sort()).toEqual(["backend", "main"]);
      for (const queue of [first, second]) {
        expect(replay.fakeClients.get(queue.principal)?.retains).toMatchObject([{ content: queue.item.content }]);
      }
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^retain queue replay skipped: no routing entry for queue [0-9a-f]{16}$/),
      );
    },
  );

  it.each([401, 403])(
    "keeps HTTP %i denial local to its principal and preserves the denied backlog",
    async (status) => {
      const [blocked, ready] = await queuePrincipals(queueDir);
      const replay = makeStack({
        queueDir,
        behavior: (bank) => {
          if (bank === blocked.item.bankId) throw httpError(status);
        },
      });
      await replay.retain.flushQueues();
      expect(JSON.parse(readFileSync(blocked.path, "utf8"))).toEqual({
        ...blocked.item,
        replayState: { gate: "probe", protected: true },
      });
      expect(replay.fakeClients.get(blocked.principal)?.retains).toEqual([]);
      expect(replay.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
    },
  );

  it("keeps a mismatched bank local to its principal without rerouting or starving other queues", async () => {
    const [blocked, ready] = await queuePrincipals(queueDir);
    const denied = `${JSON.stringify({ ...blocked.item, bankId: "unconfigured-bank" })}\n`;
    writeFileSync(blocked.path, denied);
    const replay = makeStack({ queueDir });

    await replay.retain.flushQueues();

    expect(JSON.parse(readFileSync(blocked.path, "utf8"))).toEqual({
      ...JSON.parse(denied),
      replayState: { quarantine: "bank-mismatch" },
    });
    expect(replay.fakeClients.get(blocked.principal)?.retains).toEqual([]);
    expect(replay.fakeClients.get(ready.principal)?.retains).toMatchObject([{ content: ready.item.content }]);
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

  it("recovers an item with an invalid update mode without replaying it", async () => {
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
    const recoveryDir = `${queueFile}.recovery`;
    expect(
      readFileSync(join(recoveryDir, readdirSync(recoveryDir).filter((name) => name.endsWith(".jsonl"))[0]), "utf8"),
    ).toBe(`${JSON.stringify(item)}\n`);
    expect(replay.fakeClients.get("main")?.retains).toHaveLength(0);
  });

  it("preserves corrupt bytes and holds later writes behind an ordinal barrier", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const failing = makeStack({
      queueDir,
      logger: log,
      behavior: () => {
        throw httpError(503);
      },
    });
    await failing.retain.retain("main", { content: "first", documentId: "document", updateMode: "append" });
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    const corrupt = 'private broken transcript\r\n{"content":"private invalid record"}\n';
    appendFileSync(queueFile, corrupt);
    await failing.retain.retain("main", { content: "second", documentId: "document", updateMode: "replace" });
    const replay = makeStack({ queueDir, logger: log });
    await replay.retain.flushQueues();
    expect(
      replay.fakeClients.get("main")?.retains.map(({ content, options }) => [content, options?.updateMode]),
    ).toEqual([["first", "append"]]);
    expect(readFileSync(queueFile, "utf8")).toContain('"content":"second"');
    const recoveryDir = `${queueFile}.recovery`;
    expect(
      readFileSync(join(recoveryDir, readdirSync(recoveryDir).filter((name) => name.endsWith(".jsonl"))[0]), "utf8"),
    ).toBe(corrupt);
    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      "retain queue recovery preserved corrupt records: malformed-json=1, invalid-shape=1",
    );
    await makeStack({ queueDir, logger: log }).retain.flushQueues();
    expect(readdirSync(recoveryDir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
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
      `retain queue at ${queueDir} holds plaintext transcripts with no expiration; set retainQueueMaxAgeMs to bound ordinary retention (protected backlog is exempt) and protect the directory with disk encryption`,
    );
    const bounded = { warn: vi.fn(), error: () => {} };
    makeStack({ queueDir, logger: bounded, queueMaxAgeMs: 604800000 });
    expect(bounded.warn).not.toHaveBeenCalled();
    const renamed = { warn: vi.fn(), error: () => {} };
    makeStack({ queueDir, logger: renamed, maxAgeConfigKey: "queueMaxAgeMs" });
    expect(renamed.warn.mock.calls.flat().join("\n")).toContain(
      "set queueMaxAgeMs to bound ordinary retention (protected backlog is exempt)",
    );
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
    const queueFile = join(queueDir, "hindsight-retain-queue.main.jsonl");
    appendFileSync(queueFile, "broken\n");
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
    ).toEqual(["old"]);
    const pending = readFileSync(queueFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(pending[0].replayState.quarantine).toBe("corrupt");
    expect(
      pending
        .slice(1)
        .map((item) => item.content)
        .sort(),
    ).toEqual(["new-0", "new-1", "new-2", "new-3", "new-4"]);
    const recoveryDir = `${queueFile}.recovery`;
    expect(
      readFileSync(join(recoveryDir, readdirSync(recoveryDir).filter((name) => name.endsWith(".jsonl"))[0]), "utf8"),
    ).toBe("broken\n");
  });
  it("inspects the principal backlog before admitting fresh delivery", async () => {
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
      expect(parse).toHaveBeenCalledWith(expect.stringContaining('"bankId":'));
    } finally {
      parse.mockRestore();
    }
  });
});

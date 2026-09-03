import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentCredentialResolver } from "../src/router/agent-credential-resolver.js";
import {
  AuthenticatedClientFactory,
  type RouterClient,
} from "../src/router/authenticated-client-factory.js";
import {
  RetainAuthorizationError,
  RetainCoordinator,
} from "../src/router/retain-coordinator.js";
import { WriteBankResolver } from "../src/router/write-bank-resolver.js";

const TOKEN_MAIN = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_BACKEND = `mr_backend-key_${"b".repeat(64)}`;

const silentLog = { warn: () => {}, error: () => {} };

type FakeClient = RouterClient & {
  retains: Array<{ bank: string; content: string; options?: Record<string, unknown> }>;
};

function makeStack(options: {
  queueDir: string;
  behavior?: (bank: string) => void;
  apiKeys?: string[];
}) {
  const credentials = new AgentCredentialResolver({
    routerUrl: "https://router.example.test",
    agents: {
      main: { token: TOKEN_MAIN, writeBank: "main", recallBanks: ["main", "dev"] },
      backend: { token: TOKEN_BACKEND, writeBank: "dev", recallBanks: ["dev"] },
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
    writeBanks: new WriteBankResolver(credentials),
    clients,
    queueDir: options.queueDir,
    logger: silentLog,
  });
  return { retain, fakeClients };
}

const httpError = (statusCode: number) =>
  Object.assign(new Error(`http ${statusCode}`), { statusCode });

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
    await expect(retain.retain("main", { content: "hello" })).rejects.toThrow(
      RetainAuthorizationError
    );
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
    const outcome = await first.retain.retain("backend", { content: "queued work" });
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

    const credentials = new AgentCredentialResolver({
      routerUrl: "https://router.example.test",
      agents: {
        backend: { token: TOKEN_BACKEND, writeBank: "dev", recallBanks: [] },
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
      writeBanks: new WriteBankResolver(credentials),
      clients,
      queueDir,
      logger: silentLog,
    });
    await retain.flushQueues();
    const raw = readFileSync(join(queueDir, "hindsight-retain-queue.main.jsonl"), "utf8");
    expect(raw.trim()).not.toBe("");
  });

  it("assigns and persists an operation id for replay identity", async () => {
    const { retain, fakeClients } = makeStack({ queueDir });
    await retain.retain("main", { content: "with-op-id" });
    const options = fakeClients.get("main")?.retains[0].options;
    expect(typeof options?.operationId).toBe("string");
    expect(String(options?.operationId)).not.toBe("");
  });
});

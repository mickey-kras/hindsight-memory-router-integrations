import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RetainCoordinator } from "../src/shared/retain-coordinator.js";
import { type QueuedRetain, RetainQueue } from "../src/upstream/src/retain-queue.js";

const token = `mr_test_${"a".repeat(64)}`;
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stack() {
  const queueDir = mkdtempSync(join(tmpdir(), "retain-auth-recovery-"));
  directories.push(queueDir);
  const credentials = new PrincipalCredentialResolver({
    principals: { test: { token, writeBank: "A", additionalReadBanks: ["B"] } },
  });
  const clients = new AuthenticatedClientFactory({ routerUrl: "https://router.test", userAgent: "test" });
  const coordinator = new RetainCoordinator({
    credentials,
    clients,
    queueDir,
    queueMaxAgeMs: 1000,
    logger: { warn() {}, error() {} },
  });
  const rows = (): QueuedRetain[] => {
    const file = join(queueDir, "hindsight-retain-queue.test.jsonl");
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8").trim();
    return text ? text.split("\n").map((line) => JSON.parse(line) as QueuedRetain) : [];
  };
  return { coordinator, clients, credentials, rows };
}

it.each([401, 403])(
  "recovers a durable gate through production clients after HTTP %s with the same token",
  async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const { coordinator, clients, credentials, rows } = stack();
    await coordinator.retain("test", { content: "owner", documentId: "doc", operationId: "owner-op" });
    const originalClient = clients.forAgent(credentials.resolve("test"));
    fetch.mockResolvedValue(new Response(null, { status }));
    await coordinator.flushQueues();
    expect(rows()[0].replayState).toMatchObject({ gate: "probe", protected: true });
    await coordinator.retain("test", { content: "successor", documentId: "doc", operationId: "next-op" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(originalClient.recall("A", "query")).rejects.toThrow("memory access denied");
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockImplementation(async () => Response.json({}));
    await coordinator.flushQueues();
    expect(rows()).toEqual([]);
    expect(fetch.mock.calls.slice(2).map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }))).toEqual([
      {
        url: "https://router.test/v1/default/banks/A/memories",
        body: {
          items: [{ content: "owner", document_id: "doc", metadata: {} }],
          async: true,
          operation_id: "owner-op",
        },
      },
      {
        url: "https://router.test/v1/default/banks/A/memories",
        body: {
          items: [{ content: "successor", document_id: "doc", metadata: {} }],
          async: true,
          operation_id: "next-op",
        },
      },
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}`, "x-memory-router-agent": "test" });
    }
    // New work uses the recovered cache; existing denied clients stay denied.
    await expect(originalClient.retain("A", "old-client")).rejects.toThrow("memory access denied");
    await expect(coordinator.retain("test", { content: "fresh" })).resolves.toMatchObject({ queued: false });
    await expect(clients.forAgent(credentials.resolve("test")).retain("B", "wrong-bank")).rejects.toThrow(
      "memory access denied",
    );
    expect(fetch).toHaveBeenCalledTimes(5);
  },
);

it.each([401, 403])(
  "reprobes only the durable owner while HTTP %s continues and protects old and fresh backlog",
  async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    const { coordinator, clients, credentials, rows } = stack();
    await coordinator.retain("test", { content: "owner", operationId: "owner-op" });
    await coordinator.retain("test", { content: "older", operationId: "older-op" });
    fetch.mockResolvedValue(new Response(null, { status }));
    await coordinator.flushQueues();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
    for (let attempt = 0; attempt < 6; attempt++) {
      await coordinator.retain("test", { content: "fresh", operationId: `fresh-${attempt}` });
      const count = fetch.mock.calls.length;
      await coordinator.flushQueues();
      expect(fetch).toHaveBeenCalledTimes(count + 1);
      expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ operation_id: "owner-op" });
    }
    const backlog = rows();
    expect(backlog).toHaveLength(8);
    expect(backlog[0].replayState).toMatchObject({ gate: "probe", protected: true });
    expect(backlog.every((row) => row.replayState?.protected && !row.replayState.sending)).toBe(true);
    const count = fetch.mock.calls.length;
    await expect(clients.forAgent(credentials.resolve("test")).recall("A", "query")).rejects.toThrow(
      "memory access denied",
    );
    expect(fetch).toHaveBeenCalledTimes(count);
  },
);

it("keeps shared denial and fresh admission closed until the probe owner is durably removed", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  const { coordinator, clients, credentials, rows } = stack();
  await coordinator.retain("test", { content: "owner", operationId: "owner-op" });
  fetch.mockResolvedValue(new Response(null, { status: 403 }));
  await coordinator.flushQueues();
  const denied = clients.forAgent(credentials.resolve("test"));
  fetch.mockImplementation(async () => Response.json({}));
  const remove = vi.spyOn(RetainQueue.prototype, "remove").mockImplementationOnce(() => {
    throw new Error("acknowledgement storage failed");
  });
  await coordinator.flushQueues();
  expect(rows()[0].replayState).toMatchObject({ gate: "probe", protected: true });
  expect(clients.forAgent(credentials.resolve("test"))).toBe(denied);
  await coordinator.retain("test", { content: "fresh", operationId: "fresh-op" });
  expect(fetch).toHaveBeenCalledTimes(3);
  await expect(denied.retain("A", "direct")).rejects.toThrow("memory access denied");
  remove.mockRestore();
  await coordinator.flushQueues();
  expect(rows()).toEqual([]);
  expect(fetch.mock.calls.slice(2).map(([, init]) => JSON.parse(String(init?.body)).operation_id)).toEqual([
    "owner-op",
    "owner-op",
    "fresh-op",
  ]);
});

it.each(["before", "after"])(
  "preserves rotated transport denial when rotation occurs %s probe creation",
  async (timing) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 403 }));
    const { clients, credentials } = stack();
    const original = credentials.resolve("test");
    clients.forAgent(original);
    const pendingProbe = timing === "after" ? clients.createRetainReplayProbe(original) : undefined;
    const rotated = { ...original, token: `mr_rotated_${"b".repeat(64)}` };
    const deniedTransport = clients.transportFor(rotated);
    await expect(
      deniedTransport.request(deniedTransport.bankUrl("A", "/memories"), { method: "POST" }),
    ).rejects.toThrow("memory access denied");
    const probe = pendingProbe ?? clients.createRetainReplayProbe(original);
    fetch.mockImplementation(async () => Response.json({}));
    await probe.client.retain("A", "owner", { operationId: "owner-op" });
    expect(probe.commit()).toBe(false);
    expect(clients.transportFor(rotated)).toBe(deniedTransport);
    await expect(
      deniedTransport.request(deniedTransport.bankUrl("A", "/memories"), { method: "POST" }),
    ).rejects.toThrow("memory access denied");
    await expect(clients.forAgent(rotated).retain("A", "fresh")).rejects.toThrow("memory access denied");
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ["client", "before"],
  ["client", "during"],
  ["transport", "before"],
  ["transport", "during"],
])("stops backlog replay when %s credentials rotate %s the probe", async (cache, timing) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  const { coordinator, clients, credentials, rows } = stack();
  await coordinator.retain("test", { content: "owner", operationId: "owner-op" });
  fetch.mockResolvedValue(new Response(null, { status: 403 }));
  await coordinator.flushQueues();
  await coordinator.retain("test", { content: "successor", operationId: "next-op" });
  const original = credentials.resolve("test");
  const rotated = { ...original, token: `mr_rotated_${"b".repeat(64)}` };
  const rotate = () => {
    if (cache === "client") clients.forAgent(rotated);
    else clients.transportFor(rotated);
    vi.spyOn(credentials, "resolve").mockReturnValue(rotated);
  };
  if (timing === "before") {
    const create = clients.createRetainReplayProbe.bind(clients);
    vi.spyOn(clients, "createRetainReplayProbe").mockImplementation((current) => {
      rotate();
      return create(current);
    });
  }
  fetch.mockImplementation(async () => {
    if (timing === "during") rotate();
    return Response.json({});
  });
  await coordinator.flushQueues();
  expect(rows().map((row) => row.operationId)).toEqual(["next-op"]);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(fetch.mock.calls[2][1]?.body)).operation_id).toBe("owner-op");
  fetch.mockImplementation(async () => Response.json({}));
  await coordinator.flushQueues();
  expect(rows()).toEqual([]);
  expect(fetch.mock.calls[3][1]?.headers).toMatchObject({ Authorization: `Bearer ${rotated.token}` });
  expect(JSON.parse(String(fetch.mock.calls[3][1]?.body)).operation_id).toBe("next-op");
});

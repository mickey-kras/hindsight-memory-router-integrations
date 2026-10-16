import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedClientFactory } from "../src/shared/authenticated-client-factory.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";
import { RetainCoordinator } from "../src/shared/retain-coordinator.js";
import { RetainQueueStorage } from "../src/shared/retain-queue-storage.js";
import { type QueuedRetain, RetainQueue, RetainQueueRewriteCapacityError } from "../src/upstream/src/retain-queue.js";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "retain-quarantine-"));
  path = join(directory, "hindsight-retain-queue.main.jsonl");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
const http = (statusCode: number) => Object.assign(new Error("private response"), { statusCode });
function rows(): QueuedRetain[] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function enqueue(content: string, documentId?: string, extra: Partial<QueuedRetain> = {}): void {
  new RetainQueue({ filePath: path }).enqueue("bank", {
    content,
    documentId,
    updateMode: "append",
    operationId: `op-${content}`,
  });
  const items = rows();
  Object.assign(items[items.length - 1], extra);
  writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
}
function stack(
  behavior: (content: string) => void | Promise<void> = () => {},
  options: { bank?: string; age?: number; maxItems?: number; maxBytes?: number } = {},
) {
  const calls: Array<{ bank: string; content: string; options?: Record<string, unknown> }> = [];
  const logger = { warn: vi.fn(), error: vi.fn() };
  const config = {
    routerUrl: "https://router.example.test",
    principals: {
      main: { token: `mr_main-key_${"a".repeat(64)}`, writeBank: options.bank ?? "bank", additionalReadBanks: [] },
    },
  };
  const credentials = new PrincipalCredentialResolver(config);
  const clients = new AuthenticatedClientFactory({
    routerUrl: "https://router.example.test",
    userAgent: "test/0",
    construct: () => ({
      async retain(bank, content, request) {
        calls.push({ bank, content, options: request });
        await behavior(content);
      },
      async recall() {
        return { results: [] };
      },
    }),
  });
  const coordinator = new RetainCoordinator({
    credentials,
    clients,
    queueDir: directory,
    logger,
    queueMaxAgeMs: options.age,
    queueMaxItems: options.maxItems,
    queueMaxBytes: options.maxBytes,
  });
  return { coordinator, calls, logger, config };
}

describe("durable quarantine and ordering", () => {
  it("preserves poison A in place, delivers independent B, and holds A's append and replace across restart", async () => {
    enqueue("A", "X");
    enqueue("B", "Y");
    enqueue("A2", "X", { updateMode: "replace" });
    const original = rows()[0];
    const first = stack((content) => {
      if (content === "A") throw http(400);
    });
    await first.coordinator.flushQueues();
    expect(first.calls.map((call) => call.content)).toEqual(["A", "B"]);
    expect(rows()).toEqual([
      expect.objectContaining({ ...original, replayState: { quarantine: "permanent" } }),
      expect.objectContaining({ content: "A2" }),
    ]);
    const restarted = stack();
    expect(
      await restarted.coordinator.retain("main", { content: "A3", documentId: "X", updateMode: "append" }),
    ).toMatchObject({ queued: true });
    expect(await restarted.coordinator.retain("main", { content: "fresh Y", documentId: "Y" })).toMatchObject({
      queued: false,
    });
    await restarted.coordinator.flushQueues();
    expect(restarted.calls.map((call) => call.content)).toEqual(["fresh Y"]);
    expect(rows().map((item) => item.content)).toEqual(["A", "A2", "A3"]);
  });

  it("treats an empty document ID as a dependency and omitted IDs as independent", async () => {
    enqueue("empty", "");
    enqueue("empty successor", "");
    enqueue("omitted");
    enqueue("other omitted");
    const { coordinator, calls } = stack((content) => {
      if (content === "empty" || content === "omitted") throw http(422);
    });
    await coordinator.flushQueues();
    expect(calls.map((call) => call.content)).toEqual(["empty", "omitted", "other omitted"]);
  });

  it("classifies old bank mismatches before expiration without rerouting or blocking another exact bank identity", async () => {
    enqueue("old bank", "X", { createdAt: "2000-01-01T00:00:00Z" });
    enqueue("new bank", "X", { bankId: "new" });
    const { coordinator, calls } = stack(undefined, { bank: "new", age: 1000 });
    await coordinator.flushQueues();
    expect(calls.map(({ bank, content }) => ({ bank, content }))).toEqual([{ bank: "new", content: "new bank" }]);
    expect(rows()).toEqual([
      expect.objectContaining({ content: "old bank", bankId: "bank", replayState: { quarantine: "bank-mismatch" } }),
    ]);
  });

  it("does not expire quarantines or their later dependent writes", async () => {
    enqueue("poison", "X", { createdAt: "2000-01-01T00:00:00Z", replayState: { quarantine: "permanent" } });
    enqueue("dependent", "X", { createdAt: "2000-01-01T00:00:00Z" });
    enqueue("independent expired", "Y", { createdAt: "2000-01-01T00:00:00Z" });
    await stack(undefined, { age: 1000 }).coordinator.flushQueues();
    expect(rows().map((item) => item.content)).toEqual(["poison", "dependent"]);
  });

  it("scans past more than fifty blocked rows and limits actual HTTP attempts to fifty", async () => {
    enqueue("poison", "X", { replayState: { quarantine: "permanent" } });
    for (let index = 0; index < 60; index++) enqueue(`dependent-${index}`, "X");
    for (let index = 0; index < 55; index++) enqueue(`independent-${index}`);
    const { coordinator, calls } = stack();
    await coordinator.flushQueues();
    expect(calls).toHaveLength(50);
    expect(calls[0].content).toBe("independent-0");
    expect(rows()).toHaveLength(66);
    await coordinator.flushQueues();
    expect(calls).toHaveLength(55);
  });

  it("archives corrupt bytes before an ordinal barrier and blocks all later and fresh work", async () => {
    enqueue("earlier", "X");
    const corrupt = 'private broken bytes\n{"content":"unknown identity"}\n';
    appendFileSync(path, corrupt);
    new RetainQueue({ filePath: path }).enqueue("bank", { content: "later", documentId: "Y" });
    const first = stack();
    await first.coordinator.flushQueues();
    expect(first.calls.map((call) => call.content)).toEqual(["earlier"]);
    expect(rows()[0].replayState).toMatchObject({
      quarantine: "corrupt",
      offset: 0,
      length: Buffer.byteLength(corrupt),
    });
    const archive = rows()[0].replayState?.archive;
    expect(readFileSync(join(`${path}.recovery`, `${archive}.jsonl`), "utf8")).toBe(corrupt);
    const restarted = stack(undefined, { age: 0 });
    expect(await restarted.coordinator.retain("main", { content: "fresh", documentId: "Z" })).toMatchObject({
      queued: true,
    });
    await restarted.coordinator.flushQueues();
    expect(restarted.calls).toEqual([]);
    expect(rows().map((item) => item.content)).toEqual(["", "later", "fresh"]);
    expect(readdirSync(`${path}.recovery`).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("rejects duplicate persisted IDs before delivery or mutation", async () => {
    enqueue("first");
    enqueue("second");
    const items = rows();
    items[1].id = items[0].id;
    const original = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
    writeFileSync(path, original);
    const { coordinator, calls } = stack();
    await coordinator.flushQueues();
    expect(calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(original);
    await expect(coordinator.retain("main", { content: "fresh" })).rejects.toThrow("duplicate");
  });

  it("counts quarantined and barrier rows against admission capacity", async () => {
    enqueue("poison", "X", { replayState: { quarantine: "permanent" } });
    const { coordinator } = stack(undefined, { maxItems: 1 });
    await expect(coordinator.retain("main", { content: "dependent", documentId: "X" })).rejects.toMatchObject({
      code: "RETAIN_QUEUE_CAPACITY",
    });
    expect(rows()).toHaveLength(1);
  });
});

describe("principal authorization gates", () => {
  it.each([401, 403])(
    "keeps a %i denial sticky through restart, age limits, and repeated transient failures",
    async (status) => {
      enqueue("denied", "X", { replayAttempts: 4 });
      enqueue("other", "Y");
      const denied = stack(() => {
        throw http(status);
      });
      await denied.coordinator.flushQueues();
      expect(denied.calls.map((call) => call.content)).toEqual(["denied"]);
      expect(rows()[0].replayState).toEqual({ gate: "probe", protected: true });
      const items = rows();
      for (const item of items) item.createdAt = "2000-01-01T00:00:00Z";
      writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
      const transient = stack(
        () => {
          throw http(503);
        },
        { age: 1 },
      );
      expect(await transient.coordinator.retain("main", { content: "fresh", documentId: "Z" })).toMatchObject({
        queued: true,
      });
      expect(transient.calls).toEqual([]);
      for (let index = 0; index < 6; index++) await transient.coordinator.flushQueues();
      expect(transient.calls.map((call) => call.content)).toEqual(Array(6).fill("denied"));
      expect(rows()[0]).toMatchObject({
        replayAttempts: 10,
        operationId: "op-denied",
        replayState: { gate: "probe", protected: true },
      });
      expect(rows()).toHaveLength(3);
      const recovered = stack(undefined, { age: 1 });
      await recovered.coordinator.flushQueues();
      expect(recovered.calls.map((call) => call.content)).toEqual(["denied", "other", "fresh"]);
      expect(rows()).toEqual([]);
    },
  );

  it.each(["permanent", "changed bank"])(
    "requires operator recovery after a denied probe encounters %s",
    async (failure) => {
      enqueue("denied", "X", { replayState: { gate: "probe", protected: true } });
      enqueue("other", "Y");
      const blocked = stack(
        () => {
          throw http(400);
        },
        { bank: failure === "changed bank" ? "new" : "bank" },
      );
      await blocked.coordinator.flushQueues();
      expect(rows()[0].replayState).toMatchObject({
        gate: "operator",
        protected: true,
        quarantine: failure === "changed bank" ? "bank-mismatch" : "permanent",
      });
      expect(blocked.calls).toHaveLength(failure === "changed bank" ? 0 : 1);
      const restarted = stack();
      await restarted.coordinator.flushQueues();
      expect(restarted.calls).toEqual([]);
      expect(await restarted.coordinator.retain("main", { content: "fresh" })).toMatchObject({ queued: true });
    },
  );

  it("does not probe a gate owner past an earlier unknown-identity barrier", async () => {
    writeFileSync(path, "broken\n");
    new RetainQueue({ filePath: path }).enqueue("bank", { content: "denied" });
    new RetainQueue({ filePath: path }).snapshot();
    const items = rows();
    items[1].replayState = { gate: "probe", protected: true };
    writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
    const { coordinator, calls } = stack();
    await coordinator.flushQueues();
    expect(calls).toEqual([]);
  });
});

it("queues concurrent fresh work behind an in-flight predecessor without holding a mutation lock across HTTP", async () => {
  enqueue("first", "X");
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const replay = stack(async (content) => {
    if (content === "first") {
      entered();
      await pending;
    }
  });
  const flushing = replay.coordinator.flushQueues();
  await started;
  const fresh = stack();
  expect(
    await fresh.coordinator.retain("main", { content: "second", documentId: "X", updateMode: "replace" }),
  ).toMatchObject({ queued: true });
  expect(fresh.calls).toEqual([]);
  expect(rows().map((item) => item.content)).toEqual(["first", "second"]);
  release();
  await flushing;
  await fresh.coordinator.flushQueues();
  expect(fresh.calls.map((call) => call.content)).toEqual(["second"]);
  expect(rows()).toEqual([]);
});

it("preserves an uncertain denial across restart, expiration, and fresh admission", async () => {
  enqueue("denied", "X");
  enqueue("backlog", "Y");
  const concurrent = stack();
  const denied = stack(async () => {
    await expect(
      concurrent.coordinator.retain("main", { content: "during HTTP", documentId: "W" }),
    ).resolves.toMatchObject({ queued: true });
    vi.spyOn(RetainQueue.prototype, "setReplayStates").mockImplementationOnce(() => {
      throw new Error("private disk failure");
    });
    throw http(403);
  });
  await denied.coordinator.flushQueues();
  expect(denied.calls.map((call) => call.content)).toEqual(["denied"]);
  vi.restoreAllMocks();
  const items = rows();
  for (const item of items) item.createdAt = "2000-01-01T00:00:00Z";
  writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const restarted = stack(undefined, { age: 1 });
  await restarted.coordinator.flushQueues();
  expect(await restarted.coordinator.retain("main", { content: "fresh", documentId: "Z" })).toMatchObject({
    queued: true,
  });
  await restarted.coordinator.flushQueues();
  expect(restarted.calls).toEqual([]);
  expect(rows().map((item) => item.content)).toEqual(["denied", "backlog", "during HTTP", "fresh"]);
  expect(denied.logger.error.mock.calls.flat().join(" ")).not.toContain("private");
});

it("rechecks durable quarantine after a concurrent routing change is reverted", async () => {
  enqueue("first", "X");
  enqueue("later", "Y");
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const active = stack(async (content) => {
    if (content === "first") {
      entered();
      await pending;
    }
  });
  const flushing = active.coordinator.flushQueues();
  await started;
  active.config.principals.main.writeBank = "new-bank";
  await active.coordinator.retain("main", { content: "fresh", documentId: "Z" });
  expect(rows()[1].replayState?.quarantine).toBe("bank-mismatch");
  active.config.principals.main.writeBank = "bank";
  release();
  await flushing;
  expect(active.calls.map((call) => call.content)).toEqual(["first"]);
  expect(rows().map((item) => item.content)).toEqual(["later", "fresh"]);
});

it("uses the original operation ID after an acknowledgement write fails", async () => {
  enqueue("first", "X");
  enqueue("dependent", "X");
  vi.spyOn(RetainQueue.prototype, "remove").mockImplementationOnce(() => {
    throw new Error("disk failure after HTTP");
  });
  const first = stack();
  await first.coordinator.flushQueues();
  expect(first.calls.map((call) => call.content)).toEqual(["first"]);
  expect(rows()).toHaveLength(2);
  vi.restoreAllMocks();
  const restarted = stack();
  await restarted.coordinator.flushQueues();
  expect(restarted.calls.map((call) => call.content)).toEqual(["first", "dependent"]);
  expect(restarted.calls[0].options?.operationId).toBe(first.calls[0].options?.operationId);
});

it("keeps an operator-retried quarantine protected from transient abandonment", async () => {
  enqueue("repaired", "X", { replayAttempts: 4, replayState: {} });
  const retry = stack(() => {
    throw http(503);
  });
  for (let index = 0; index < 6; index++) await retry.coordinator.flushQueues();
  expect(rows()[0]).toMatchObject({
    content: "repaired",
    replayAttempts: 10,
    operationId: "op-repaired",
    replayState: {},
  });
});

it("counts the successful authorization probe within the fifty-request budget", async () => {
  enqueue("probe", "X", { replayState: { gate: "probe", protected: true } });
  for (let index = 0; index < 55; index++) enqueue(`independent-${index}`);
  const { coordinator, calls } = stack();
  await coordinator.flushQueues();
  expect(calls).toHaveLength(50);
  expect(calls[0].content).toBe("probe");
  expect(rows()).toHaveLength(6);
});

it("does not probe a denied row ahead of a quarantined predecessor for the same document", async () => {
  enqueue("poison", "X", { replayState: { quarantine: "permanent" } });
  enqueue("denied", "X", { replayState: { gate: "probe", protected: true } });
  enqueue("independent", "Y");
  const { coordinator, calls } = stack();
  await coordinator.flushQueues();
  expect(calls).toEqual([]);
  expect(rows()).toHaveLength(3);
});

it.each([
  null,
  [],
  "state",
  { unknown: true },
  { quarantine: {} },
  { quarantine: "other" },
  { gate: "other" },
  { gate: "probe" },
  { protected: false },
  { sending: false },
  { archive: "a" },
  { quarantine: "corrupt", archive: "a", offset: 0, length: 1 },
  { quarantine: "corrupt", archive: "a".repeat(64), offset: -1, length: 1 },
  { quarantine: "corrupt", archive: "a".repeat(64), offset: 0, length: 0 },
])("archives invalid replay state %j as an unknown-identity barrier", async (state) => {
  enqueue("invalid");
  const item = { ...rows()[0], replayState: state };
  const original = `${JSON.stringify(item)}\n`;
  writeFileSync(path, original);
  const { coordinator, calls } = stack();
  await coordinator.flushQueues();
  expect(calls).toEqual([]);
  expect(rows()[0].replayState?.quarantine).toBe("corrupt");
  expect(readFileSync(join(`${path}.recovery`, `${rows()[0].replayState?.archive}.jsonl`), "utf8")).toBe(original);
});

it("keeps a second persisted operator gate closed after the first probe succeeds", async () => {
  enqueue("probe", "X", { replayState: { gate: "probe", protected: true } });
  enqueue("independent", "Y");
  enqueue("operator", "Z", { replayState: { gate: "operator", protected: true, quarantine: "permanent" } });
  const { coordinator, calls } = stack();
  await coordinator.flushQueues();
  expect(calls.map((call) => call.content)).toEqual(["probe"]);
  await coordinator.flushQueues();
  expect(calls).toHaveLength(1);
  expect(rows().map((item) => item.content)).toEqual(["independent", "operator"]);
});

it("classifies a whole changed-bank backlog with one atomic state update", async () => {
  for (let index = 0; index < 64; index++) enqueue(`changed-${index}`, `doc-${index}`);
  const original = rows();
  const updates = vi.spyOn(RetainQueue.prototype, "setReplayStates");
  const { coordinator, calls } = stack(undefined, { bank: "new" });
  await coordinator.flushQueues();
  expect(updates).toHaveBeenCalledTimes(1);
  expect(updates.mock.calls[0][0]).toHaveLength(64);
  expect(rows()).toEqual(original.map((item) => ({ ...item, replayState: { quarantine: "bank-mismatch" } })));
  expect(calls).toEqual([]);
});

it("serializes fresh contenders behind a transiently failing fresh predecessor across coordinators", async () => {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = stack(async () => {
    entered();
    await pending;
    throw http(503);
  });
  const sending = first.coordinator.retain("main", { content: "older", documentId: "X", updateMode: "append" });
  await started;
  const second = stack();
  const contender = second.coordinator.retain("main", { content: "newer", documentId: "X", updateMode: "replace" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(rows()).toEqual([]);
  expect(second.calls).toEqual([]);
  release();
  expect(await sending).toMatchObject({ queued: true });
  expect(await contender).toMatchObject({ queued: true });
  expect(rows().map((item) => item.content)).toEqual(["older", "newer"]);
  const restarted = stack();
  await restarted.coordinator.flushQueues();
  expect(restarted.calls.map((call) => call.content)).toEqual(["older", "newer"]);
  expect(restarted.calls.map((call) => call.options?.updateMode)).toEqual(["append", "replace"]);
});

it("preserves a formerly gated backlog past the recovery batch limit and restart", async () => {
  enqueue("denied", "X");
  for (let index = 0; index < 55; index++) enqueue(`backlog-${index}`);
  await stack(() => {
    throw http(403);
  }).coordinator.flushQueues();
  const items = rows();
  for (const item of items) item.createdAt = "2000-01-01T00:00:00Z";
  writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
  const recovered = stack(undefined, { age: 1 });
  await recovered.coordinator.flushQueues();
  expect(recovered.calls).toHaveLength(50);
  expect(rows()).toHaveLength(6);
  expect(rows().every((item) => item.replayState?.protected)).toBe(true);
  const restarted = stack(undefined, { age: 1 });
  await restarted.coordinator.flushQueues();
  expect(restarted.calls.map((call) => call.content)).toEqual(
    Array.from({ length: 6 }, (_, index) => `backlog-${index + 49}`),
  );
  expect(rows()).toEqual([]);
});

it("keeps fresh work accepted under a gate protected after recovery and transient retries", async () => {
  enqueue("denied", "X", { replayState: { gate: "probe", protected: true } });
  await stack().coordinator.retain("main", { content: "fresh", documentId: "Y" });
  const retry = stack((content) => {
    if (content === "fresh") throw http(503);
  });
  for (let index = 0; index < 6; index++) await retry.coordinator.flushQueues();
  expect(rows()).toEqual([
    expect.objectContaining({ content: "fresh", replayAttempts: 6, replayState: { protected: true } }),
  ]);
});

it("quarantines later writes when routing changes during an earlier replay request", async () => {
  enqueue("first", "X");
  enqueue("later", "Y");
  enqueue("dependent", "Y", { updateMode: "replace" });
  const original = rows();
  const current = stack((content) => {
    if (content === "first") current.config.principals.main.writeBank = "new";
  });
  await current.coordinator.flushQueues();
  expect(current.calls.map((call) => call.content)).toEqual(["first"]);
  expect(rows()).toEqual([
    expect.objectContaining({ ...original[1], replayState: { quarantine: "bank-mismatch" } }),
    original[2],
  ]);
  expect(current.logger.error.mock.calls.flat().join("\n")).toContain("bank mismatch");
  const restarted = stack(undefined, { bank: "new", age: 0 });
  await restarted.coordinator.flushQueues();
  expect(restarted.calls).toEqual([]);
  expect(rows().map((item) => item.content)).toEqual(["later", "dependent"]);
});

it("turns a probe into an operator gate if routing changes while its operation ID is prepared", async () => {
  enqueue("denied", "X", { replayState: { gate: "probe", protected: true } });
  const current = stack();
  const original = RetainQueue.prototype.ensureOperationIds;
  vi.spyOn(RetainQueue.prototype, "ensureOperationIds").mockImplementationOnce(function (
    this: RetainQueue,
    operationIds,
  ) {
    const persisted = original.call(this, operationIds);
    current.config.principals.main.writeBank = "new";
    return persisted;
  });
  await current.coordinator.flushQueues();
  expect(current.calls).toEqual([]);
  expect(rows()[0]).toMatchObject({
    bankId: "bank",
    operationId: "op-denied",
    replayState: { gate: "operator", protected: true, quarantine: "bank-mismatch" },
  });
});

it("rejects a fresh retain if routing changes while delivery preparation is awaited", async () => {
  const current = stack();
  const sending = current.coordinator.retain("main", { content: "fresh", documentId: "X" });
  current.config.principals.main.writeBank = "new";
  await expect(sending).rejects.toMatchObject({ name: "RetainAuthorizationError", bank: "bank" });
  expect(current.calls).toEqual([]);
  expect(rows()).toEqual([]);
});

it("does not abandon a row quarantined while its fifth HTTP attempt is pending", async () => {
  enqueue("older", "X", { replayAttempts: 4 });
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const active = stack(async () => {
    entered();
    await pending;
    throw http(503);
  });
  const flushing = active.coordinator.flushQueues();
  await started;
  active.config.principals.main.writeBank = "new-bank";
  await active.coordinator.retain("main", { content: "fresh", documentId: "Y" });
  expect(rows()[0].replayState?.quarantine).toBe("bank-mismatch");
  release();
  await flushing;
  expect(rows().map((row) => row.content)).toEqual(["older", "fresh"]);
  expect(rows()[0]).toMatchObject({ replayAttempts: 5, replayState: { quarantine: "bank-mismatch" } });
  expect(active.logger.error.mock.calls.flat().join(" ")).not.toContain("abandon");
});

it("reports operator action for an over-cap barrier without sending or accepting fresh work", async () => {
  writeFileSync(path, "x\n");
  const active = stack(undefined, { maxBytes: 300 });
  await active.coordinator.flushQueues();
  expect(active.logger.error.mock.calls.flat().join(" ")).toContain(
    "increase retainQueueMaxBytes or repair the backlog",
  );
  await expect(active.coordinator.retain("main", { content: "fresh" })).rejects.toMatchObject({
    code: "RETAIN_QUEUE_REWRITE_CAPACITY",
  });
  expect(active.calls).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("x\n");
});

it("rejects invalid backlog before appending when another worker holds replay", async () => {
  enqueue("existing", "X");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original + original);
  const invalid = readFileSync(path);
  const active = stack();
  const otherWorker = new RetainQueueStorage(directory);
  await otherWorker.replay(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(active.coordinator.retain("main", { content: "fresh", documentId: "Y" })).rejects.toThrow(
        "duplicate retain queue identity",
      );
      expect(readFileSync(path)).toEqual(invalid);
    }
  });
  expect(active.calls).toEqual([]);
  // Operator repair must not expose work that the caller was told was rejected.
  writeFileSync(path, original);
  await active.coordinator.flushQueues();
  expect(active.calls.map((call) => call.content)).toEqual(["existing"]);
});

it("keeps protection on a fresh row accepted during gated replay contention", async () => {
  enqueue("denied", "X", { replayState: { gate: "probe", protected: true } });
  const active = stack();
  const otherWorker = new RetainQueueStorage(directory);
  await otherWorker.replay(async () => {
    await expect(active.coordinator.retain("main", { content: "fresh", documentId: "X" })).resolves.toMatchObject({
      queued: true,
    });
  });
  expect(active.calls).toEqual([]);
  expect(rows().map((row) => row.content)).toEqual(["denied", "fresh"]);
  expect(rows()[1].replayState).toEqual({ protected: true });
});

it.each(["removed", "invalid"])(
  "clears the unsent marker when routing becomes %s after preparation",
  async (failure) => {
    enqueue("waiting", "X", failure === "invalid" ? { replayState: { gate: "probe", protected: true } } : {});
    const original = rows();
    const active = stack();
    const route = { ...active.config.principals.main };
    const setReplayState = RetainQueue.prototype.setReplayState;
    vi.spyOn(RetainQueue.prototype, "setReplayState").mockImplementationOnce(function (this: RetainQueue, id, state) {
      setReplayState.call(this, id, state);
      expect(rows()[0].replayState?.sending).toBe(true);
      if (failure === "removed") Reflect.deleteProperty(active.config.principals, "main");
      else active.config.principals.main.writeBank = "invalid/bank";
    });
    await active.coordinator.flushQueues();
    expect(active.calls).toEqual([]);
    expect(rows()).toEqual(original);
    active.config.principals.main = route;
    await active.coordinator.flushQueues();
    expect(active.calls.map((call) => call.content)).toEqual(["waiting"]);
    expect(active.calls[0].options?.operationId).toBe("op-waiting");
    expect(rows()).toEqual([]);
  },
);

it("keeps the conservative marker if clearing an unsent request fails", async () => {
  enqueue("waiting", "X");
  const active = stack();
  const setReplayState = RetainQueue.prototype.setReplayState;
  vi.spyOn(RetainQueue.prototype, "setReplayState")
    .mockImplementationOnce(function (this: RetainQueue, id, state) {
      setReplayState.call(this, id, state);
      active.config.principals.main.writeBank = "invalid/bank";
    })
    .mockImplementationOnce(() => {
      throw new Error("private storage failure");
    });
  await active.coordinator.flushQueues();
  expect(active.calls).toEqual([]);
  expect(rows()[0]).toMatchObject({ content: "waiting", operationId: "op-waiting", replayState: { sending: true } });
  active.config.principals.main.writeBank = "bank";
  await active.coordinator.flushQueues();
  expect(active.calls).toEqual([]);
  expect(active.logger.error.mock.calls.flat().join(" ")).not.toContain("private");
});

it("durably assigns every legacy identity before sending and reuses them after a pre-send crash", async () => {
  enqueue("legacy-one", "X", { operationId: undefined });
  enqueue("legacy-two", "Y", { operationId: "" });
  enqueue("existing", "Z");
  const prepare = RetainQueue.prototype.ensureOperationIds;
  vi.spyOn(RetainQueue.prototype, "ensureOperationIds").mockImplementationOnce(function (this: RetainQueue, ids) {
    prepare.call(this, ids);
    throw new Error("crash after durable identity preparation");
  });
  const interrupted = stack();
  await interrupted.coordinator.flushQueues();
  expect(interrupted.calls).toEqual([]);
  const persisted = rows();
  expect(persisted.every((item) => typeof item.operationId === "string" && item.operationId.length > 0)).toBe(true);
  expect(persisted[2].operationId).toBe("op-existing");
  expect(persisted.every((item) => !item.replayState?.sending)).toBe(true);
  vi.restoreAllMocks();
  const restarted = stack();
  await restarted.coordinator.flushQueues();
  expect(restarted.calls.map((call) => call.options?.operationId)).toEqual(persisted.map((item) => item.operationId));
  expect(rows()).toEqual([]);
});

it("preserves a concurrent enqueue when acknowledging a prepared legacy batch", async () => {
  enqueue("legacy", "X", { operationId: undefined });
  enqueue("later", "Y", { operationId: undefined });
  const active = stack(async (content) => {
    if (content !== "legacy") return;
    expect(rows().every((item) => Boolean(item.operationId))).toBe(true);
    await expect(active.coordinator.retain("main", { content: "concurrent", documentId: "X" })).resolves.toMatchObject({
      queued: true,
    });
  });
  await active.coordinator.flushQueues();
  expect(active.calls.map((call) => call.content)).toEqual(["legacy", "later"]);
  expect(rows().map((item) => item.content)).toEqual(["concurrent"]);
  const restarted = stack();
  await restarted.coordinator.flushQueues();
  expect(restarted.calls.map((call) => call.content)).toEqual(["concurrent"]);
});

it("stops after a committed removal reports failure without resurrecting the row", async () => {
  enqueue("first", "X");
  enqueue("dependent", "X");
  const remove = RetainQueue.prototype.remove;
  vi.spyOn(RetainQueue.prototype, "remove").mockImplementationOnce(function (this: RetainQueue, id) {
    remove.call(this, id);
    throw new Error("directory sync acknowledgement failed");
  });
  const active = stack();
  await active.coordinator.flushQueues();
  expect(active.calls.map((call) => call.content)).toEqual(["first"]);
  expect(rows().map((item) => item.content)).toEqual(["dependent"]);
  vi.restoreAllMocks();
  const restarted = stack();
  await restarted.coordinator.flushQueues();
  expect(restarted.calls.map((call) => call.content)).toEqual(["dependent"]);
});

it("preserves every byte when a duplicate identity appears while HTTP is pending", async () => {
  enqueue("first", "X");
  let concurrentBytes = "";
  const active = stack(() => {
    const queued = rows();
    queued.push({
      ...queued[0],
      content: "unsent successor",
      documentId: "Y",
      operationId: "op-unsent",
      replayState: undefined,
    });
    concurrentBytes = `${queued.map((row) => JSON.stringify(row)).join("\n")}\n`;
    writeFileSync(path, concurrentBytes);
  });
  await active.coordinator.flushQueues();
  expect(active.calls.map((call) => call.content)).toEqual(["first"]);
  expect(readFileSync(path, "utf8")).toBe(concurrentBytes);
  expect(rows()[0].replayState?.sending).toBe(true);
  const restarted = stack();
  await restarted.coordinator.flushQueues();
  expect(restarted.calls).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(concurrentBytes);
});

it.each([100, 50 * Buffer.byteLength(`,"operationId":"${"x".repeat(36)}"`)])(
  "replays a near-capacity legacy queue with %i bytes of headroom",
  async (headroom) => {
    for (let index = 0; index < 60; index++) {
      enqueue(`legacy-${index}${"x".repeat(1024)}`, `doc-${index}`, { operationId: undefined });
    }
    const original = readFileSync(path, "utf8");
    const maxBytes = Buffer.byteLength(original) + headroom;
    const prepare = RetainQueue.prototype.ensureOperationIds;
    let plannedIds: ReadonlyMap<string, string> = new Map();
    vi.spyOn(RetainQueue.prototype, "ensureOperationIds").mockImplementationOnce(function (this: RetainQueue, ids) {
      plannedIds = ids;
      expect(() => prepare.call(this, ids)).toThrow(RetainQueueRewriteCapacityError);
      expect(readFileSync(path, "utf8")).toBe(original);
      throw new RetainQueueRewriteCapacityError();
    });
    const active = stack(
      () => {
        expect(Buffer.byteLength(readFileSync(path))).toBeLessThanOrEqual(maxBytes);
      },
      { maxBytes },
    );
    await active.coordinator.flushQueues();
    expect(active.calls).toHaveLength(50);
    expect(active.calls.map((call) => call.options?.operationId)).toEqual([...plannedIds.values()]);
    expect(rows()).toHaveLength(10);
    expect(rows().every((row) => row.operationId === undefined)).toBe(true);
    const restarted = stack(undefined, { maxBytes });
    await restarted.coordinator.flushQueues();
    expect(restarted.calls).toHaveLength(10);
    expect(rows()).toEqual([]);
  },
);

it("prepares only the fifty-request budget before sending a large legacy backlog", async () => {
  for (let index = 0; index < 60; index++) enqueue(`legacy-${index}`, `doc-${index}`, { operationId: undefined });
  const active = stack((content) => {
    if (content !== "legacy-0") return;
    expect(
      rows()
        .slice(0, 50)
        .every((row) => Boolean(row.operationId)),
    ).toBe(true);
    expect(
      rows()
        .slice(50)
        .every((row) => row.operationId === undefined),
    ).toBe(true);
  });
  await active.coordinator.flushQueues();
  expect(active.calls).toHaveLength(50);
  expect(rows()).toHaveLength(10);
});

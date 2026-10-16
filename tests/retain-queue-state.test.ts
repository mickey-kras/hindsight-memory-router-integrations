import { fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { tryLock } from "fs-native-extensions";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetainQueueStorage } from "../src/shared/retain-queue-storage.js";
import { RetainQueue } from "../src/upstream/src/retain-queue.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
vi.mock("fs-native-extensions", () => ({ tryLock: vi.fn() }));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "queue-state-"));
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("keeps an empty queue size cached without rereading the backing file", () => {
  const filePath = join(directory, "queue.jsonl");
  writeFileSync(filePath, "");
  const queue = new RetainQueue({ filePath });
  expect(queue.size()).toBe(0);
  vi.mocked(readFileSync).mockClear();
  expect(queue.size()).toBe(0);
  expect(readFileSync).not.toHaveBeenCalled();
});

it("initializes a persisted queue size lazily and updates it after enqueue and removal", () => {
  const filePath = join(directory, "queue.jsonl");
  new RetainQueue({ filePath }).enqueue("bank", { content: "persisted" });
  const queue = new RetainQueue({ filePath });
  expect(readFileSync).not.toHaveBeenCalled();
  expect(queue.size()).toBe(1);
  queue.enqueue("bank", { content: "new" });
  expect(queue.size()).toBe(2);
  queue.removeMany(queue.peek().map((item) => item.id));
  expect(queue.size()).toBe(0);
});

it("accepts a lock released on the final allowed retry", async () => {
  const lock = vi.mocked(tryLock).mockReturnValue(true);
  for (let attempt = 0; attempt < 30; attempt++) lock.mockReturnValueOnce(false);
  const storage = new RetainQueueStorage(directory);
  await expect(storage.transaction(() => "accepted")).resolves.toBe("accepted");
  expect(lock).toHaveBeenCalledTimes(31);
  expect(setTimeout).toHaveBeenCalledTimes(30);
});

it("rejects after thirty lock waits without running the mutation and closes the descriptor", async () => {
  const lock = vi.mocked(tryLock).mockReturnValue(false);
  const action = vi.fn();
  await expect(new RetainQueueStorage(directory).transaction(action)).rejects.toMatchObject({
    code: "RETAIN_QUEUE_BUSY",
  });
  expect(lock).toHaveBeenCalledTimes(31);
  expect(setTimeout).toHaveBeenCalledTimes(30);
  expect(action).not.toHaveBeenCalled();
  expect(() => fstatSync(lock.mock.calls[0][0])).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("preserves existing operation IDs and validates a batch before any rewrite", () => {
  const filePath = join(directory, "queue.jsonl");
  const queue = new RetainQueue({ filePath });
  queue.enqueue("bank", { content: "legacy" });
  queue.enqueue("bank", { content: "current", operationId: "existing" });
  const [legacy, current] = queue.peek();
  const original = readFileSync(filePath, "utf8");
  expect(() =>
    queue.ensureOperationIds(
      new Map([
        [legacy.id, "new"],
        ["absent", "other"],
      ]),
    ),
  ).toThrow("missing");
  expect(readFileSync(filePath, "utf8")).toBe(original);
  queue.ensureOperationIds(
    new Map([
      [legacy.id, "new"],
      [current.id, "replacement"],
    ]),
  );
  expect(queue.peek().map((item) => item.operationId)).toEqual(["new", "existing"]);
  const duplicate = queue.peek()[0];
  writeFileSync(filePath, `${JSON.stringify(duplicate)}\n${JSON.stringify(duplicate)}\n`);
  expect(() => queue.ensureOperationIds(new Map([[duplicate.id, "other"]]))).toThrow("ambiguous");
});

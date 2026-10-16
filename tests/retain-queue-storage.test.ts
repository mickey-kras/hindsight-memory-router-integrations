import { execFile } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { tryLock } from "fs-native-extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainQueueSharedStorageError, RetainQueueStorage } from "../src/shared/retain-queue-storage.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, closeSync: vi.fn(fs.closeSync) };
});
vi.mock("fs-native-extensions", async (importOriginal) => {
  const native = await importOriginal<typeof import("fs-native-extensions")>();
  return { ...native, tryLock: vi.fn(native.tryLock) };
});

const run = promisify(execFile);
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "queue-capacity-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
const queuePath = () => join(directory, "hindsight-retain-queue.main.jsonl");

describe("aggregate queue capacity", () => {
  it("rejects a single oversized record before creating any queue file", async () => {
    const storage = new RetainQueueStorage(directory, 100, 1000);
    await expect(storage.transaction(() => storage.assertAppend(1000))).rejects.toMatchObject({ limit: "bytes" });
    expect(readdirSync(directory).filter((file) => file.endsWith(".jsonl"))).toEqual([]);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limits: %s", (value) => {
    expect(() => new RetainQueueStorage(directory, value)).toThrow(RangeError);
    expect(() => new RetainQueueStorage(directory, 1, value)).toThrow(RangeError);
  });

  it("counts malformed and unterminated records without parsing payloads", async () => {
    writeFileSync(queuePath(), `${"x".repeat(150000)}\nmalformed`);
    const storage = new RetainQueueStorage(directory, 2, 200000);
    await expect(storage.transaction(() => storage.assertAppend(1))).rejects.toMatchObject({ limit: "items" });
  });

  it("recounts external rewrites and releases capacity after deletion", async () => {
    const storage = new RetainQueueStorage(directory, 2);
    writeFileSync(queuePath(), "one\n");
    await storage.transaction(() => storage.assertAppend(1));
    writeFileSync(queuePath(), "one\ntwo\n");
    await expect(storage.transaction(() => storage.assertAppend(1))).rejects.toMatchObject({ limit: "items" });
    unlinkSync(queuePath());
    await storage.transaction(() => storage.assertAppend(1));
    writeFileSync(queuePath(), "");
    await storage.transaction(() => storage.assertAppend(1));
  });

  it("rejects oversized existing files before reading their contents", async () => {
    writeFileSync(queuePath(), "x".repeat(10000));
    const storage = new RetainQueueStorage(directory, 100, 1000);
    await expect(storage.transaction(() => storage.assertAppend(1))).rejects.toMatchObject({ limit: "bytes" });
  });

  it("reserves replay metadata headroom in the aggregate byte limit", async () => {
    writeFileSync(queuePath(), "a\n");
    const storage = new RetainQueueStorage(directory, 10, 514);
    await storage.transaction(() => storage.assertAppend(0));
    await expect(storage.transaction(() => storage.assertAppend(1))).rejects.toMatchObject({ limit: "bytes" });
  });

  it("rejects a contended writer after bounded retries and keeps lock errors typed", async () => {
    const storage = new RetainQueueStorage(directory);
    const fd = openSync(join(directory, ".retain-queue.lock"), "a", 0o600);
    expect(tryLock(fd)).toBe(true);
    try {
      await expect(storage.transaction(() => undefined)).rejects.toMatchObject({
        name: "RetainQueueBusyError",
        code: "RETAIN_QUEUE_BUSY",
      });
    } finally {
      closeSync(fd);
    }
    rmSync(directory, { recursive: true });
    await expect(storage.transaction(() => undefined)).rejects.toMatchObject({
      name: "RetainQueueSharedStorageError",
      cause: { code: "ENOENT" },
    });
    await expect(storage.replay(async () => undefined)).rejects.toMatchObject({
      name: "RetainQueueSharedStorageError",
      cause: { code: "ENOENT" },
    });
  });

  it.each([new RangeError("oversized queue"), Object.assign(new Error("queue I/O failed"), { code: "EIO" })])(
    "preserves queue callback error identity: %s",
    async (error) => {
      const storage = new RetainQueueStorage(directory);
      expect(error).not.toBeInstanceOf(RetainQueueSharedStorageError);
      await expect(
        storage.transaction(() => {
          throw error;
        }),
      ).rejects.toBe(error);
      await expect(
        storage.replay(async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      await expect(storage.transaction(() => "released")).resolves.toBe("released");
      await expect(storage.replay(async () => "released")).resolves.toBe("released");
    },
  );

  it.each(["transaction", "replay"] as const)(
    "classifies %s lock acquisition and release failures as shared",
    async (method) => {
      const storage = new RetainQueueStorage(directory);
      const cause = Object.assign(new Error("private filesystem error"), { code: "EIO" });
      const action = vi.fn(() => "completed");
      const perform = () =>
        method === "transaction" ? storage.transaction(action) : storage.replay(async () => action());
      vi.mocked(tryLock).mockImplementationOnce(() => {
        throw cause;
      });
      await expect(perform()).rejects.toMatchObject({
        name: "RetainQueueSharedStorageError",
        message: "retain queue shared storage unavailable",
        cause,
      });
      expect(action).not.toHaveBeenCalled();

      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      action.mockImplementationOnce(() => {
        vi.mocked(closeSync).mockImplementationOnce((fd) => {
          fs.closeSync(fd);
          throw cause;
        });
        return "completed";
      });
      await expect(perform()).rejects.toMatchObject({
        name: "RetainQueueSharedStorageError",
        message: "retain queue shared storage unavailable",
        cause,
      });
      expect(action).toHaveBeenCalledOnce();
      await expect(perform()).resolves.toBe("completed");
    },
  );

  it("excludes a second replayer while allowing capacity transactions", async () => {
    const storage = new RetainQueueStorage(directory);
    await storage.replay(async () => {
      expect(await storage.replay(async () => "duplicate")).toBeUndefined();
      await storage.transaction(() => storage.assertAppend(1));
    });
    expect(await storage.replay(async () => "released")).toBe("released");
  });

  it("does not oversubscribe aggregate capacity when separate processes enqueue concurrently", async () => {
    const moduleUrl = new URL("../src/shared/retain-queue-storage.ts", import.meta.url).href;
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        run(process.execPath, [
          "--experimental-transform-types",
          "--experimental-loader",
          new URL("./helpers/typescript-source-loader.mjs", import.meta.url).href,
          "--input-type=module",
          "-e",
          `
        import { appendFileSync } from "node:fs";
        import { RetainQueueStorage } from ${JSON.stringify(moduleUrl)};
        const storage = new RetainQueueStorage(${JSON.stringify(directory)}, 4, 100000);
        const file = ${JSON.stringify(join(directory, `hindsight-retain-queue.agent-${index}.jsonl`))};
        for (let i = 0; i < 4; i++) {
          try {
            await storage.transaction(() => {
              storage.assertAppend(2);
              appendFileSync(file, "x\\n", { mode: 0o600 });
              storage.didAppend(file);
            });
          } catch (error) { if (error.code !== "RETAIN_QUEUE_CAPACITY") throw error; }
        }
      `,
        ]),
      ),
    );
    const records = readdirSync(directory)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readFileSync(join(directory, file), "utf8").trim().split("\n"));
    expect(records).toHaveLength(4);
  });

  it("tracks local appends without reparsing the existing backlog", async () => {
    const storage = new RetainQueueStorage(directory, 2);
    for (let index = 0; index < 2; index++) {
      await storage.transaction(() => {
        storage.assertAppend(2);
        appendFileSync(queuePath(), "x\n");
        storage.didAppend(queuePath());
      });
    }
    await expect(storage.transaction(() => storage.assertAppend(2))).rejects.toMatchObject({ limit: "items" });
  });
});

it("rejects a fresh admission contender after bounded contention and releases its descriptor", async () => {
  const storage = new RetainQueueStorage(directory);
  const fd = openSync(join(directory, ".retain-admission.lock"), "a", 0o600);
  expect(tryLock(fd)).toBe(true);
  const contender = vi.fn(async () => "accepted");
  try {
    await expect(storage.admission(contender)).rejects.toMatchObject({ code: "RETAIN_QUEUE_BUSY" });
    expect(contender).not.toHaveBeenCalled();
  } finally {
    closeSync(fd);
  }
  expect(await storage.admission(contender)).toBe("accepted");
  expect(contender).toHaveBeenCalledTimes(1);
});

import { closeSync, constants, fstatSync, readdirSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { tryLock } from "fs-native-extensions";
import { assertQueuePlatform, openPrivateQueueFile, removePrivateQueueFile } from "./private-queue-files.js";

export const QUEUE_FILE_PREFIX = "hindsight-retain-queue.";
export const QUEUE_FILE_SUFFIX = ".jsonl";
export const DEFAULT_QUEUE_MAX_ITEMS = 1000;
export const DEFAULT_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const REPLAY_METADATA_BYTES = 256;

export class RetainQueueCapacityError extends Error {
  readonly code = "RETAIN_QUEUE_CAPACITY";
  constructor(readonly limit: "items" | "bytes") {
    super(`retain queue ${limit} capacity exceeded; retain was not queued`);
    this.name = "RetainQueueCapacityError";
  }
}

export class RetainQueueSharedStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetainQueueSharedStorageError";
  }
}

export class RetainQueueBusyError extends RetainQueueSharedStorageError {
  readonly code = "RETAIN_QUEUE_BUSY";
  constructor(options?: ErrorOptions) {
    super("retain queue is busy; retain was not queued", options);
    this.name = "RetainQueueBusyError";
  }
}

function sharedStorageOperation<T>(action: () => T): T {
  try {
    return action();
  } catch (cause) {
    throw new RetainQueueSharedStorageError("retain queue shared storage unavailable", { cause });
  }
}

interface QueueUsage {
  signature: string;
  bytes: number;
  items: number;
}

function fileSignature(filePath: string): { signature: string; bytes: number } {
  const fd = openPrivateQueueFile(filePath, constants.O_RDONLY);
  try {
    const info = fstatSync(fd, { bigint: true });
    return {
      signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      bytes: Number(info.size),
    };
  } finally {
    closeSync(fd);
  }
}

function countRecords(filePath: string): number {
  const fd = openPrivateQueueFile(filePath, constants.O_RDONLY);
  const buffer = Buffer.alloc(64 * 1024);
  let count = 0;
  let lastByte = 10;
  try {
    for (let bytes = readSync(fd, buffer); bytes > 0; bytes = readSync(fd, buffer)) {
      for (let index = 0; index < bytes; index++) if (buffer[index] === 10) count++;
      lastByte = buffer[bytes - 1];
    }
  } finally {
    closeSync(fd);
  }
  return count + (lastByte === 10 ? 0 : 1);
}

export class RetainQueueStorage {
  private readonly usage = new Map<string, QueueUsage>();

  constructor(
    private readonly directory: string,
    readonly maxItems = DEFAULT_QUEUE_MAX_ITEMS,
    readonly maxBytes = DEFAULT_QUEUE_MAX_BYTES,
  ) {
    this.directory = resolve(directory);
    for (const [key, value] of [
      ["queueMaxItems", maxItems],
      ["queueMaxBytes", maxBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive integer`);
    }
  }

  async transaction<T>(action: () => T): Promise<T> {
    const fd = sharedStorageOperation(() =>
      openPrivateQueueFile(
        join(this.directory, ".retain-queue.lock"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      ),
    );
    try {
      let attempt = 0;
      while (!sharedStorageOperation(() => tryLock(fd))) {
        if (attempt === 30) throw new RetainQueueBusyError();
        await setTimeout(100);
        attempt++;
      }
      sharedStorageOperation(() => {
        for (const name of readdirSync(this.directory)) {
          if (name.startsWith(QUEUE_FILE_PREFIX) && name.includes(`${QUEUE_FILE_SUFFIX}.`) && name.endsWith(".tmp")) {
            removePrivateQueueFile(join(this.directory, name));
          }
        }
      });
      // Queue-specific failures must keep their identity for per-principal isolation.
      return action();
    } finally {
      sharedStorageOperation(() => closeSync(fd));
    }
  }

  async admission<T>(action: () => Promise<T>): Promise<T> {
    return (await this.deliveryLock(".retain-admission.lock", action, true)) as T;
  }

  async replay<T>(action: () => Promise<T>): Promise<T | undefined> {
    return this.deliveryLock(".retain-replay.lock", action, false);
  }

  private async deliveryLock<T>(name: string, action: () => Promise<T>, wait: boolean): Promise<T | undefined> {
    const fd = sharedStorageOperation(() =>
      openPrivateQueueFile(join(this.directory, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT),
    );
    try {
      let attempt = 0;
      while (!sharedStorageOperation(() => tryLock(fd))) {
        if (!wait) return undefined;
        if (attempt++ === 30) throw new RetainQueueBusyError();
        await setTimeout(100);
      }
      return await action();
    } finally {
      sharedStorageOperation(() => closeSync(fd));
    }
  }

  assertAppend(bytes: number): void {
    assertQueuePlatform();
    const files = readdirSync(this.directory)
      .filter((name) => name.startsWith(QUEUE_FILE_PREFIX) && name.endsWith(QUEUE_FILE_SUFFIX))
      .map((name) => join(this.directory, name));
    const existing = new Set(files);
    for (const file of this.usage.keys()) if (!existing.has(file)) this.usage.delete(file);
    let totalBytes = bytes + REPLAY_METADATA_BYTES;
    if (totalBytes > this.maxBytes) throw new RetainQueueCapacityError("bytes");
    let totalItems = 1;
    for (const file of files) {
      const info = fileSignature(file);
      totalBytes += info.bytes;
      if (totalBytes > this.maxBytes) throw new RetainQueueCapacityError("bytes");
      let usage = this.usage.get(file);
      if (usage?.signature !== info.signature) {
        usage = { ...info, items: countRecords(file) };
        this.usage.set(file, usage);
      }
      totalItems += usage.items;
      totalBytes += usage.items * REPLAY_METADATA_BYTES;
      if (totalItems > this.maxItems) throw new RetainQueueCapacityError("items");
      if (totalBytes > this.maxBytes) throw new RetainQueueCapacityError("bytes");
    }
  }

  didAppend(filePath: string): void {
    const prior = this.usage.get(filePath);
    this.usage.set(filePath, { ...fileSignature(filePath), items: (prior?.items ?? 0) + 1 });
  }
}

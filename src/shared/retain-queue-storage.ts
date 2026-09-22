import { closeSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { tryLock } from "fs-native-extensions";

export const QUEUE_FILE_PREFIX = "hindsight-retain-queue.";
export const QUEUE_FILE_SUFFIX = ".jsonl";
export const DEFAULT_QUEUE_MAX_ITEMS = 1000;
export const DEFAULT_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const REPLAY_METADATA_BYTES = 128;

export class RetainQueueCapacityError extends Error {
  readonly code = "RETAIN_QUEUE_CAPACITY";
  constructor(readonly limit: "items" | "bytes") {
    super(`retain queue ${limit} capacity exceeded; retain was not queued`);
    this.name = "RetainQueueCapacityError";
  }
}

export class RetainQueueBusyError extends Error {
  readonly code = "RETAIN_QUEUE_BUSY";
  constructor(options?: ErrorOptions) {
    super("retain queue is busy; retain was not queued", options);
    this.name = "RetainQueueBusyError";
  }
}

interface QueueUsage {
  signature: string;
  bytes: number;
  items: number;
}

function fileSignature(filePath: string): { signature: string; bytes: number } {
  const info = statSync(filePath, { bigint: true });
  return {
    signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    bytes: Number(info.size),
  };
}

function countRecords(filePath: string): number {
  const fd = openSync(filePath, "r");
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
    for (const [key, value] of [
      ["queueMaxItems", maxItems],
      ["queueMaxBytes", maxBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${key} must be a positive integer`);
    }
  }

  async transaction<T>(action: () => T): Promise<T> {
    const fd = openSync(join(this.directory, ".retain-queue.lock"), "a", 0o600);
    try {
      let attempt = 0;
      while (!tryLock(fd)) {
        if (attempt === 30) throw new RetainQueueBusyError();
        await setTimeout(100);
        attempt++;
      }
      for (const name of readdirSync(this.directory)) {
        if (name.startsWith(QUEUE_FILE_PREFIX) && name.endsWith(`${QUEUE_FILE_SUFFIX}.tmp`)) {
          unlinkSync(join(this.directory, name));
        }
      }
      return action();
    } finally {
      closeSync(fd);
    }
  }

  async replay<T>(action: () => Promise<T>): Promise<T | undefined> {
    const fd = openSync(join(this.directory, ".retain-replay.lock"), "a", 0o600);
    try {
      if (!tryLock(fd)) return undefined;
      return await action();
    } finally {
      closeSync(fd);
    }
  }

  assertAppend(bytes: number): void {
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

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { lock } from "proper-lockfile";

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
  constructor(options: ErrorOptions) {
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
    let release: () => Promise<void>;
    try {
      release = await lock(this.directory, {
        lockfilePath: join(this.directory, ".retain-queue.lock"),
        retries: { retries: 30, minTimeout: 10, maxTimeout: 100, factor: 1.3 },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new RetainQueueBusyError({ cause: error });
      throw error;
    }
    try {
      return action();
    } finally {
      await release();
    }
  }

  async replay<T>(principalId: string, action: () => Promise<T>): Promise<T | undefined> {
    let release: () => Promise<void>;
    try {
      release = await lock(join(realpathSync(this.directory), `.retain-replay.${principalId}`), { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
      throw error;
    }
    try {
      return await action();
    } finally {
      await release();
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

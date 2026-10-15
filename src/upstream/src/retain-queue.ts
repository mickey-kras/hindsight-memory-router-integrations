/**
 * JSONL-backed retain queue for buffering failed HTTP retains.
 *
 * When the Hindsight API is unreachable, retain requests are stashed in a local
 * JSONL file and flushed later. Used in both modes: a locally spawned daemon is
 * just as unreachable while it boots or after it crashes as a remote API is.
 *
 * Zero runtime dependencies; uses only Node built-ins.
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  statSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { dirname, join } from "node:path";

/** The subset of a retain payload the queue needs to persist and replay. */
export interface QueuedRetainPayload {
  content: string;
  documentId?: string;
  context?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  operationId?: string;
  updateMode?: "replace" | "append";
}

export interface QueuedRetain {
  id: string;
  bankId: string;
  content: string;
  documentId?: string;
  context?: string;
  metadata: Record<string, unknown>;
  tags?: string[];
  operationId?: string;
  updateMode?: "replace" | "append";
  createdAt: string; // ISO 8601
  replayAttempts?: number;
}

export interface RetainQueueCorruption {
  malformedJson: number;
  invalidShape: number;
}

interface QueueContents {
  items: QueuedRetain[];
  corrupt: Buffer[];
  counts: RetainQueueCorruption;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueuedRetain(value: unknown): value is QueuedRetain {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.bankId === "string" &&
    value.bankId.length > 0 &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isRecord(value.metadata) &&
    [value.documentId, value.context, value.operationId].every(
      (field) => field === undefined || typeof field === "string",
    ) &&
    (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === "string"))) &&
    (value.updateMode === undefined || value.updateMode === "append" || value.updateMode === "replace") &&
    (value.replayAttempts === undefined ||
      (typeof value.replayAttempts === "number" &&
        Number.isSafeInteger(value.replayAttempts) &&
        value.replayAttempts >= 0 &&
        value.replayAttempts < Number.MAX_SAFE_INTEGER))
  );
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface RetainQueueOptions {
  /** Path to the JSONL queue file. The parent directory must already exist. */
  filePath: string;
  /** Max age in ms for queued items. `-1` (default) keeps items forever. */
  maxAgeMs?: number;
  maxReadBytes?: number;
  /** Counts only; called after corrupt records are durably preserved. */
  onCorruption?: (counts: RetainQueueCorruption) => void;
  capacity?: {
    assertAppend(bytes: number): void;
    didAppend(filePath: string): void;
  };
}

export class RetainQueue {
  private readonly filePath: string;
  private readonly maxAgeMs: number;
  private cachedSize: number | undefined;
  private readonly options: RetainQueueOptions;

  constructor(opts: RetainQueueOptions) {
    this.filePath = opts.filePath;
    this.maxAgeMs = opts.maxAgeMs ?? -1;
    this.options = opts;
  }

  /** Append a failed retain for later delivery. */
  enqueue(bankId: string, request: QueuedRetainPayload, metadata?: Record<string, unknown>): void {
    const item: QueuedRetain = {
      id: `${Date.now()}-${randomBytes(4).toString("hex")}`,
      bankId,
      content: request.content,
      documentId: request.documentId,
      context: request.context,
      metadata: metadata || request.metadata || {},
      tags: request.tags,
      operationId: request.operationId,
      updateMode: request.updateMode,
      createdAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(item) + "\n";
    // A torn final write must not absorb the next accepted JSONL record.
    if (this.hasUnterminatedRecord()) {
      const contents = this.readAll();
      this.writeAll(contents.items, contents);
    }
    this.options.capacity?.assertAppend(Buffer.byteLength(serialized));
    appendFileSync(this.filePath, serialized, { encoding: "utf8", mode: 0o600 });
    this.options.capacity?.didAppend(this.filePath);
    if (this.cachedSize !== undefined) this.cachedSize++;
  }

  /** Get up to `limit` oldest pending items (FIFO). */
  peek(limit = 50): QueuedRetain[] {
    return this.readAll().items.slice(0, limit);
  }

  /** Remove a single item by id. */
  remove(id: string): void {
    this.removeMany([id]);
  }

  /** Remove multiple items by id in a single file rewrite. */
  removeMany(ids: string[]): void {
    const idSet = new Set(ids);
    const contents = this.readAll();
    this.writeAll(
      contents.items.filter((i) => !idSet.has(i.id)),
      contents,
    );
  }

  /** Persist a replay identity before the request is sent. */
  ensureOperationId(id: string, operationId: string): string {
    const contents = this.readAll();
    const item = contents.items.find((queued) => queued.id === id);
    if (!item) {
      throw new Error(`queued retain not found: ${id}`);
    }
    if (typeof item.operationId === "string" && item.operationId.length > 0) {
      return item.operationId;
    }
    item.operationId = operationId;
    // The synchronous atomic rewrite must complete before the caller can send
    // the request; otherwise another lost acknowledgement would lose this ID.
    this.writeAll(contents.items, contents);
    return operationId;
  }

  incrementReplayAttempts(id: string): number {
    const contents = this.readAll();
    const item = contents.items.find((queued) => queued.id === id);
    if (!item) throw new Error(`queued retain not found: ${id}`);
    item.replayAttempts = (item.replayAttempts ?? 0) + 1;
    this.writeAll(contents.items, contents);
    return item.replayAttempts;
  }

  /** Number of items waiting (cached, O(1)). */
  size(): number {
    this.cachedSize ??= this.readAll().items.length;
    return this.cachedSize;
  }

  /** Drop items older than `maxAgeMs`. No-op when `maxAgeMs < 0`. */
  cleanup(): number {
    if (this.maxAgeMs < 0) return 0;
    const cutoff = Date.now() - this.maxAgeMs;
    const contents = this.readAll();
    const kept = contents.items.filter((i) => new Date(i.createdAt).getTime() >= cutoff);
    const removed = contents.items.length - kept.length;
    if (removed > 0) this.writeAll(kept, contents);
    return removed;
  }

  /** No-op — kept for API symmetry with DB-backed queues. */
  close(): void {
    /* nothing to close */
  }

  private hasUnterminatedRecord(): boolean {
    if (!existsSync(this.filePath)) return false;
    const size = statSync(this.filePath).size;
    if (size === 0) return false;
    const fd = openSync(this.filePath, "r");
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 10;
    } finally {
      closeSync(fd);
    }
  }

  private readAll(): QueueContents {
    const result: QueueContents = { items: [], corrupt: [], counts: { malformedJson: 0, invalidShape: 0 } };
    if (!existsSync(this.filePath)) return result;
    if (this.options.maxReadBytes !== undefined && statSync(this.filePath).size > this.options.maxReadBytes) {
      throw new RangeError(
        "retain queue exceeds configured byte limit; increase the limit to replay this legacy backlog",
      );
    }
    const content = readFileSync(this.filePath);
    for (let start = 0; start < content.length; ) {
      const newline = content.indexOf(10, start);
      const end = newline < 0 ? content.length : newline + 1;
      const raw = content.subarray(start, end);
      start = end;
      let item: unknown;
      try {
        if (!isUtf8(raw)) throw new TypeError("invalid UTF-8");
        item = JSON.parse(raw.toString("utf8"));
      } catch {
        result.corrupt.push(raw);
        result.counts.malformedJson++;
        continue;
      }
      if (isQueuedRetain(item)) result.items.push(item);
      else {
        result.corrupt.push(raw);
        result.counts.invalidShape++;
      }
    }
    return result;
  }

  private preserveCorruptRecords(contents: QueueContents): void {
    if (contents.corrupt.length === 0) return;
    // Preserve the complete sequence, including duplicate records and original
    // line endings. Its content hash makes retries after a failed rewrite safe.
    const bytes = Buffer.concat(contents.corrupt);
    const recoveryDir = `${this.filePath}.recovery`;
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(recoveryDir).isDirectory()) throw new Error("retain recovery path must be a directory");
    const directoryFd = openSync(recoveryDir, "r");
    try {
      fchmodSync(directoryFd, 0o700);
    } finally {
      closeSync(directoryFd);
    }
    const recoveryPath = join(recoveryDir, `${createHash("sha256").update(bytes).digest("hex")}.jsonl`);
    if (!existsSync(recoveryPath)) {
      const tmpPath = join(recoveryDir, "pending.tmp");
      const fd = openSync(tmpPath, "w", 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, recoveryPath);
    }
    if (!lstatSync(recoveryPath).isFile() || !readFileSync(recoveryPath).equals(bytes)) {
      throw new Error("retain recovery record does not match queued bytes");
    }
    const fd = openSync(recoveryPath, "r");
    try {
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(recoveryDir);
    syncDirectory(dirname(recoveryDir));
    this.options.onCorruption?.(contents.counts);
  }

  /** Atomically rewrite the file with the given items. */
  private writeAll(items: QueuedRetain[], contents: QueueContents): void {
    this.preserveCorruptRecords(contents);
    if (items.length === 0) {
      try {
        unlinkSync(this.filePath);
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      this.cachedSize = 0;
      return;
    }
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, this.filePath);
    this.cachedSize = items.length;
  }
}

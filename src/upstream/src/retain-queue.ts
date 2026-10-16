/**
 * JSONL-backed retain queue for buffering failed HTTP retains.
 *
 * When the Hindsight API is unreachable, retain requests are stashed in a local
 * JSONL file and flushed later. Used in both modes: a locally spawned daemon is
 * just as unreachable while it boots or after it crashes as a remote API is.
 *
 * Zero runtime dependencies; uses only Node built-ins.
 */

import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  isMissingQueueFile,
  openPrivateQueueDirectory,
  openPrivateQueueFile,
  privateQueueDirectory,
  removePrivateQueueFile,
  writePrivateQueueFile,
} from "../../shared/private-queue-files.js";

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
  source: string;
  bytes: Buffer;
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

function isBlankQueueRecord(content: Buffer, start: number, end: number): boolean {
  let first = start;
  while (
    first < end &&
    (content[first] === 9 || content[first] === 10 || content[first] === 13 || content[first] === 32)
  )
    first++;
  return first === end;
}

function syncDirectory(directory: string): void {
  const fd = openPrivateQueueDirectory(directory);
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
    this.filePath = resolve(opts.filePath);
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
    const fd = openPrivateQueueFile(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    try {
      appendFileSync(fd, serialized, "utf8");
    } finally {
      closeSync(fd);
    }
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
    let fd: number;
    try {
      fd = openPrivateQueueFile(this.filePath, constants.O_RDONLY);
    } catch (error) {
      if (isMissingQueueFile(error)) return false;
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 10;
    } finally {
      closeSync(fd);
    }
  }

  private readContents(): QueueContents {
    const result: QueueContents = {
      items: [],
      source: "",
      bytes: Buffer.alloc(0),
      counts: { malformedJson: 0, invalidShape: 0 },
    };
    let fd: number;
    try {
      fd = openPrivateQueueFile(this.filePath, constants.O_RDONLY);
    } catch (error) {
      if (isMissingQueueFile(error)) return result;
      throw error;
    }
    try {
      const info = fstatSync(fd, { bigint: true });
      if (this.options.maxReadBytes !== undefined && info.size > BigInt(this.options.maxReadBytes)) {
        throw new RangeError(
          "retain queue exceeds configured byte limit; increase the limit to replay this legacy backlog",
        );
      }
      result.source = createHash("sha256").update(`${info.dev}:${info.ino}:${info.birthtimeNs}`).digest("hex");
      result.bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    return result;
  }

  private readAll(): QueueContents {
    const result = this.readContents();
    const content = result.bytes;
    // Adjacent corrupt records share a range: even millions of blank lines
    // need one range. Only intervening valid records can increase this list.
    const ranges: number[] = [];
    let corruptBytes = 0;
    const preserveRange = (start: number, end: number): void => {
      if (ranges.at(-1) === start) ranges[ranges.length - 1] = end;
      else ranges.push(start, end);
      corruptBytes += end - start;
    };
    for (let start = 0; start < content.length; ) {
      const newline = content.indexOf(10, start);
      const end = newline < 0 ? content.length : newline + 1;
      if (isBlankQueueRecord(content, start, end)) {
        result.counts.malformedJson++;
        preserveRange(start, end);
        start = end;
        continue;
      }
      const raw = content.subarray(start, end);
      const recordStart = start;
      start = end;
      let item: unknown;
      try {
        if (!isUtf8(raw)) throw new TypeError("invalid UTF-8");
        item = JSON.parse(raw.toString("utf8"));
      } catch {
        result.counts.malformedJson++;
        preserveRange(recordStart, end);
        continue;
      }
      if (isQueuedRetain(item)) result.items.push(item);
      else {
        result.counts.invalidShape++;
        preserveRange(recordStart, end);
      }
    }
    result.bytes = Buffer.alloc(corruptBytes);
    let offset = 0;
    for (let index = 0; index < ranges.length; index += 2) {
      offset += content.copy(result.bytes, offset, ranges[index], ranges[index + 1]);
    }
    return result;
  }

  private preserveCorruptRecords(contents: QueueContents): void {
    if (contents.counts.malformedJson + contents.counts.invalidShape === 0) return;
    // Keep only corrupt bytes, their order and duplicate occurrences in one
    // snapshot per source inode/generation. A retry after an append extends
    // that snapshot rather than duplicating bytes in a second artifact.
    const recoveryDir = `${this.filePath}.recovery`;
    privateQueueDirectory(recoveryDir, true);
    // The caller holds the queue mutation lock. Clean only our unfinished
    // snapshots, without scanning committed archives or following symlinks.
    const pendingDir = join(recoveryDir, "pending");
    privateQueueDirectory(pendingDir, true);
    for (const entry of readdirSync(pendingDir, { withFileTypes: true })) {
      if (entry.isFile() && /^retain-[a-f0-9]{32}\.tmp$/.test(entry.name)) {
        removePrivateQueueFile(join(pendingDir, entry.name));
      }
    }
    const recoveryPath = join(recoveryDir, `${contents.source}.jsonl`);
    let priorLength = 0;
    let priorFd: number | undefined;
    try {
      priorFd = openPrivateQueueFile(recoveryPath, constants.O_RDONLY);
    } catch (error) {
      if (!isMissingQueueFile(error)) throw error;
    }
    if (priorFd !== undefined) {
      try {
        if (fstatSync(priorFd).size > contents.bytes.length)
          throw new Error("retain recovery snapshot does not match queued bytes");
        const prior = readFileSync(priorFd);
        if (prior.length > contents.bytes.length || !contents.bytes.subarray(0, prior.length).equals(prior)) {
          throw new Error("retain recovery snapshot does not match queued bytes");
        }
        priorLength = prior.length;
      } finally {
        closeSync(priorFd);
      }
    }
    if (priorLength !== contents.bytes.length) {
      const tmpPath = join(pendingDir, `retain-${randomBytes(16).toString("hex")}.tmp`);
      const fd = openPrivateQueueFile(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        try {
          writeFileSync(fd, contents.bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, recoveryPath);
      } finally {
        removePrivateQueueFile(tmpPath);
      }
    }
    // Flush the committed snapshot before replacing or removing the active queue.
    const fd = openPrivateQueueFile(recoveryPath, constants.O_RDWR);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(pendingDir);
    syncDirectory(recoveryDir);
    syncDirectory(dirname(recoveryDir));
    this.options.onCorruption?.(contents.counts);
  }

  /** Atomically rewrite the file with the given items. */
  private writeAll(items: QueuedRetain[], contents: QueueContents): void {
    this.preserveCorruptRecords(contents);
    if (items.length === 0) {
      removePrivateQueueFile(this.filePath);
      this.cachedSize = 0;
      return;
    }
    writePrivateQueueFile(this.filePath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
    this.cachedSize = items.length;
  }
}

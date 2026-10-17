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

export interface RetainReplayState {
  quarantine?: "permanent" | "bank-mismatch" | "corrupt";
  gate?: "probe" | "operator";
  /** An HTTP outcome is not yet durably classified; operator recovery is required after restart. */
  sending?: true;
  /** Sticky after a denial, including subsequent transient failures. */
  protected?: true;
  /** Corrupt bytes live in this recovery snapshot, never in a synthetic payload. */
  archive?: string;
  offset?: number;
  length?: number;
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
  replayState?: RetainReplayState;
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

function isReplayState(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) => !["quarantine", "gate", "sending", "protected", "archive", "offset", "length"].includes(key))
  )
    return false;
  if (
    value.quarantine !== undefined &&
    value.quarantine !== "permanent" &&
    value.quarantine !== "bank-mismatch" &&
    value.quarantine !== "corrupt"
  )
    return false;
  if (value.gate !== undefined && value.gate !== "probe" && value.gate !== "operator") return false;
  if (value.sending !== undefined && value.sending !== true) return false;
  if (value.protected !== undefined && value.protected !== true) return false;
  if (value.gate !== undefined && value.protected !== true) return false;
  return hasValidReplayArchive(value);
}

function hasValidReplayArchive(value: Record<string, unknown>): boolean {
  if (value.quarantine === "corrupt") {
    return (
      typeof value.archive === "string" &&
      /^[a-f0-9]{64}$/.test(value.archive) &&
      Number.isSafeInteger(value.offset) &&
      Number(value.offset) >= 0 &&
      Number.isSafeInteger(value.length) &&
      Number(value.length) > 0
    );
  }
  return value.archive === undefined && value.offset === undefined && value.length === undefined;
}

/** Exact identity: omitted document IDs are independent, including from each other. */
export function sameRetainDocument(left: QueuedRetain, right: { bankId: string; documentId?: string }): boolean {
  return (
    left.documentId !== undefined &&
    right.documentId !== undefined &&
    left.bankId === right.bankId &&
    left.documentId === right.documentId
  );
}

function isQueuedRetain(value: unknown): value is QueuedRetain {
  if (!isRecord(value)) return false;
  return (
    isReplayState(value.replayState) &&
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

function assertUniqueIdentities(items: QueuedRetain[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error("duplicate retain queue identity; operator repair required");
    ids.add(item.id);
  }
}

/** Reserve the largest durable HTTP outcome, including principal-wide denial protection. */
function replayOutcomeHeadroom(items: QueuedRetain[]): number {
  let protectionBytes = 0;
  let gateBytes = 0;
  let outcomeBytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    const { sending: _sending, ...completed } = item.replayState ?? {};
    const protectedItem = { ...item, replayState: { ...completed, protected: true } };
    const protectedSize = Buffer.byteLength(JSON.stringify(protectedItem));
    protectionBytes += protectedSize - size;
    gateBytes = Math.max(
      gateBytes,
      Buffer.byteLength(
        JSON.stringify({
          ...protectedItem,
          replayState: { ...protectedItem.replayState, gate: "probe" },
        }),
      ) - protectedSize,
    );
    const sending = { ...item, replayState: { ...item.replayState, sending: true } };
    const transient = {
      ...sending,
      replayAttempts: Math.min((item.replayAttempts ?? 0) + 1, Number.MAX_SAFE_INTEGER - 1),
    };
    const quarantine = {
      ...item,
      replayState: { ...completed, quarantine: "bank-mismatch", ...(completed.gate ? { gate: "operator" } : {}) },
    };
    outcomeBytes = Math.max(
      outcomeBytes,
      Buffer.byteLength(JSON.stringify(transient)) - size,
      Buffer.byteLength(JSON.stringify(quarantine)) - size,
    );
  }
  return Math.max(protectionBytes + gateBytes, outcomeBytes);
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

export class RetainQueueRewriteCapacityError extends RangeError {
  readonly code = "RETAIN_QUEUE_REWRITE_CAPACITY";
  constructor() {
    super("retain queue rewrite exceeds configured byte limit; original queue preserved; increase the limit or repair the backlog");
    this.name = "RetainQueueRewriteCapacityError";
  }
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
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(dirname(this.filePath));
    this.options.capacity?.didAppend(this.filePath);
    if (this.cachedSize !== undefined) this.cachedSize++;
  }

  /** Get up to `limit` oldest pending items (FIFO). */
  peek(limit = 50): QueuedRetain[] {
    return this.readAll().items.slice(0, limit);
  }

  /** Materialize unknown-identity ordering barriers before any delivery. Caller holds the mutation lock. */
  snapshot(): QueuedRetain[] {
    const contents = this.readAll();
    assertUniqueIdentities(contents.items);
    if (contents.bytes.length > 0) this.writeAll(contents.items, contents);
    return contents.items;
  }

  setReplayState(id: string, state: RetainReplayState | undefined): void {
    this.setReplayStates([{ id, state }]);
  }

  /** Classify a changed-bank backlog in one atomic rewrite, not one per row. */
  setReplayStates(updates: Array<{ id: string; state: RetainReplayState | undefined }>): void {
    if (updates.length === 0) return;
    const contents = this.readAll();
    const pending = new Map(updates.map((update) => [update.id, update.state]));
    if (pending.size !== updates.length) throw new Error("ambiguous retain queue state update");
    const seen = new Set<string>();
    for (const item of contents.items) {
      const state = pending.get(item.id);
      if (!pending.has(item.id)) continue;
      if (seen.has(item.id)) throw new Error("ambiguous retain queue identity");
      seen.add(item.id);
      item.replayState = state;
    }
    if (seen.size !== pending.size) throw new Error("missing retain queue identity");
    const reservedBytes = updates.some((update) => update.state?.sending) ? replayOutcomeHeadroom(contents.items) : 0;
    this.writeAll(contents.items, contents, reservedBytes);
  }

  /** Remove a single item by id. */
  remove(id: string): void {
    this.removeMany([id]);
  }

  /** Remove multiple items by id in a single file rewrite. */
  removeMany(ids: string[]): void {
    const idSet = new Set(ids);
    const contents = this.readAll();
    if (idSet.size > 0) assertUniqueIdentities(contents.items);
    this.writeAll(
      contents.items.filter((i) => !idSet.has(i.id)),
      contents,
    );
  }

  // Caller must hold the mutation lock.
  ensureOperationIds(operationIds: ReadonlyMap<string, string>): void {
    if (operationIds.size === 0) return;
    const contents = this.readAll();
    const seen = new Set<string>();
    let changed = false;
    for (const item of contents.items) {
      const operationId = operationIds.get(item.id);
      if (operationId === undefined) continue;
      if (seen.has(item.id)) throw new Error("ambiguous retain queue identity");
      seen.add(item.id);
      if (item.operationId) continue;
      item.operationId = operationId;
      changed = true;
    }
    if (seen.size !== operationIds.size) throw new Error("missing retain queue identity");
    // Identity upgrades must leave room to durably classify the next HTTP outcome.
    if (changed) this.writeAll(contents.items, contents, replayOutcomeHeadroom(contents.items));
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
    item.replayAttempts = Math.min((item.replayAttempts ?? 0) + 1, Number.MAX_SAFE_INTEGER - 1);
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
    // A closed principal gate protects its entire backlog. Quarantine and unknown
    // identity barriers protect dependent successors without extending unrelated retention.
    const gated = contents.items.some((item) => item.replayState?.gate !== undefined || item.replayState?.sending);
    const protectedRows: QueuedRetain[] = [];
    let barrier = false;
    const kept = contents.items.filter((item) => {
      barrier ||= item.replayState?.quarantine === "corrupt";
      const protect =
        gated ||
        barrier ||
        item.replayState !== undefined ||
        protectedRows.some((prior) => sameRetainDocument(prior, item));
      if (protect) protectedRows.push(item);
      return protect || new Date(item.createdAt).getTime() >= cutoff;
    });
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
      if (ranges.at(-1) === start) {
        ranges[ranges.length - 1] = end;
        const state = result.items.at(-1)?.replayState;
        if (state?.length !== undefined) state.length += end - start;
      } else {
        ranges.push(start, end);
        result.items.push({
          id: `corrupt-${result.source}-${start}`,
          bankId: "unknown",
          content: "",
          metadata: {},
          createdAt: "1970-01-01T00:00:00.000Z",
          replayState: { quarantine: "corrupt", archive: result.source, offset: corruptBytes, length: end - start },
        });
      }
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
  private writeAll(items: QueuedRetain[], contents: QueueContents, reservedBytes = 0): void {
    this.preserveCorruptRecords(contents);
    if (items.length === 0) {
      removePrivateQueueFile(this.filePath);
      this.cachedSize = 0;
      return;
    }
    const serialized = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    // Recovery barriers and replay metadata can grow an otherwise in-limit
    // queue. Never replace readable source bytes with an unreadable generation.
    if (this.options.maxReadBytes !== undefined && Buffer.byteLength(serialized) + reservedBytes > this.options.maxReadBytes) {
      throw new RetainQueueRewriteCapacityError();
    }
    writePrivateQueueFile(this.filePath, serialized);
    this.cachedSize = items.length;
  }
}

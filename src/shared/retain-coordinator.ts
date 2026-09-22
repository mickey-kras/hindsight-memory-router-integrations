import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { type QueuedRetain, type QueuedRetainPayload, RetainQueue } from "../upstream/src/retain-queue.js";
import type { AuthenticatedClientFactory } from "./authenticated-client-factory.js";
import type { PrincipalCredentialResolver } from "./principal-credential-resolver.js";
import { isAuthorizationError, isTransientRequestError } from "./request-error.js";

export type RetainRequestPayload = QueuedRetainPayload;

export interface RetainOutcome {
  queued: boolean;
  bank: string;
}

export class RetainAuthorizationError extends Error {
  readonly bank: string;
  constructor(bank: string) {
    super(`retain authorization denied for bank ${bank}`);
    this.name = "RetainAuthorizationError";
    this.bank = bank;
  }
}

export interface CoordinatorLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

export type RetainAbandonHandler = (item: QueuedRetain, attempts: number) => void;

export function retainAbandonNotice(item: QueuedRetain, attempts: number): string {
  return `retain replay abandoned after ${attempts} attempts for bank ${item.bankId}; transcript dropped from the queue without delivery`;
}

const QUEUE_FILE_PREFIX = "hindsight-retain-queue.";
const QUEUE_FILE_SUFFIX = ".jsonl";
const MAX_REPLAY_ATTEMPTS = 5;
const REPLAY_BATCH_SIZE = 50;

export class RetainCoordinator {
  private readonly credentials: PrincipalCredentialResolver;
  private readonly clients: AuthenticatedClientFactory;
  private readonly queueDir: string;
  private readonly queueMaxAgeMs: number;
  private readonly log: CoordinatorLogger;
  private readonly onAbandon: RetainAbandonHandler;
  private readonly maxAgeConfigKey: string;

  constructor(options: {
    credentials: PrincipalCredentialResolver;
    clients: AuthenticatedClientFactory;
    queueDir: string;
    queueMaxAgeMs?: number;
    logger: CoordinatorLogger;
    onAbandon?: RetainAbandonHandler;
    maxAgeConfigKey?: string;
  }) {
    this.credentials = options.credentials;
    this.clients = options.clients;
    if (!isAbsolute(options.queueDir)) throw new TypeError("queueDir must be absolute");
    this.queueDir = options.queueDir;
    this.queueMaxAgeMs = options.queueMaxAgeMs ?? -1;
    this.log = options.logger;
    this.onAbandon = options.onAbandon ?? ((item, attempts) => this.log.error(retainAbandonNotice(item, attempts)));
    this.maxAgeConfigKey = options.maxAgeConfigKey ?? "retainQueueMaxAgeMs";
    if (this.queueMaxAgeMs < 0) {
      this.log.warn(
        `retain queue at ${this.queueDir} holds plaintext transcripts with no expiration; set ${this.maxAgeConfigKey} to bound retention and protect the directory with disk encryption`,
      );
    }
  }

  private queueFor(principalId: string): RetainQueue {
    // principalId is validated against PRINCIPAL_ID_PATTERN by the resolver before any
    // queue file is touched, so no path separators can reach this join.
    return new RetainQueue({
      filePath: join(this.queueDir, `${QUEUE_FILE_PREFIX}${principalId}${QUEUE_FILE_SUFFIX}`),
      maxAgeMs: this.queueMaxAgeMs,
    });
  }

  async retain(principalId: string, request: RetainRequestPayload): Promise<RetainOutcome> {
    const credentials = this.credentials.resolve(principalId);
    const bank = this.credentials.resolveWriteBank(principalId);
    const client = this.clients.forAgent(credentials);
    try {
      await client.retain(bank, request.content, {
        documentId: request.documentId,
        context: request.context,
        metadata: toStringMetadata(request.metadata),
        tags: request.tags,
        updateMode: request.updateMode,
        operationId: request.operationId ?? randomUUID(),
        async: true,
      });
      return { queued: false, bank };
    } catch (error) {
      if (isAuthorizationError(error)) {
        throw new RetainAuthorizationError(bank);
      }
      if (!isTransientRequestError(error)) {
        throw error;
      }
      const queue = this.queueFor(principalId);
      queue.enqueue(bank, request, request.metadata);
      this.log.warn(`retain queued for later delivery (bank: ${bank})`);
      return { queued: true, bank };
    }
  }

  async flushQueues(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.queueDir);
    } catch {
      return; // no queue directory yet
    }
    for (const file of files) {
      if (!file.startsWith(QUEUE_FILE_PREFIX) || !file.endsWith(QUEUE_FILE_SUFFIX)) {
        continue;
      }
      await this.flushQueueFile(file);
    }
  }

  private async flushQueueFile(file: string): Promise<void> {
    const principalId = file.slice(QUEUE_FILE_PREFIX.length, -QUEUE_FILE_SUFFIX.length);
    let credentials: ReturnType<PrincipalCredentialResolver["resolve"]>;
    try {
      credentials = this.credentials.resolve(principalId);
    } catch {
      this.log.error(`retain queue replay skipped: no routing entry for agent ${principalId}`);
      return; // fail closed: unknown agent's items stay queued
    }
    const client = this.clients.forAgent(credentials);
    const queue = this.queueFor(principalId);
    queue.cleanup();
    const delivered: string[] = [];
    for (const item of queue.peek(REPLAY_BATCH_SIZE)) {
      try {
        await this.replayItem(principalId, client, queue, item);
        delivered.push(item.id);
      } catch (error) {
        this.handleReplayError(error, queue, item, delivered);
        break; // preserve FIFO ordering; retry next flush
      }
    }
    queue.removeMany(delivered);
  }

  private async replayItem(
    principalId: string,
    client: ReturnType<AuthenticatedClientFactory["forAgent"]>,
    queue: RetainQueue,
    item: QueuedRetain,
  ): Promise<void> {
    if (item.updateMode !== undefined && item.updateMode !== "append" && item.updateMode !== "replace") {
      throw new TypeError("invalid queued retain update mode");
    }
    if (item.bankId !== this.credentials.resolveWriteBank(principalId)) {
      throw new RetainAuthorizationError(item.bankId);
    }
    const operationId = queue.ensureOperationId(item.id, item.operationId ?? randomUUID());
    await client.retain(item.bankId, item.content, {
      documentId: item.documentId,
      context: item.context,
      metadata: toStringMetadata(item.metadata),
      tags: item.tags,
      updateMode: item.updateMode,
      operationId,
      async: true,
    });
  }

  private handleReplayError(error: unknown, queue: RetainQueue, item: QueuedRetain, delivered: string[]): void {
    if (isAuthorizationError(error)) {
      this.log.error(`retain replay denied for bank ${item.bankId}; item stays queued for operator review`);
      return;
    }
    if (!isTransientRequestError(error)) {
      this.log.error(`retain replay failed permanently for bank ${item.bankId}; item stays queued for review`);
      return;
    }
    const attempts = queue.incrementReplayAttempts(item.id);
    if (attempts >= MAX_REPLAY_ATTEMPTS) {
      delivered.push(item.id);
      try {
        this.onAbandon(item, attempts);
      } catch (error) {
        this.log.error(
          `retain abandonment handler failed for bank ${item.bankId}: ${error instanceof Error ? error.name : typeof error}`,
        );
      }
    }
  }
}

function stringifyMetadataValue(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value) ?? "";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "symbol") {
    return value.toString();
  }
  return "";
}

function toStringMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = typeof value === "string" ? value : stringifyMetadataValue(value);
  }
  return out;
}

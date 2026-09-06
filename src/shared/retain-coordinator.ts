/** Per-agent retain routing and transient-failure queueing. */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { RetainQueue, type QueuedRetainPayload } from "../upstream/src/retain-queue.js";
import { PrincipalCredentialResolver } from "./principal-credential-resolver.js";
import { AuthenticatedClientFactory } from "./authenticated-client-factory.js";
import { WriteBankResolver } from "./write-bank-resolver.js";

export interface RetainRequestPayload extends QueuedRetainPayload {}

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

const QUEUE_FILE_PREFIX = "hindsight-retain-queue.";
const QUEUE_FILE_SUFFIX = ".jsonl";

function isAuthzError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return status === 401 || status === 403;
}

function isTransientError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  if (status === undefined) {
    return true;
  }
  return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
}

export class RetainCoordinator {
  private readonly credentials: PrincipalCredentialResolver;
  private readonly writeBanks: WriteBankResolver;
  private readonly clients: AuthenticatedClientFactory;
  private readonly queueDir: string;
  private readonly queueMaxAgeMs: number;
  private readonly log: CoordinatorLogger;

  constructor(options: {
    credentials: PrincipalCredentialResolver;
    writeBanks: WriteBankResolver;
    clients: AuthenticatedClientFactory;
    queueDir: string;
    queueMaxAgeMs?: number;
    logger: CoordinatorLogger;
  }) {
    this.credentials = options.credentials;
    this.writeBanks = options.writeBanks;
    this.clients = options.clients;
    this.queueDir = options.queueDir;
    this.queueMaxAgeMs = options.queueMaxAgeMs ?? -1;
    this.log = options.logger;
  }

  private queueFor(principalId: string): RetainQueue {
    // principalId is validated against PRINCIPAL_ID_PATTERN by the resolver before any
    // queue file is touched, so no path separators can reach this join.
    return new RetainQueue({
      filePath: join(this.queueDir, `${QUEUE_FILE_PREFIX}${principalId}${QUEUE_FILE_SUFFIX}`),
      maxAgeMs: this.queueMaxAgeMs,
    });
  }

  /** Retain into the agent's default write bank; queue on transient failure. */
  async retain(principalId: string, request: RetainRequestPayload): Promise<RetainOutcome> {
    const credentials = this.credentials.resolve(principalId);
    const bank = this.writeBanks.resolve(principalId);
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
      if (isAuthzError(error)) {
        throw new RetainAuthorizationError(bank);
      }
      if (!isTransientError(error)) {
        throw error;
      }
      const queue = this.queueFor(principalId);
      queue.enqueue(bank, request, request.metadata);
      this.log.warn(`retain queued for later delivery (bank: ${bank})`);
      return { queued: true, bank };
    }
  }

  /** Replay all per-agent queues, preserving agent identity and bank target. */
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
    let credentials;
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
    for (const item of queue.peek(50)) {
      try {
        if (item.bankId !== this.writeBanks.resolve(principalId)) {
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
        delivered.push(item.id);
      } catch (error) {
        if (isAuthzError(error)) {
          this.log.error(
            `retain replay denied for bank ${item.bankId}; item stays queued for operator review`
          );
        }
        break; // preserve FIFO ordering; retry next flush
      }
    }
    queue.removeMany(delivered);
  }
}

function stringifyMetadataValue(value: unknown): string {
  if (typeof value === "object") {
    return JSON.stringify(value) ?? "";
  }
  return String(value);
}

function toStringMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, string> | undefined {
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

/**
 * RetainCoordinator boundary.
 *
 * Routes retains to the agent's single default write bank with the agent's
 * own credentials, and buffers transient failures in a per-agent JSONL queue
 * (upstream RetainQueue, reused unmodified). Queue identity is preserved by
 * construction: the agent ID is encoded in the queue file name and the bank
 * target inside each queued item, so a replay always re-resolves THAT agent's
 * credentials and hits THAT bank.
 *
 * - authorization failures (401/403) fail closed: typed error, never queued
 *   (replaying a denied retain can never succeed)
 * - transient failures (network, 5xx, timeout) are queued and replayed
 * - the token itself is never written to the queue; replay re-resolves
 *   credentials through the AgentCredentialResolver
 */

import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { RetainQueue, type QueuedRetainPayload } from "../upstream/src/retain-queue.js";
import { AgentCredentialResolver } from "./agent-credential-resolver.js";
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

export class RetainCoordinator {
  private readonly credentials: AgentCredentialResolver;
  private readonly writeBanks: WriteBankResolver;
  private readonly clients: AuthenticatedClientFactory;
  private readonly queueDir: string;
  private readonly queueMaxAgeMs: number;
  private readonly log: CoordinatorLogger;

  constructor(options: {
    credentials: AgentCredentialResolver;
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

  private queueFor(agentId: string): RetainQueue {
    // agentId is validated against AGENT_ID_PATTERN by the resolver before any
    // queue file is touched, so no path separators can reach this join.
    return new RetainQueue({
      filePath: join(this.queueDir, `${QUEUE_FILE_PREFIX}${agentId}${QUEUE_FILE_SUFFIX}`),
      maxAgeMs: this.queueMaxAgeMs,
    });
  }

  /** Retain into the agent's default write bank; queue on transient failure. */
  async retain(agentId: string, request: RetainRequestPayload): Promise<RetainOutcome> {
    const credentials = this.credentials.resolve(agentId);
    const bank = this.writeBanks.resolve(agentId);
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
      const queue = this.queueFor(agentId);
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
      const agentId = file.slice(QUEUE_FILE_PREFIX.length, -QUEUE_FILE_SUFFIX.length);
      let credentials;
      try {
        credentials = this.credentials.resolve(agentId);
      } catch {
        this.log.error(`retain queue replay skipped: no routing entry for agent ${agentId}`);
        continue; // fail closed: unknown agent's items stay queued
      }
      const client = this.clients.forAgent(credentials);
      const queue = this.queueFor(agentId);
      queue.cleanup();
      const delivered: string[] = [];
      for (const item of queue.peek(50)) {
        try {
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
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

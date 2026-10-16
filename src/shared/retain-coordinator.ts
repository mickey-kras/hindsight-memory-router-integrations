import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  type QueuedRetain,
  type QueuedRetainPayload,
  RetainQueue,
  RetainQueueRewriteCapacityError,
  type RetainReplayState,
  sameRetainDocument,
} from "../upstream/src/retain-queue.js";
import type { AuthenticatedClientFactory } from "./authenticated-client-factory.js";
import { PRINCIPAL_ID_PATTERN, type PrincipalCredentialResolver } from "./principal-credential-resolver.js";
import { privateQueueDirectory } from "./private-queue-files.js";
import { isAuthorizationError, isTransientRequestError } from "./request-error.js";
import {
  QUEUE_FILE_PREFIX,
  QUEUE_FILE_SUFFIX,
  RetainQueueSharedStorageError,
  RetainQueueStorage,
} from "./retain-queue-storage.js";

export { RetainQueueBusyError, RetainQueueCapacityError } from "./retain-queue-storage.js";

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

const MAX_REPLAY_ATTEMPTS = 5;
const REPLAY_BATCH_SIZE = 50;

export class RetainCoordinator {
  private readonly credentials: PrincipalCredentialResolver;
  private readonly clients: AuthenticatedClientFactory;
  private readonly queueDir: string;
  private readonly queueMaxAgeMs: number;
  private readonly storage: RetainQueueStorage;
  private readonly log: CoordinatorLogger;
  private readonly onAbandon: RetainAbandonHandler;
  private readonly maxAgeConfigKey: string;

  constructor(options: {
    credentials: PrincipalCredentialResolver;
    clients: AuthenticatedClientFactory;
    queueDir: string;
    queueMaxAgeMs?: number;
    queueMaxItems?: number;
    queueMaxBytes?: number;
    logger: CoordinatorLogger;
    onAbandon?: RetainAbandonHandler;
    maxAgeConfigKey?: string;
  }) {
    this.credentials = options.credentials;
    this.clients = options.clients;
    if (!isAbsolute(options.queueDir)) throw new TypeError("queueDir must be absolute");
    this.queueDir = resolve(options.queueDir);
    this.storage = new RetainQueueStorage(this.queueDir, options.queueMaxItems, options.queueMaxBytes);
    privateQueueDirectory(this.queueDir, true);
    this.queueMaxAgeMs = options.queueMaxAgeMs ?? -1;
    this.log = options.logger;
    this.onAbandon = options.onAbandon ?? ((item, attempts) => this.log.error(retainAbandonNotice(item, attempts)));
    this.maxAgeConfigKey = options.maxAgeConfigKey ?? "retainQueueMaxAgeMs";
    if (this.queueMaxAgeMs < 0) {
      this.log.warn(
        `retain queue at ${this.queueDir} holds plaintext transcripts with no expiration; set ${this.maxAgeConfigKey} to bound ordinary retention (protected backlog is exempt) and protect the directory with disk encryption`,
      );
    }
  }

  private queueFor(principalId: string): RetainQueue {
    // principalId is validated against PRINCIPAL_ID_PATTERN by the resolver before any
    // queue file is touched, so no path separators can reach this join.
    return new RetainQueue({
      filePath: join(this.queueDir, `${QUEUE_FILE_PREFIX}${principalId}${QUEUE_FILE_SUFFIX}`),
      maxAgeMs: this.queueMaxAgeMs,
      maxReadBytes: this.storage.maxBytes,
      capacity: this.storage,
      onCorruption: ({ malformedJson, invalidShape }) =>
        this.log.error(
          `retain queue recovery preserved corrupt records: malformed-json=${malformedJson}, invalid-shape=${invalidShape}`,
        ),
    });
  }

  async retain(principalId: string, request: RetainRequestPayload): Promise<RetainOutcome> {
    // Serialize fresh senders until the predecessor is delivered or durably queued.
    // Replay already has a persisted predecessor and may still accept queued work.
    return this.storage.admission(() => this.retainAdmitted(principalId, request));
  }

  private async retainAdmitted(principalId: string, request: RetainRequestPayload): Promise<RetainOutcome> {
    const credentials = this.credentials.resolve(principalId);
    const bank = this.credentials.resolveWriteBank(principalId);
    const client = this.clients.forAgent(credentials);
    const payload = {
      ...request,
      metadata: toStringMetadata(request.metadata),
      tags: request.tags?.slice(),
      operationId: request.operationId ?? randomUUID(),
    };
    const queue = this.queueFor(principalId);
    const enqueue = async (): Promise<RetainOutcome> => {
      await this.storage.transaction(() => {
        // Contended replay skips the delivery path's preparation. Reject an
        // invalid existing backlog before accepting any new bytes into it.
        this.prepareQueue(principalId, queue);
        queue.enqueue(bank, payload, payload.metadata);
        this.prepareQueue(principalId, queue);
      });
      this.log.warn(`retain queued for later delivery (bank: ${bank})`);
      return { queued: true, bank };
    };
    const outcome = await this.storage.replay(async () => {
      const items = await this.storage.transaction(() => this.prepareQueue(principalId, queue));
      if (
        items.some(
          (item) =>
            item.replayState?.gate !== undefined ||
            item.replayState?.sending ||
            item.replayState?.quarantine === "corrupt" ||
            sameRetainDocument(item, { bankId: bank, documentId: payload.documentId }),
        )
      )
        return enqueue();
      if (bank !== this.credentials.resolveWriteBank(principalId)) throw new RetainAuthorizationError(bank);
      try {
        await client.retain(bank, payload.content, {
          documentId: payload.documentId,
          context: payload.context,
          metadata: payload.metadata,
          tags: payload.tags,
          updateMode: payload.updateMode,
          operationId: payload.operationId,
          async: true,
        });
        return { queued: false, bank };
      } catch (error) {
        if (isAuthorizationError(error)) throw new RetainAuthorizationError(bank);
        if (!isTransientRequestError(error)) throw error;
        return enqueue();
      }
    });
    // Another sender owns delivery exclusion. Accept durably behind it, never
    // interpret the replay lock's nonblocking `undefined` as a successful send.
    return outcome ?? enqueue();
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
      try {
        await this.flushQueueFile(file);
      } catch (error) {
        if (error instanceof RetainQueueSharedStorageError) {
          this.log.error(
            "retain queue replay paused: shared storage unavailable; remaining items stay queued for retry",
          );
          return;
        }
        if (error instanceof RetainQueueRewriteCapacityError) {
          this.log.error(
            `retain queue replay paused for ${this.queueLabel(file)}: rewrite exceeds byte limit; original bytes preserved; increase retainQueueMaxBytes or repair the backlog`,
          );
          continue;
        }
        this.log.error(
          `retain queue replay failed for ${this.queueLabel(file)}; remaining items stay queued for retry`,
        );
      }
    }
  }

  private queueLabel(file: string): string {
    const principalId = file.slice(QUEUE_FILE_PREFIX.length, -QUEUE_FILE_SUFFIX.length);
    if (
      PRINCIPAL_ID_PATTERN.test(principalId) &&
      principalId !== "." &&
      principalId !== ".." &&
      this.credentials.has(principalId)
    ) {
      return `agent ${principalId}`;
    }
    // Unknown filenames may contain content or control characters, not trusted IDs.
    return `queue ${createHash("sha256").update(file).digest("hex").slice(0, 16)}`;
  }

  private async flushQueueFile(file: string): Promise<void> {
    const principalId = file.slice(QUEUE_FILE_PREFIX.length, -QUEUE_FILE_SUFFIX.length);
    let credentials: ReturnType<PrincipalCredentialResolver["resolve"]>;
    try {
      credentials = this.credentials.resolve(principalId);
    } catch {
      this.log.error(`retain queue replay skipped: no routing entry for ${this.queueLabel(file)}`);
      return; // fail closed: unknown agent's items stay queued
    }
    await this.storage.replay(() => this.replayQueue(principalId, credentials));
  }

  private prepareQueue(principalId: string, queue: RetainQueue): QueuedRetain[] {
    const items = queue.snapshot();
    const bank = this.credentials.resolveWriteBank(principalId);
    const changes: Array<{ id: string; state: RetainReplayState }> = [];
    const gated = items.some((item) => item.replayState?.gate !== undefined);
    let bankMismatch = false;
    for (const item of items) {
      let state = item.replayState;
      if (gated && !state?.protected) state = { ...state, protected: true };
      if (!state?.quarantine && item.bankId !== bank) {
        bankMismatch = true;
        state = {
          ...state,
          quarantine: "bank-mismatch",
          ...(state?.gate ? { gate: "operator" as const } : {}),
        };
      }
      if (state === item.replayState || state === undefined) continue;
      item.replayState = state;
      changes.push({ id: item.id, state });
    }
    if (changes.length > 0) {
      queue.setReplayStates(changes);
      if (bankMismatch)
        this.log.error(
          "retain replay authorization denied: bank mismatch quarantined; original bank and payload preserved",
        );
    }
    return items;
  }

  private async replayQueue(
    principalId: string,
    credentials: ReturnType<PrincipalCredentialResolver["resolve"]>,
  ): Promise<void> {
    const client = this.clients.forAgent(credentials);
    const queue = this.queueFor(principalId);
    let items = await this.storage.transaction(() => {
      this.prepareQueue(principalId, queue);
      queue.cleanup();
      return queue.snapshot();
    });
    if (items.some((item) => item.replayState?.sending)) {
      this.log.error("retain replay paused: HTTP outcome could not be persisted; operator repair required");
      return;
    }
    let attempts = 0;
    const gate = items.find((item) => item.replayState?.gate);
    if (gate) {
      const predecessors = items.slice(0, items.indexOf(gate));
      if (
        gate.replayState?.gate !== "probe" ||
        gate.replayState.quarantine ||
        predecessors.some((item) => item.replayState?.quarantine === "corrupt" || sameRetainDocument(item, gate))
      )
        return;
      attempts++;
      if ((await this.deliverQueued(principalId, client, queue, gate)) !== "delivered") return;
      items = await this.storage.transaction(() => queue.snapshot());
      // Recovery-edited backlogs can contain another gate owner. Never let a
      // successful probe implicitly clear a different persisted principal gate.
      if (items.some((item) => item.replayState?.gate)) return;
    }
    const blocked: QueuedRetain[] = [];
    for (const item of items) {
      if (attempts >= REPLAY_BATCH_SIZE || item.replayState?.quarantine === "corrupt") break;
      if (item.replayState?.quarantine || blocked.some((prior) => sameRetainDocument(prior, item))) {
        blocked.push(item);
        continue;
      }
      attempts++;
      const outcome = await this.deliverQueued(principalId, client, queue, item);
      if (outcome === "stop") break;
      if (outcome === "mismatched") attempts--;
      if (outcome === "quarantined" || outcome === "mismatched") blocked.push(item);
    }
  }

  private async deliverQueued(
    principalId: string,
    client: ReturnType<AuthenticatedClientFactory["forAgent"]>,
    queue: RetainQueue,
    item: QueuedRetain,
  ): Promise<"delivered" | "quarantined" | "mismatched" | "stop"> {
    // Preparation and acknowledgement errors are storage failures, never HTTP
    // classifications. A failed acknowledgement retains the original operation ID.
    const prepared = await this.storage.transaction(() => {
      const items = queue.snapshot();
      const current = items.find((queued) => queued.id === item.id);
      if (!current) return undefined;
      const predecessors = items.slice(0, items.indexOf(current));
      const gate = items.find((queued) => queued.replayState?.gate);
      if (
        items.some((queued) => queued.replayState?.sending) ||
        (gate !== undefined && gate.id !== current.id) ||
        current.replayState?.gate === "operator" ||
        predecessors.some((queued) => queued.replayState?.quarantine === "corrupt")
      )
        return undefined;
      if (current.replayState?.quarantine || predecessors.some((queued) => sameRetainDocument(queued, current)))
        return { item: current, operationId: undefined };
      const operationId = queue.ensureOperationId(current.id, current.operationId || randomUUID());
      queue.setReplayState(current.id, { ...current.replayState, sending: true });
      return { item: current, operationId };
    });
    if (!prepared) return "stop";
    if (prepared.operationId === undefined) return "quarantined";
    item = prepared.item;
    const operationId = prepared.operationId;
    // Routing may change while a previous HTTP request or storage lock is awaited.
    // Keep local authorization failures outside the HTTP error classifier.
    let currentBank: string;
    try {
      currentBank = this.credentials.resolveWriteBank(principalId);
    } catch (error) {
      // No HTTP request started: discard only the provisional sending marker.
      await this.storage.transaction(() => queue.setReplayState(item.id, this.completedReplayState(queue, item)));
      throw error;
    }
    if (item.bankId !== currentBank) {
      await this.storage.transaction(() =>
        queue.setReplayState(item.id, {
          ...item.replayState,
          quarantine: "bank-mismatch",
          ...(item.replayState?.gate ? { gate: "operator" as const } : {}),
        }),
      );
      this.log.error(
        "retain replay authorization denied: bank mismatch quarantined; original bank and payload preserved",
      );
      return "mismatched";
    }
    try {
      await client.retain(item.bankId, item.content, {
        documentId: item.documentId,
        context: item.context,
        metadata: toStringMetadata(item.metadata),
        tags: item.tags,
        updateMode: item.updateMode,
        operationId,
        async: true,
      });
    } catch (error) {
      if (error instanceof RetainQueueSharedStorageError) throw error;
      if (isAuthorizationError(error)) {
        await this.storage.transaction(() =>
          queue.setReplayStates(
            queue.snapshot().map((queued) => ({
              id: queued.id,
              state: {
                ...queued.replayState,
                sending: undefined,
                ...(queued.id === item.id ? { gate: "probe" as const } : {}),
                protected: true,
              },
            })),
          ),
        );
        this.log.error(`retain replay denied for bank ${item.bankId}; item stays queued for operator review`);
        return "stop";
      }
      if (!isTransientRequestError(error)) {
        await this.storage.transaction(() =>
          queue.setReplayState(item.id, {
            ...this.completedReplayState(queue, item),
            quarantine: "permanent",
            ...(item.replayState?.gate ? { gate: "operator" as const } : {}),
          }),
        );
        this.log.error("retain replay quarantined: permanent response; payload preserved for operator review");
        return "quarantined";
      }
      // Another admission can quarantine or protect this row while HTTP is in
      // flight. Read its durable state and decide abandonment under one lock.
      const { count, abandoned } = await this.storage.transaction(() => {
        const current = queue.snapshot().find((queued) => queued.id === item.id);
        if (!current) throw new Error(`queued retain not found: ${item.id}`);
        const state = this.completedReplayState(queue, item);
        const count = queue.incrementReplayAttempts(item.id);
        queue.setReplayState(item.id, state);
        const abandoned = count >= MAX_REPLAY_ATTEMPTS && state === undefined;
        if (abandoned) queue.remove(item.id);
        return { count, abandoned };
      });
      if (abandoned) {
        try {
          this.onAbandon(item, count);
        } catch (error) {
          this.log.error(
            `retain abandonment handler failed for bank ${item.bankId}: ${error instanceof Error ? error.name : typeof error}`,
          );
        }
      }
      return "stop";
    }
    await this.storage.transaction(() => {
      queue.setReplayState(item.id, this.completedReplayState(queue, item));
      queue.remove(item.id);
    });
    return "delivered";
  }

  private completedReplayState(queue: RetainQueue, item: QueuedRetain): RetainReplayState | undefined {
    const current = queue.snapshot().find((queued) => queued.id === item.id);
    if (!current) throw new Error(`queued retain not found: ${item.id}`);
    const { sending: _sending, ...state } = current.replayState ?? {};
    return Object.keys(state).length > 0 || item.replayState !== undefined ? state : undefined;
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

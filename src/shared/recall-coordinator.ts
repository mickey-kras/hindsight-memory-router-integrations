/** Multi-bank recall with one timeout, one budget, and deterministic merge. */

import { createHash } from "node:crypto";

import type { RouterClient } from "./authenticated-client-factory.js";

export interface RecallItem {
  id?: string;
  content?: string;
  text?: string;
  score?: number;
  type?: string;
  [key: string]: unknown;
}

export interface CoordinatedRecallRequest {
  query: string;
  banks: readonly string[];
  /** Shared deadline across all banks (ms). */
  timeoutMs: number;
  /** Shared context token budget across all banks. */
  maxTokens?: number;
  budget?: "low" | "mid" | "high";
  types?: string[];
  preferObservations?: boolean;
}

export interface CoordinatedRecallResult {
  results: RecallItem[];
  partial: boolean;
  failedBanks: string[];
}

export class RecallAuthorizationError extends Error {
  readonly bank: string;
  constructor(bank: string) {
    super(`recall authorization denied for bank ${bank}`);
    this.name = "RecallAuthorizationError";
    this.bank = bank;
  }
}

function isAuthzError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return status === 401 || status === 403;
}

function timeoutAfter(ms: number, controller: AbortController): {
  promise: Promise<never>;
  timer: ReturnType<typeof setTimeout>;
} {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException(`recall timed out after ${ms}ms`, "TimeoutError"));
    }, ms);
  });
  return { promise, timer: timer! };
}

function itemContent(item: RecallItem): string {
  const value = item.content ?? item.text;
  return typeof value === "string" ? value : JSON.stringify(item);
}

function dedupeKey(item: RecallItem): string {
  const normalized = itemContent(item).trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Rough token estimate for budget trimming (~4 chars per token). */
function estimateTokens(item: RecallItem): number {
  return Math.max(1, Math.ceil(itemContent(item).length / 4));
}

export class RecallCoordinator {
  async recall(
    client: RouterClient,
    request: CoordinatedRecallRequest
  ): Promise<CoordinatedRecallResult> {
    const banks = request.banks;
    if (banks.length === 0) {
      return { results: [], partial: false, failedBanks: [] };
    }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new RangeError("recall timeout must be a positive integer");
    }
    if (
      request.maxTokens !== undefined &&
      (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)
    ) {
      throw new RangeError("recall token budget must be a positive integer");
    }
    const deadline = Date.now() + request.timeoutMs;
    const perBankTokens = request.maxTokens
      ? Math.max(1, Math.floor(request.maxTokens / banks.length))
      : undefined;

    const settled = await Promise.allSettled(
      banks.map(async (bank) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new DOMException(`recall timed out after ${request.timeoutMs}ms`, "TimeoutError");
        }
        const controller = new AbortController();
        const call = client.recall(bank, request.query, {
          maxTokens: perBankTokens,
          budget: request.budget,
          types: request.types,
          preferObservations: request.preferObservations,
          signal: controller.signal,
        });
        const timeout = timeoutAfter(remaining, controller);
        try {
          const response = await Promise.race([call, timeout.promise]);
          return { bank, results: (response.results ?? []) as RecallItem[] };
        } finally {
          clearTimeout(timeout.timer);
        }
      })
    );

    const failedBanks: string[] = [];
    const merged: Array<{ bank: string; item: RecallItem }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const bank = banks[i];
      if (outcome.status === "rejected") {
        if (isAuthzError(outcome.reason)) {
          throw new RecallAuthorizationError(bank);
        }
        const status = (outcome.reason as { statusCode?: number })?.statusCode;
        if (status !== undefined && status !== 408 && status !== 429 && status < 500) {
          throw new Error("memory read failed");
        }
        failedBanks.push(bank);
        continue;
      }
      for (const item of outcome.value.results) {
        const key = dedupeKey(item);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push({ bank, item });
      }
    }

    // Deterministic ranking: score desc, bank asc, content asc.
    merged.sort((a, b) => {
      const scoreA = typeof a.item.score === "number" ? a.item.score : Number.NEGATIVE_INFINITY;
      const scoreB = typeof b.item.score === "number" ? b.item.score : Number.NEGATIVE_INFINITY;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      if (a.bank !== b.bank) {
        return a.bank < b.bank ? -1 : 1;
      }
      const contentA = itemContent(a.item);
      const contentB = itemContent(b.item);
      return contentA < contentB ? -1 : contentA > contentB ? 1 : 0;
    });

    // Trim merged list to the shared context token budget.
    let results = merged.map((entry) => entry.item);
    if (request.maxTokens) {
      const kept: RecallItem[] = [];
      let spent = 0;
      for (const item of results) {
        const tokens = estimateTokens(item);
        if (spent + tokens > request.maxTokens) {
          continue;
        }
        spent += tokens;
        kept.push(item);
      }
      results = kept;
    }

    return { results, partial: failedBanks.length > 0, failedBanks };
  }
}

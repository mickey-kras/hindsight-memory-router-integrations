import { describe, expect, it } from "vitest";

import type { RouterClient } from "../src/router/authenticated-client-factory.js";
import {
  RecallAuthorizationError,
  RecallCoordinator,
  type RecallItem,
} from "../src/router/recall-coordinator.js";

function fakeClient(
  perBank: Record<
    string,
    | { results: RecallItem[]; delayMs?: number }
    | { error: Error & { statusCode?: number } }
  >
): RouterClient & { calls: Array<{ bank: string; options?: { maxTokens?: number } }> } {
  const calls: Array<{ bank: string; options?: { maxTokens?: number } }> = [];
  return {
    calls,
    async retain() {
      throw new Error("not used");
    },
    async recall(bank, _query, options) {
      calls.push({ bank, options });
      const behavior = perBank[bank];
      if (!behavior) {
        throw new Error(`unexpected bank ${bank}`);
      }
      if ("error" in behavior) {
        throw behavior.error;
      }
      if (behavior.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }
      return { results: behavior.results };
    },
  };
}

const httpError = (statusCode: number) =>
  Object.assign(new Error(`http ${statusCode}`), { statusCode });

describe("RecallCoordinator", () => {
  it("fans out to all configured recall banks", async () => {
    const client = fakeClient({
      main: { results: [{ text: "a", score: 0.9 }] },
      dev: { results: [{ text: "b", score: 0.8 }] },
      creative: { results: [{ text: "c", score: 0.7 }] },
    });
    const coordinator = new RecallCoordinator();
    const result = await coordinator.recall(client, {
      query: "q",
      banks: ["main", "dev", "creative"],
      timeoutMs: 1000,
    });
    expect(client.calls.map((c) => c.bank)).toEqual(["main", "dev", "creative"]);
    expect(result.results.map((r) => r.text)).toEqual(["a", "b", "c"]);
    expect(result.partial).toBe(false);
  });

  it("splits the shared token budget deterministically across banks", async () => {
    const client = fakeClient({
      main: { results: [] },
      dev: { results: [] },
    });
    const coordinator = new RecallCoordinator();
    await coordinator.recall(client, {
      query: "q",
      banks: ["main", "dev"],
      timeoutMs: 1000,
      maxTokens: 100,
    });
    expect(client.calls[0].options?.maxTokens).toBe(50);
    expect(client.calls[1].options?.maxTokens).toBe(50);
  });

  it("deduplicates identical content across banks", async () => {
    const client = fakeClient({
      main: { results: [{ text: "same memory", score: 0.9 }, { text: "unique", score: 0.5 }] },
      dev: { results: [{ text: "  Same   Memory ", score: 0.95 }] },
    });
    const coordinator = new RecallCoordinator();
    const result = await coordinator.recall(client, {
      query: "q",
      banks: ["main", "dev"],
      timeoutMs: 1000,
    });
    expect(result.results).toHaveLength(2);
  });

  it("ranks deterministically: score desc, then bank asc, then content asc", async () => {
    const mk = () =>
      fakeClient({
        b_bank: {
          results: [
            { text: "x", score: 0.5 },
            { text: "y", score: 0.5 },
          ],
        },
        a_bank: { results: [{ text: "z", score: 0.5 }] },
      });
    const coordinator = new RecallCoordinator();
    const run = async () =>
      (
        await coordinator.recall(mk(), {
          query: "q",
          banks: ["b_bank", "a_bank"],
          timeoutMs: 1000,
        })
      ).results.map((r) => `${r.text}`);
    const first = await run();
    const second = await run();
    expect(first).toEqual(["z", "x", "y"]); // equal scores -> bank asc, then content asc
    expect(first).toEqual(second);
  });

  it("trims merged results to the shared context token budget", async () => {
    const long = "x".repeat(400); // ~100 tokens at 4 chars/token
    const client = fakeClient({
      main: { results: [{ text: long, score: 0.9 }, { text: long, score: 0.8 }] },
      dev: { results: [{ text: long, score: 0.7 }] },
    });
    const coordinator = new RecallCoordinator();
    const result = await coordinator.recall(client, {
      query: "q",
      banks: ["main", "dev"],
      timeoutMs: 1000,
      maxTokens: 150,
    });
    expect(result.results).toHaveLength(1);
  });

  it("returns partial recall on non-authorization bank failure", async () => {
    const client = fakeClient({
      main: { results: [{ text: "ok", score: 0.9 }] },
      dev: { error: httpError(500) },
    });
    const coordinator = new RecallCoordinator();
    const result = await coordinator.recall(client, {
      query: "q",
      banks: ["main", "dev"],
      timeoutMs: 1000,
    });
    expect(result.partial).toBe(true);
    expect(result.failedBanks).toEqual(["dev"]);
    expect(result.results.map((r) => r.text)).toEqual(["ok"]);
  });

  it("fails closed on authorization denial from any bank (401)", async () => {
    const client = fakeClient({
      main: { results: [{ text: "ok", score: 0.9 }] },
      dev: { error: httpError(401) },
    });
    const coordinator = new RecallCoordinator();
    await expect(
      coordinator.recall(client, { query: "q", banks: ["main", "dev"], timeoutMs: 1000 })
    ).rejects.toThrow(RecallAuthorizationError);
  });

  it("fails closed on authorization denial (403)", async () => {
    const client = fakeClient({
      main: { error: httpError(403) },
      dev: { results: [{ text: "ok", score: 0.9 }] },
    });
    const coordinator = new RecallCoordinator();
    await expect(
      coordinator.recall(client, { query: "q", banks: ["main", "dev"], timeoutMs: 1000 })
    ).rejects.toThrow(RecallAuthorizationError);
  });

  it("enforces the shared timeout across banks", async () => {
    const client = fakeClient({
      main: { results: [{ text: "fast", score: 0.9 }] },
      dev: { results: [{ text: "slow", score: 0.8 }], delayMs: 500 },
    });
    const coordinator = new RecallCoordinator();
    const result = await coordinator.recall(client, {
      query: "q",
      banks: ["main", "dev"],
      timeoutMs: 100,
    });
    expect(result.partial).toBe(true);
    expect(result.failedBanks).toEqual(["dev"]);
    expect(result.results.map((r) => r.text)).toEqual(["fast"]);
  });

  it("returns empty result for an agent with no recall banks", async () => {
    const client = fakeClient({});
    const coordinator = new RecallCoordinator();
    const result = await coordinator.recall(client, {
      query: "q",
      banks: [],
      timeoutMs: 1000,
    });
    expect(result).toEqual({ results: [], partial: false, failedBanks: [] });
  });
});

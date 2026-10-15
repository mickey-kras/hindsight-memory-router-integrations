import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildRetain } from "./retain-hook";
import { memoryUsageCursorStore } from "./usage";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RateLimitedError, type HindsightClient } from "./hindsight";
import {
  DEFAULT_RETAIN_CONTEXT,
  ingestChats,
  renderSessionJsonl,
  retainLiveSession,
  type TransportTurn,
} from "./chat";
import { MAX_CURSOR_PATHS, PENDING_MAX_AGE_MS, memoryCursorStore, type RetainCursorStore } from "./retain-cursor";
import { log } from "./log";

function rolloutFixture(appendSupported = true) {
  const dir = mkdtempSync(join(tmpdir(), "cumulative-rollouts-"));
  const cursors = memoryCursorStore();
  const usageCursors = memoryUsageCursorStore();
  const documents = new Map<string, string[]>();
  const applied = new Set<string>();
  let bank = "A", failAfterCommit = false;
  const retain = vi.fn(async (content: string, _context: string, documentId: string, _tags: string[], _strategy: string, opts: { updateMode?: string; operationId?: string } = {}) => {
    expect(documentId).toBe("conversation:rollouts");
    if (opts.operationId && applied.has(opts.operationId)) return;
    const incoming = content.split("\n").map(line => JSON.parse(line)).filter(turn => turn.role !== "system").map(turn => turn.content as string);
    documents.set(bank, opts.updateMode === "append" ? [...(documents.get(bank) ?? []), ...incoming] : incoming);
    if (opts.operationId) applied.add(opts.operationId);
    if (failAfterCommit) { failAfterCommit = false; throw new Error("response lost after commit"); }
  });
  const client = { get bank() { return bank; }, retain, supportsAppendRetain: vi.fn(async () => appendSupported),
    bankUrl: (suffix: string) => suffix, req: vi.fn(async () => new Response('{"status":"completed"}')) };
  const path = (name: string) => join(dir, `${name}.jsonl`);
  const put = (name: string, texts: string[]) => writeFileSync(path(name), texts.map(content => JSON.stringify({ type: "user", message: { content }, timestamp: "2026-01-01T00:00:00Z" })).join("\n"));
  const stop = (name: string, extra: { lastAssistantMessage?: string; readTranscript?: (path: string) => TransportTurn[] } = {}) => buildRetain({ harness: "codex", sessionId: "rollouts", transcriptPath: path(name), client, cursors, usageCursors, ...extra });
  return { dir, cursors, client, retain, documents, path, put, stop, switchBank: (value: string) => { bank = value; }, loseResponse: () => { failAfterCommit = true; } };
}

async function withRollouts(run: (fixture: ReturnType<typeof rolloutFixture>) => Promise<void>, appendSupported = true) {
  const fixture = rolloutFixture(appendSupported);
  try { await run(fixture); } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
}

describe("cumulative rollout retention", () => {
  it.each([true, false])("preserves contributions and edits with append support %s", async (supported) => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a"); await f.stop("b");
      f.put("a", ["edited A1", "A2"]);
      await f.stop("a");
      expect(f.documents.get("A")).toEqual(["edited A1", "A2", "B1"]);
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["edited A1", "A2", "B1"]);
      expect(f.cursors.read("rollouts")?.paths).toEqual([f.path("a"), f.path("b")]);
    }, supported);
  });

  it("deduplicates copied prefixes while retaining independent earlier-file edits", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["A1", "B1"]);
      await f.stop("a"); await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "B1"]);
      f.put("a", ["edited A1", "A2"]); f.put("b", ["A1", "B1", "B2"]);
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["edited A1", "A2", "B1", "B2"]);
    });
  });

  it.each(["missing", "empty", "legacy", "copied-prefix"])("refuses unsafe %s reconstruction without changing the document or cursor", async (failure) => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", failure === "copied-prefix" ? ["A1", "B1"] : ["B1"]);
      await f.stop("a"); await f.stop("b");
      if (failure === "missing") rmSync(f.path("a"));
      if (failure === "empty") f.put("a", []);
      if (failure === "legacy") { const state = f.cursors.read("rollouts")!; f.cursors.write("rollouts", { ...state, rollouts: undefined }); }
      if (failure === "copied-prefix") f.put("b", ["changed copied A1", "B1", "B2"]);
      const before = structuredClone(f.cursors.read("rollouts"));
      const writes = f.retain.mock.calls.length;
      const warning = vi.spyOn(log, "warn");
      try {
        await f.stop("b");
        expect(f.documents.get("A")).toEqual(["A1", "B1"]);
        expect(f.retain).toHaveBeenCalledTimes(writes);
        expect(f.cursors.read("rollouts")).toEqual(before);
        expect(warning).toHaveBeenCalledWith("codex", "session write-back failed", expect.objectContaining({ error: expect.any(Error) }));
      } finally { warning.mockRestore(); }
    });
  });

  it("keeps every known segment at the path cap and refuses another source", async () => {
    await withRollouts(async f => {
      for (let i = 0; i <= MAX_CURSOR_PATHS; i++) { f.put(String(i), [`turn ${i}`]); await f.stop(String(i)); }
      expect(f.documents.get("A")).toEqual(Array.from({ length: MAX_CURSOR_PATHS }, (_, i) => `turn ${i}`));
      expect(f.cursors.read("rollouts")?.rollouts).toHaveLength(MAX_CURSOR_PATHS);
      f.put("0", ["edited first"]);
      await f.stop("0");
      expect(f.documents.get("A")).toEqual(["edited first", ...Array.from({ length: MAX_CURSOR_PATHS - 1 }, (_, i) => `turn ${i + 1}`)]);
    });
  });

  it.each(["pending", "expired-pending", "dirty", "failed-operation"])("reconstructs every segment during %s recovery", async (failure) => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a"); await f.stop("b");
      if (failure === "failed-operation") f.client.req.mockResolvedValueOnce(new Response('{"status":"failed"}'));
      else {
        if (failure === "dirty") f.put("a", ["edited A1", "A2"]);
        else f.put("b", ["B1", "B2"]);
        f.retain.mockRejectedValueOnce(new Error("offline"));
        await f.stop(failure === "dirty" ? "a" : "b");
        if (failure === "expired-pending") {
          const state = f.cursors.read("rollouts")!;
          f.cursors.write("rollouts", { ...state, pending: state.pending?.map(entry => ({ ...entry, at: Date.now() - PENDING_MAX_AGE_MS - 1 })) });
        }
      }
      const edited = failure === "pending" || failure === "dirty";
      if (edited) f.put("a", ["edited A1", "A2"]);
      await f.stop(edited ? "a" : "b");
      expect(f.documents.get("A")).toEqual([...(edited ? ["edited A1", "A2"] : ["A1"]), "B1", ...(failure === "pending" || failure === "expired-pending" ? ["B2"] : [])]);
      expect(f.retain.mock.calls.at(-1)?.[5]?.updateMode).toBeUndefined();
      expect(f.cursors.read("rollouts")?.dirty).toBeFalsy();
      expect(f.cursors.read("rollouts")?.pending).toBeUndefined();
    });
  });

  it("replays an append whose response was lost under its original operation ID without duplicating a segment", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a"); await f.stop("b");
      f.put("b", ["B1", "B2"]); f.loseResponse();
      await f.stop("b");
      const lost = f.retain.mock.calls.at(-1);
      await f.stop("b");
      expect(f.retain.mock.calls.at(-1)).toEqual(lost);
      expect(f.documents.get("A")).toEqual(["A1", "B1", "B2"]);
    });
  });

  it("starts the new bank from the current source without reading former-bank files", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a"); await f.stop("b");
      rmSync(f.path("a")); f.switchBank("B");
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "B1"]);
      expect(f.documents.get("B")).toEqual(["B1"]);
      expect(f.cursors.read("rollouts")?.paths).toEqual([f.path("b")]);
    });
  });

  it("refuses a moving copied-prefix boundary rather than duplicating new parent turns", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["A1", "B1"]);
      await f.stop("a"); await f.stop("b");
      f.put("a", ["A1", "A2"]); f.put("b", ["A1", "A2", "B1"]);
      const before = structuredClone(f.cursors.read("rollouts"));
      const writes = f.retain.mock.calls.length;
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "B1"]);
      expect(f.cursors.read("rollouts")).toEqual(before);
      expect(f.retain).toHaveBeenCalledTimes(writes);
    });
  });

  it("deduplicates a new rollout copying only the previous source and preserves first-contribution order", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]); f.put("c", ["B1", "C1"]);
      await f.stop("a"); await f.stop("b"); await f.stop("c");
      expect(f.documents.get("A")).toEqual(["A1", "B1", "C1"]);
      expect(f.cursors.read("rollouts")?.rollouts?.[2].copiedFrom).toBe(f.path("b"));
      f.put("a", ["A1", "A2"]);
      await f.stop("a");
      expect(f.documents.get("A")).toEqual(["A1", "A2", "B1", "C1"]);
      f.put("b", ["B1", "B2"]); f.put("c", ["B1", "B2", "C1"]);
      const writes = f.retain.mock.calls.length;
      await f.stop("c");
      expect(f.retain).toHaveBeenCalledTimes(writes);
      expect(f.documents.get("A")).toEqual(["A1", "A2", "B1", "C1"]);
    });
  });

  it.each(["growth", "edit"])("deduplicates a fresh whole-aggregate copy after unseen earlier-source %s", async (change) => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a"); await f.stop("b");
      const currentA = change === "growth" ? ["A1", "A2"] : ["edited A1"];
      f.put("a", currentA); f.put("c", [...currentA, "B1", "C1"]);
      await f.stop("c");
      expect(f.documents.get("A")).toEqual([...currentA, "B1", "C1"]);
      expect(f.cursors.read("rollouts")?.rollouts?.[2].fromTurn).toBe(currentA.length + 1);
      expect(f.cursors.read("rollouts")?.rollouts?.[2].copiedFrom).toBeUndefined();
    });
  });

  it.each(["self", "later", "unknown"])("refuses a %s copied-source reference", async (kind) => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["A1", "B1"]); f.put("c", ["C1"]);
      await f.stop("a"); await f.stop("b"); await f.stop("c");
      const state = f.cursors.read("rollouts")!;
      f.cursors.write("rollouts", { ...state, rollouts: state.rollouts!.map((segment, i) => i === 1 ? { ...segment, copiedFrom: f.path(kind === "self" ? "b" : kind === "later" ? "c" : "unknown") } : segment) });
      const before = structuredClone(f.cursors.read("rollouts"));
      await f.stop("b");
      expect(f.retain).toHaveBeenCalledTimes(3);
      expect(f.documents.get("A")).toEqual(["A1", "B1", "C1"]);
      expect(f.cursors.read("rollouts")).toEqual(before);
    });
  });

  it("retains synthesized replies until their exact content has materialized in the source", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a", { lastAssistantMessage: "unflushed reply" });
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "unflushed reply"]);
      expect(f.retain).toHaveBeenCalledTimes(1);
      writeFileSync(f.path("a"), [
        { type: "user", message: { content: "A1" }, timestamp: "2026-01-01T00:00:00Z" },
        { type: "assistant", message: { content: "unflushed reply" }, timestamp: "2026-01-01T00:00:01Z" },
      ].map(turn => JSON.stringify(turn)).join("\n"));
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "unflushed reply", "B1"]);
      expect(f.cursors.read("rollouts")?.rollouts?.[0].unflushed).toBeUndefined();
    });
  });

  it("uses the supplied harness reader for synthetic sources", async () => {
    await withRollouts(async f => {
      const sources = new Map<string, TransportTurn[]>([[f.path("a"), [{ role: "user", content: "A1" }]], [f.path("b"), [{ role: "user", content: "B1" }]]]);
      const readTranscript = (path: string) => sources.get(path) ?? [];
      await f.stop("a", { readTranscript }); await f.stop("b", { readTranscript });
      sources.get(f.path("a"))!.push({ role: "user", content: "A2" });
      await f.stop("a", { readTranscript });
      expect(f.documents.get("A")).toEqual(["A1", "A2", "B1"]);
    });
  });

  it("migrates a legacy single-source cursor without losing its source", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a");
      f.cursors.write("rollouts", { ...f.cursors.read("rollouts")!, rollouts: undefined });
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "B1"]);
    });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid copied offset %s without mutating retained state", async (fromTurn) => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); f.put("b", ["B1"]);
      await f.stop("a"); await f.stop("b");
      const state = f.cursors.read("rollouts")!;
      f.cursors.write("rollouts", { ...state, rollouts: state.rollouts!.map((entry, i) => i ? { ...entry, fromTurn } : entry) });
      const before = structuredClone(f.cursors.read("rollouts"));
      await f.stop("b");
      expect(f.documents.get("A")).toEqual(["A1", "B1"]);
      expect(f.cursors.read("rollouts")).toEqual(before);
      expect(f.retain).toHaveBeenCalledTimes(2);
    });
  });

  it("refuses duplicate rollout references", async () => {
    await withRollouts(async f => {
      f.put("a", ["A1"]); await f.stop("a");
      const state = f.cursors.read("rollouts")!;
      f.cursors.write("rollouts", { ...state, rollouts: [state.rollouts![0], state.rollouts![0]] });
      await f.stop("a");
      expect(f.retain).toHaveBeenCalledTimes(1);
      expect(f.documents.get("A")).toEqual(["A1"]);
    });
  });

  it("bounds multi-source reconstruction cardinality without altering the prior document", async () => {
    await withRollouts(async f => {
      const readTranscript = (path: string) => path === f.path("a") ? [{ role: "user", content: "A1" }] : Array.from({ length: 100_001 }, () => ({ role: "user", content: "x" }));
      await f.stop("a", { readTranscript });
      await f.stop("b", { readTranscript });
      expect(f.documents.get("A")).toEqual(["A1"]);
      expect(f.retain).toHaveBeenCalledTimes(1);
    });
  });

  it("bounds the aggregate even when every source is individually under the work limit", async () => {
    await withRollouts(async f => {
      const a = Array.from({ length: 60_000 }, () => ({ role: "user", content: "A" }));
      const b = Array.from({ length: 60_000 }, () => ({ role: "user", content: "B" }));
      const readTranscript = (path: string) => path === f.path("a") ? a : b;
      await f.stop("a", { readTranscript }); await f.stop("b", { readTranscript });
      expect(f.retain).toHaveBeenCalledTimes(1);
      expect(f.documents.get("A")).toHaveLength(60_000);
      expect(f.documents.get("A")?.every(content => content === "A")).toBe(true);
    });
  });

  it("preserves the single-source size contract and safely refuses oversized multi-source rebuilding", async () => {
    await withRollouts(async f => {
      const large = "x".repeat(32 * 1024 * 1024);
      const readTranscript = (path: string) => [{ role: "user", content: path === f.path("a") ? large : "B1" }];
      await f.stop("a", { readTranscript });
      expect(f.documents.get("A")?.[0].length).toBe(large.length);
      await f.stop("b", { readTranscript });
      expect(f.retain).toHaveBeenCalledTimes(1);
      expect(f.documents.get("A")).toHaveLength(1);
    });
  });
});

describe("renderSessionJsonl", () => {
  const turns: TransportTurn[] = [
    { role: "user", content: "Add retry backoff", timestamp: "2026-01-01T00:00:00Z" },
    { role: "assistant", content: "On it.", timestamp: "2026-01-01T00:00:01Z" },
    { role: "action", content: "Edit uploader.ts" },
  ];

  it("renders JSONL (one JSON object per line) led by the REF-ID system turn, preserving roles/content/timestamps", () => {
    const jsonl = renderSessionJsonl("conversation:s1", turns, "2026-01-01T00:00:00Z");
    const parsed = jsonl.split("\n").map((line) => JSON.parse(line) as TransportTurn);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({
      role: "system",
      content: "REF-ID: conversation:s1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(parsed[1]).toEqual({
      role: "user",
      content: "Add retry backoff",
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(parsed[2]).toEqual({
      role: "assistant",
      content: "On it.",
      timestamp: "2026-01-01T00:00:01Z",
    });
    // Compact action turns pass through untouched (no timestamp -> none serialized).
    expect(parsed[3]).toEqual({ role: "action", content: "Edit uploader.ts" });
  });

  it("empty turn list still yields the REF-ID system turn alone (exactly one line)", () => {
    const lines = renderSessionJsonl("r", [], "2026-01-01T00:00:00Z").split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]) as TransportTurn).toEqual({
      role: "system",
      content: "REF-ID: r",
      timestamp: "2026-01-01T00:00:00Z",
    });
  });
});

describe("retainLiveSession", () => {
  it("preserves every rollout in the cumulative document when an earlier rollout grows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retain-rollouts-"));
    try {
      const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
      const put = (path: string, texts: string[]) => writeFileSync(path, texts.map(content => JSON.stringify({ type: "user", message: { content }, timestamp: "2026-01-01T00:00:00Z" })).join("\n"));
      let document: string[] = [];
      const retain = vi.fn(async (content: string, _context: string, _documentId: string, _tags: string[], _strategy: string, opts: { updateMode?: string } = {}) => {
        const incoming = content.split("\n").map(line => JSON.parse(line)).filter(turn => turn.role !== "system").map(turn => turn.content);
        document = opts.updateMode === "append" ? [...document, ...incoming] : incoming;
      });
      const client = { bank: "A", retain, supportsAppendRetain: async () => true, bankUrl: (suffix: string) => suffix,
        req: vi.fn(async () => new Response('{"status":"completed"}')) };
      const cursors = memoryCursorStore();
      const stop = (path: string) => buildRetain({ harness: "codex", sessionId: "rollouts", transcriptPath: path, client, cursors, usageCursors: memoryUsageCursorStore() });
      put(a, ["A1"]); put(b, ["B1"]);
      await stop(a); await stop(b);
      expect(document).toEqual(["A1", "B1"]);
      put(a, ["A1", "A2"]);
      await stop(a);
      expect(document).toEqual(["A1", "A2", "B1"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("upserts the JSONL transcript under conversation:<id> with the unified conversation strategy", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;
    const turns: TransportTurn[] = [
      { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z" },
    ];

    await retainLiveSession(client, "s2", turns, "2026-01-01T00:00:00Z");

    expect(retain).toHaveBeenCalledTimes(1);
    const [content, context, documentId, tags, strategy, opts] = retain.mock.calls[0];
    // The retained content IS the renderSessionJsonl transcript.
    expect(content).toBe(renderSessionJsonl("conversation:s2", turns, "2026-01-01T00:00:00Z"));
    const parsed = (content as string).split("\n").map((line) => JSON.parse(line) as TransportTurn);
    expect(parsed[0]).toEqual({
      role: "system",
      content: "REF-ID: conversation:s2",
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(parsed[1]).toEqual({ role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z" });
    expect(context).toBe(DEFAULT_RETAIN_CONTEXT);
    expect(documentId).toBe("conversation:s2");
    expect(tags).toEqual(["source:chat"]);
    expect(strategy).toBe("conversation");
    expect(opts).toMatchObject({ timestamp: "2026-01-01T00:00:00Z" });
    expect(opts.metadata).toMatchObject({
      source: "chat",
      session_id: "s2",
      ref_id: "conversation:s2",
    });
  });

  it("sends the stamp's resolved context instead of the default when one is configured", async () => {
    // The default says nothing about authorship, so extraction can record an assistant's
    // proposal as the user's decision. This is the path a deployment uses to state the boundary.
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;
    const turns: TransportTurn[] = [
      { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z" },
    ];
    const configured = "Assistant turns are agent-generated and not the user's decisions.";

    await retainLiveSession(client, "s3", turns, "2026-01-01T00:00:00Z", undefined, {
      stamp: { tags: [], metadata: {}, context: configured },
    });

    const [, context] = retain.mock.calls[0];
    expect(context).toBe(configured);
  });

  it("keeps the default when a stamp carries tags but no context", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;
    const turns: TransportTurn[] = [
      { role: "user", content: "hi", timestamp: "2026-01-01T00:00:00Z" },
    ];

    await retainLiveSession(client, "s4", turns, "2026-01-01T00:00:00Z", undefined, {
      stamp: { tags: ["project:x"], metadata: {} },
    });

    const [, context] = retain.mock.calls[0];
    expect(context).toBe(DEFAULT_RETAIN_CONTEXT);
  });
});

describe("ingestChats", () => {
  it("applies per-session retain attribution while preserving built-in chat identity", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;

    await ingestChats(
      client,
      [{ id: "s-import", turns: [{ role: "user", text: "remember this" }] }],
      {
        stampFor: (sessionId) => ({
          tags: [`project:repo-a`, `session:${sessionId}`],
          metadata: { project: "repo-a", source: "configured" },
        }),
      }
    );

    expect(retain).toHaveBeenCalledTimes(1);
    const [, , , tags, , opts] = retain.mock.calls[0];
    expect(tags).toEqual(["project:repo-a", "session:s-import", "source:chat"]);
    expect(opts.metadata).toMatchObject({
      project: "repo-a",
      source: "chat",
      chat: "s-import",
      ref_id: "chat:s-import",
    });
  });

  it("dates a backfilled document from the session's own source timestamps, not the import clock", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;

    const importedAt = Date.now();
    await ingestChats(client, [
      {
        id: "s-hist",
        turns: [
          { role: "user", text: "pick the storage engine", timestamp: "2026-01-05T09:00:00Z" },
          { role: "assistant", text: "RocksDB.", timestamp: "2026-01-05T09:00:05Z" },
        ],
      },
    ]);

    const [content, , , , , opts] = retain.mock.calls[0];
    // The document/Event Date is the conversation's own first timestamp…
    expect(opts.timestamp).toBe("2026-01-05T09:00:00Z");
    // …and the REF-ID system turn that heads the transcript carries the same anchor.
    expect(JSON.parse(content.split("\n")[0]) as TransportTurn).toEqual({
      role: "system",
      content: "REF-ID: chat:s-hist",
      timestamp: "2026-01-05T09:00:00Z",
    });
    // The regression: an import in September must not date a January session to September.
    expect(Date.parse(opts.timestamp)).toBeLessThan(importedAt - 60_000);
  });

  it("keeps the synthetic import-time anchor when no turn carries a usable timestamp", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;

    const importedAt = Date.now();
    await ingestChats(client, [
      {
        id: "s-clockless",
        turns: [{ role: "user", text: "no clocks here", timestamp: "not-a-date" }],
      },
    ]);

    const [, , , , , opts] = retain.mock.calls[0];
    // Unparseable source values are ignored rather than trusted, so the stagger still applies.
    expect(Date.parse(opts.timestamp)).toBeGreaterThanOrEqual(importedAt - 1000);
  });

  it("anchors a timestamp-less turn to the session's own clock instead of the import clock", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = { retain } as unknown as HindsightClient;

    await ingestChats(client, [
      {
        id: "s-mixed",
        turns: [
          { role: "user", text: "dated", timestamp: "2026-01-05T09:00:00Z" },
          { role: "action", text: "undated follow-up" },
        ],
      },
    ]);

    const [content] = retain.mock.calls[0];
    const turns = content.split("\n").map((line: string) => JSON.parse(line) as TransportTurn);
    // The dated turn keeps its source value verbatim…
    expect(turns[1].timestamp).toBe("2026-01-05T09:00:00Z");
    // …and the undated one sits on the SESSION's timeline, not the import's. Index 0 is the REF-ID
    // system turn, so the action turn is index 2: fallback offset is `(j + 1)` minutes for j = 1.
    expect(turns[2].timestamp).toBe("2026-01-05T09:02:00.000Z");
  });
});

describe("retainLiveSession — incremental write-back", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const turn = (i: number): TransportTurn => ({ role: "user", content: `turn ${i}` });
  const turns = (n: number) => Array.from({ length: n }, (_, i) => turn(i));

  /** Client double: `supported` is the combined append capability. */
  const stubClient = (supported = true) => {
    const retain = vi.fn().mockResolvedValue(undefined);
    return {
      retain,
      client: {
        retain,
        bank: "coding-agent::repo",
        supportsAppendRetain: async () => supported,
      } as unknown as HindsightClient,
    };
  };

  const write = (client: HindsightClient, turnList: TransportTurn[], cursors: RetainCursorStore) =>
    retainLiveSession(client, "s1", turnList, "2026-01-01T00:00:00Z", "codex", { cursors });

  it("replaces when an accepted write's operation later failed (#5251)", async () => {
    const status = new Map<string, string>();
    const { retain, client } = stubClient();
    Object.assign(client, {
      bankUrl: (s: string) => s,
      req: vi.fn(async (_m: string, url: string) => {
        const st = status.get(url.split("/").pop()!);
        return new Response(JSON.stringify({ status: st }), { status: st ? 200 : 404 });
      }),
    });
    const cursors = memoryCursorStore();
    const opOf = (call: number) => retain.mock.calls[call][5].operationId as string;

    await write(client, turns(2), cursors);
    status.set(opOf(0), "completed");
    await write(client, turns(3), cursors);
    expect(retain.mock.calls[1][5].updateMode).toBe("append"); // completed: append is safe
    expect(cursors.read("s1")?.ops).toEqual([opOf(1)]);

    status.set(opOf(1), "failed"); // accepted, then extraction failed
    await write(client, turns(4), cursors);
    // The failed append's turn 2 is re-sent: the whole transcript, as a replace.
    expect(retain.mock.calls[2][5].updateMode).toBeUndefined();
    expect(retain.mock.calls[2][0]).toBe(
      renderSessionJsonl("conversation:s1", turns(4), "2026-01-01T00:00:00Z")
    );
    expect(cursors.read("s1")?.ops).toEqual([opOf(2)]);

    status.set(opOf(2), "pending"); // still running: tracked, append proceeds
    await write(client, turns(5), cursors);
    expect(retain.mock.calls[3][5].updateMode).toBe("append");
    expect(cursors.read("s1")?.ops).toEqual([opOf(2), opOf(3)]);
  });

  it("replaces on the first write, then appends only the new turns", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();

    await write(client, turns(2), cursors);
    const first = retain.mock.calls[0];
    expect(first[5].updateMode).toBeUndefined();
    expect(first[0]).toBe(renderSessionJsonl("conversation:s1", turns(2), "2026-01-01T00:00:00Z"));

    await write(client, turns(5), cursors);
    const second = retain.mock.calls[1];
    expect(second[5].updateMode).toBe("append");
    // Only the three new turns, and no REF-ID header: the document already carries one.
    expect((second[0] as string).split("\n").map((l) => JSON.parse(l) as TransportTurn)).toEqual([
      turn(2),
      turn(3),
      turn(4),
    ]);
    expect(second[2]).toBe("conversation:s1"); // same document id — append targets it
  });

  it("remembers a confirmed append capability, so a failed probe on a later Stop still appends (#4560)", async () => {
    const cursors = memoryCursorStore();
    await write(stubClient().client, turns(2), cursors);
    // The next Stop is a fresh hook process whose capability probe times out.
    const probe = vi.fn().mockRejectedValue(new Error("timeout"));
    const retain = vi.fn().mockResolvedValue(undefined);
    const next = {
      retain,
      bank: "coding-agent::repo",
      supportsAppendRetain: probe,
    } as unknown as HindsightClient;
    await write(next, turns(4), cursors);
    expect(probe).not.toHaveBeenCalled();
    expect(retain.mock.calls[0][5].updateMode).toBe("append");
  });

  it("records the probed write-back mode in the diag trail, so a dead append is visible (#5286)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-chat-diag-"));
    vi.stubEnv("HINDSIGHT_DIAG_FILE", join(dir, "diag.jsonl"));
    try {
      await write(stubClient(false).client, turns(2), memoryCursorStore());
      const events = readFileSync(join(dir, "diag.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(events).toContainEqual(
        expect.objectContaining({
          harness: "codex",
          event: "retain_mode",
          mode: "replace",
          appendSupported: false,
        })
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a stable v5 operation_id so a resubmitted write is not applied twice", async () => {
    const a = stubClient();
    const b = stubClient();
    await write(a.client, turns(3), memoryCursorStore());
    await write(b.client, turns(3), memoryCursorStore());
    const opId = a.retain.mock.calls[0][5].operationId;
    expect(opId).toMatch(UUID_RE);
    expect(b.retain.mock.calls[0][5].operationId).toBe(opId);
  });

  it("gives a different operation_id to a different payload", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    await write(client, turns(2), cursors);
    await write(client, turns(5), cursors);
    expect(retain.mock.calls[0][5].operationId).not.toBe(retain.mock.calls[1][5].operationId);
  });

  it("skips the write entirely when no turn was added", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    await write(client, turns(3), cursors);
    await write(client, turns(3), cursors);
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("buffers a failed append and replays it, instead of re-sending the whole transcript", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    await write(client, turns(2), cursors);

    retain.mockRejectedValueOnce(new Error("timeout"));
    await expect(write(client, turns(4), cursors)).rejects.toThrow("timeout");
    const failed = retain.mock.calls[1];
    // Not dirty: a failed append no longer condemns the session to full replacement (#3989). Its
    // turns are counted in the cursor because the buffer covers them.
    expect(cursors.read("s1")?.dirty).toBeUndefined();
    expect(cursors.read("s1")?.turns).toBe(4);
    expect(cursors.read("s1")?.pending).toHaveLength(1);

    await write(client, turns(6), cursors);
    // The buffered slice goes out FIRST, byte-for-byte under its original operation id, so a write
    // the server actually committed collapses into that operation instead of appending twice.
    const replay = retain.mock.calls[2];
    expect(replay[0]).toBe(failed[0]);
    expect(replay[5].operationId).toBe(failed[5].operationId);
    expect(replay[5].updateMode).toBe("append");
    // Then only what is new. The transcript is never re-sent, and never re-extracted.
    const tail = retain.mock.calls[3];
    expect(tail[5].updateMode).toBe("append");
    expect((tail[0] as string).split("\n").map((l) => JSON.parse(l) as TransportTurn)).toEqual([
      turn(4),
      turn(5),
    ]);
    expect(cursors.read("s1")).toEqual({
      turns: 6,
      fingerprint: expect.any(String),
      bank: "coding-agent::repo",
      appendSupported: true,
      // Accepted but never seen to complete (this stub cannot answer a status check): kept to check.
      ops: expect.arrayContaining([replay[5].operationId, tail[5].operationId]),
    });
  });

  it("drops a buffered append as soon as it lands, so a later failure cannot resend it", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    await write(client, turns(2), cursors);
    retain.mockRejectedValueOnce(new Error("timeout"));
    await expect(write(client, turns(4), cursors)).rejects.toThrow("timeout");

    // The replay lands; the new tail behind it does not.
    retain.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("timeout"));
    await expect(write(client, turns(6), cursors)).rejects.toThrow("timeout");
    const pending = cursors.read("s1")?.pending ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe(retain.mock.calls[3][0]);
  });

  it("stops flushing rather than starting a request the host deadline cannot fit", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    await write(client, turns(2), cursors);
    retain.mockRejectedValueOnce(new Error("timeout"));
    await expect(write(client, turns(4), cursors)).rejects.toThrow("timeout");

    // A budget that fits the replay and nothing after it: the new tail stays buffered for the next
    // write-back instead of overrunning the deadline the host kills the hook at.
    await retainLiveSession(client, "s1", turns(6), "2026-01-01T00:00:00Z", "codex", {
      cursors,
      retryUntil: Date.now(),
    });
    expect(retain).toHaveBeenCalledTimes(3);
    expect(cursors.read("s1")?.pending).toHaveLength(1);

    await write(client, turns(6), cursors);
    expect(retain).toHaveBeenCalledTimes(4);
    expect(cursors.read("s1")?.pending).toBeUndefined();
  });

  it("replaces again after a failed replace, which needs no buffer to be idempotent", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    retain.mockRejectedValueOnce(new Error("timeout"));
    await expect(write(client, turns(2), cursors)).rejects.toThrow("timeout");
    expect(cursors.read("s1")?.dirty).toBe(true);
    expect(cursors.read("s1")?.pending).toBeUndefined();

    await write(client, turns(4), cursors);
    expect(retain.mock.calls[1][5].updateMode).toBeUndefined();
    expect(retain.mock.calls[1][0]).toBe(
      renderSessionJsonl("conversation:s1", turns(4), "2026-01-01T00:00:00Z")
    );
  });

  it("replaces rather than replaying a buffer the server may no longer dedupe", async () => {
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    await write(client, turns(2), cursors);
    retain.mockRejectedValueOnce(new Error("timeout"));
    await expect(write(client, turns(4), cursors)).rejects.toThrow("timeout");

    const stale = cursors.read("s1");
    const pending = (stale?.pending ?? []).map((p) => ({
      ...p,
      at: p.at - PENDING_MAX_AGE_MS - 1,
    }));
    if (stale) cursors.write("s1", { ...stale, pending });

    await write(client, turns(6), cursors);
    const recovery = retain.mock.calls[2];
    expect(recovery[5].updateMode).toBeUndefined();
    expect(recovery[0]).toBe(
      renderSessionJsonl("conversation:s1", turns(6), "2026-01-01T00:00:00Z")
    );
    expect(cursors.read("s1")?.pending).toBeUndefined();
  });

  it("never appends when append support is unavailable", async () => {
    const { retain, client } = stubClient(false);
    const cursors = memoryCursorStore();
    await write(client, turns(2), cursors);
    await write(client, turns(5), cursors);
    expect(retain.mock.calls.map((c) => c[5].updateMode)).toEqual([undefined, undefined]);
    expect(retain.mock.calls[1][0]).toBe(
      renderSessionJsonl("conversation:s1", turns(5), "2026-01-01T00:00:00Z")
    );
  });

  it("replaces (never appends) when no cursor store is supplied", async () => {
    const { retain, client } = stubClient();
    await retainLiveSession(client, "s1", turns(2), "2026-01-01T00:00:00Z", "codex");
    await retainLiveSession(client, "s1", turns(5), "2026-01-01T00:00:00Z", "codex");
    expect(retain.mock.calls.map((c) => c[5].updateMode)).toEqual([undefined, undefined]);
  });

  it("serialises overlapping write-backs so neither appends a slice the other already sent", async () => {
    // The runtime fires retains without awaiting them: a turn-driven one and an idle-driven one can
    // overlap. Unserialised, both planned an append from the same cursor position and submitted
    // overlapping slices, duplicating turns inside the document.
    const submitted: { mode: string; turns: number }[] = [];
    const gates: (() => void)[] = [];
    const retain = vi.fn((content: string, ...rest: unknown[]) => {
      const o = rest[4] as { updateMode?: string };
      submitted.push({ mode: o.updateMode ?? "replace", turns: content.split("\n").length });
      return new Promise<void>((resolve) => gates.push(resolve));
    });
    const client = {
      retain,
      bank: "b",
      supportsAppendRetain: async () => true,
    } as unknown as HindsightClient;
    const cursors = memoryCursorStore();

    const first = write(client, turns(5), cursors);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]();
    await first;

    const a = write(client, turns(8), cursors);
    const b = write(client, turns(9), cursors);
    // Only ONE request is in flight: the second write-back waits for the first to be confirmed.
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(submitted).toHaveLength(2);
    gates[1]();
    await a;
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2]();
    await b;

    // 6 = REF-ID + 5 turns, then turns 5-7, then turn 8 alone — every turn sent exactly once.
    expect(submitted).toEqual([
      { mode: "replace", turns: 6 },
      { mode: "append", turns: 3 },
      { mode: "append", turns: 1 },
    ]);
  });

  it("keeps two sessions in the same directory independent", async () => {
    // Same repo => same bank, but each session owns its own document and its own cursor, so two
    // agents running side by side in one checkout never append into each other's conversation.
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    const writeAs = (id: string, list: TransportTurn[]) =>
      retainLiveSession(client, id, list, "2026-01-01T00:00:00Z", "codex", { cursors });

    await writeAs("sess-a", turns(2));
    await writeAs("sess-b", turns(4));
    await writeAs("sess-a", turns(3));

    const docs = retain.mock.calls.map((c) => c[2]);
    expect(docs).toEqual(["conversation:sess-a", "conversation:sess-b", "conversation:sess-a"]);
    // sess-b's longer transcript did not advance sess-a's cursor: its append is turn 2 alone.
    expect(retain.mock.calls[1][5].updateMode).toBeUndefined(); // first write for sess-b
    expect(retain.mock.calls[2][5].updateMode).toBe("append");
    expect((retain.mock.calls[2][0] as string).split("\n")).toHaveLength(1);
    expect(cursors.read("sess-a")?.turns).toBe(3);
    expect(cursors.read("sess-b")?.turns).toBe(4);
  });

  it("replaces rather than appends when the session moved to another bank", async () => {
    const sent: { bank: string; mode: string }[] = [];
    const mk = (bank: string) =>
      ({
        bank,
        supportsAppendRetain: async () => true,
        retain: vi.fn(async (_c: string, ...rest: unknown[]) => {
          sent.push({ bank, mode: (rest[4] as { updateMode?: string }).updateMode ?? "replace" });
        }),
      }) as unknown as HindsightClient;
    const cursors = memoryCursorStore();

    await write(mk("repo-a"), turns(5), cursors);
    await write(mk("repo-b"), turns(8), cursors); // user cd'd into another repo mid-session
    expect(sent).toEqual([
      { bank: "repo-a", mode: "replace" },
      { bank: "repo-b", mode: "replace" },
    ]);
  });

  it("stamps configured tags and metadata onto the write-back", async () => {
    const { retain, client } = stubClient();
    await retainLiveSession(client, "s1", turns(2), "2026-01-01T00:00:00Z", "codex", {
      cursors: memoryCursorStore(),
      stamp: { tags: ["project:acme-api", "env:work"], metadata: { repo: "acme-api" } },
    });
    expect(retain.mock.calls[0][3]).toEqual([
      "project:acme-api",
      "env:work",
      "source:chat",
      "harness:codex",
    ]);
    expect(retain.mock.calls[0][5].metadata).toMatchObject({
      repo: "acme-api",
      source: "chat",
      harness: "codex",
    });
  });

  it("keeps built-in metadata authoritative and does not double a tag", async () => {
    // The documents list filters on `source:chat` and draws its agent logo from `metadata.harness`,
    // so the built-ins are written last and win. (retainTags entries in those namespaces are
    // dropped earlier, at the source — see retain-stamp.test.ts.)
    const { retain, client } = stubClient();
    await retainLiveSession(client, "s1", turns(2), "2026-01-01T00:00:00Z", "codex", {
      cursors: memoryCursorStore(),
      stamp: {
        tags: ["source:chat", "env:work"],
        metadata: { harness: "not-codex", source: "elsewhere", session_id: "spoofed" },
      },
    });
    expect(retain.mock.calls[0][3]).toEqual(["source:chat", "env:work", "harness:codex"]);
    expect(retain.mock.calls[0][5].metadata).toMatchObject({
      harness: "codex",
      source: "chat",
      session_id: "s1",
    });
  });

  it("retries a rate-limited write-back instead of dropping it", async () => {
    const { retain, client } = stubClient();
    retain.mockRejectedValueOnce(new RateLimitedError(50));
    const cursors = memoryCursorStore();

    await write(client, turns(3), cursors);

    expect(retain).toHaveBeenCalledTimes(2);
    // The retry is the SAME payload, so its deterministic operation_id makes it a no-op server-side
    // if the first attempt actually landed.
    expect(retain.mock.calls[1][0]).toBe(retain.mock.calls[0][0]);
    expect(retain.mock.calls[1][5].operationId).toBe(retain.mock.calls[0][5].operationId);
    expect(cursors.read("s1")?.dirty).toBeFalsy(); // confirmed, not left dirty
  });

  it("gives up once a newer write-back has taken the cursor", async () => {
    // Ours is superseded: the newer one carries what we were sending, or replaces the document
    // outright because our failure left the cursor dirty. Retrying would burn a hook's remaining
    // time re-sending content already on its way.
    const { retain, client } = stubClient();
    const cursors = memoryCursorStore();
    retain.mockImplementationOnce(async () => {
      cursors.write("s1", { turns: 99, fingerprint: "someone-else", bank: "b", dirty: true });
      throw new RateLimitedError(50);
    });

    await expect(write(client, turns(3), cursors)).rejects.toBeInstanceOf(RateLimitedError);
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("honours a long Retry-After when the caller's clock has room for it", async () => {
    // A persistent-plugin runtime is not on a host's kill timer, so a 20s rate limit is worth
    // waiting out rather than deferring — the fixed 6s budget this replaced could not express that.
    vi.useFakeTimers();
    try {
      const { retain, client } = stubClient();
      retain.mockRejectedValueOnce(new RateLimitedError(20_000));
      const done = retainLiveSession(client, "s1", turns(3), "2026-01-01T00:00:00Z", "opencode", {
        cursors: memoryCursorStore(),
        retryUntil: Date.now() + 120_000,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await done;
      expect(retain).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a wait its caller's clock cannot finish", async () => {
    // Same 20s rate limit, but a hook with ~10s of host timeout left: waiting would be killed
    // mid-write. Defer instead — the next write-back replaces the whole document.
    const { retain, client } = stubClient();
    retain.mockRejectedValue(new RateLimitedError(20_000));

    await expect(
      retainLiveSession(client, "s1", turns(3), "2026-01-01T00:00:00Z", "codex", {
        cursors: memoryCursorStore(),
        retryUntil: Date.now() + 10_000,
      })
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("does not retry when Retry-After exceeds what a hook can wait", async () => {
    // Waiting less than the server asked would just earn another 429, and waiting the full 60s
    // risks the harness killing the hook mid-write. Leave it to the next write-back, which
    // replaces the whole document.
    const { retain, client } = stubClient();
    retain.mockRejectedValue(new RateLimitedError(60_000));

    await expect(
      retainLiveSession(client, "s1", turns(3), "2026-01-01T00:00:00Z", "codex", {
        cursors: memoryCursorStore(),
        retryUntil: Date.now() + 20_000,
      })
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("rides out a short rate limit across both attempts", async () => {
    const { retain, client } = stubClient();
    retain.mockRejectedValueOnce(new RateLimitedError(20));
    retain.mockRejectedValueOnce(new RateLimitedError(20));

    await write(client, turns(3), memoryCursorStore());
    expect(retain).toHaveBeenCalledTimes(3); // attempt + 2 retries, then success
  });

  it("does not retry a failure that is not a rate limit", async () => {
    const { retain, client } = stubClient();
    retain.mockRejectedValue(new Error("500 boom"));

    await expect(write(client, turns(3), memoryCursorStore())).rejects.toThrow("500 boom");
    expect(retain).toHaveBeenCalledTimes(1);
  });

  it("keeps the write-back when the capability probe itself fails", async () => {
    const retain = vi.fn().mockResolvedValue(undefined);
    const client = {
      retain,
      bank: "b",
      supportsAppendRetain: async () => {
        throw new Error("unreachable");
      },
    } as unknown as HindsightClient;
    await write(client, turns(2), memoryCursorStore());
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0][5].updateMode).toBeUndefined();
  });
});


describe("bank-specific append capabilities", () => {
  it.each([false, true])("reprobes a remapped bank whose append support is %s without settling old-bank operations", async (supported) => {
    const cursors = memoryCursorStore();
    const a = { bank: "A", retain: vi.fn().mockResolvedValue(undefined), supportsAppendRetain: vi.fn().mockResolvedValue(true) };
    const b = { bank: "B", retain: vi.fn().mockResolvedValue(undefined), supportsAppendRetain: vi.fn().mockResolvedValue(supported),
      req: vi.fn().mockImplementation(async () => Response.json({ status: "completed" })), bankUrl: (suffix: string) => `https://router.test/v1/default/banks/B${suffix}` };
    const first: TransportTurn[] = [{ role: "user", content: "one" }];
    await retainLiveSession(a as unknown as HindsightClient, "remapped", first, "2026-01-01T00:00:00Z", undefined, { cursors });
    const oldOps = cursors.read("remapped")?.ops ?? [];
    await retainLiveSession(b as unknown as HindsightClient, "remapped", first, "2026-01-01T00:00:00Z", undefined, { cursors });
    expect(b.supportsAppendRetain).toHaveBeenCalledOnce();
    expect(b.req).not.toHaveBeenCalled();
    expect(b.retain.mock.calls[0][5].updateMode).toBeUndefined();
    await retainLiveSession(b as unknown as HindsightClient, "remapped", [...first, { role: "assistant", content: "two" }],
      "2026-01-01T00:00:00Z", undefined, { cursors });
    expect(b.retain.mock.calls[1][5].updateMode).toBe(supported ? "append" : undefined);
    expect(b.req.mock.calls.every(([, url]) => oldOps.every(id => !String(url).endsWith(id)))).toBe(true);
    expect(cursors.read("remapped")?.bank).toBe("B");
  });
});

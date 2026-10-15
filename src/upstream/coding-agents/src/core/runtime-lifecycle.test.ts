import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config";
import type { HindsightClient } from "./hindsight";
import { MAX_RUNTIME_SESSIONS, RuntimeCore } from "./runtime";
import { createClineHooks } from "../cline";
import { createPiHooks } from "../harness/pi-extension";
import { opencodeAdapter } from "../harness/opencode";
import { diag } from "./diag";
import { wireOpencode2Runtime } from "../harness/opencode2";

vi.mock("@memory-router/coding-agents/runtime", async (original) => ({ ...(await original<typeof import("@memory-router/coding-agents/runtime")>()), managedToolPrefix: () => "hindsight_" }));
vi.mock("./diag", () => ({ diag: vi.fn() }));
vi.mock("./hook", () => ({ buildHookOutput: vi.fn(async () => ({ pages: [], context: "private memory" })) }));
vi.mock("./usage", async (original) => ({ ...(await original<typeof import("./usage")>()), recordUsage: vi.fn() }));
vi.mock("./skill-sync", () => ({ readPackagedSkill: () => undefined }));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  let fail = false;
  const retain = vi.fn(async (_text: string, _context: string, _id: string, _tags: string[], _strategy: string, _options: { updateMode?: string } = {}): Promise<void> => {
    if (fail) throw new Error("offline");
  });
  const client = { bank: "bank", retain, supportsAppendRetain: async () => true, assertAuthorized: () => {} } as unknown as HindsightClient;
  const core = new RuntimeCore(client, "bank", resolveConfig({}), "opencode2");
  const turns = [{ role: "user", content: "first" }, { role: "assistant", content: "reply" }];
  async function complete(id: string): Promise<void> {
    await core.onTranscript(id, turns, true);
    await core.flush();
  }
  async function fill(): Promise<void> {
    for (let i = 0; i < MAX_RUNTIME_SESSIONS; i++) await complete(`filler-${i}`);
  }
  return { core, retain, turns, complete, fill, fail: (value: boolean) => { fail = value; } };
}

describe("bounded runtime lifecycle", () => {
  it("forwards definitive OpenCode deletion and Pi shutdown to runtime disposal", async () => {
    const f = fixture();
    await f.core.onPrompt("deleted", "prompt");
    vi.spyOn(f.core, "toolSpecs").mockReturnValue([]);
    const hooks = opencodeAdapter.createRuntime?.(f.core) as { event(input: { event: { type: string; properties: { info: { id: string } } } }): Promise<void> };
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "deleted" } } } });
    expect(f.core.hasSession("deleted")).toBe(false);
    await f.core.onPrompt("shutdown", "prompt");
    await createPiHooks(f.core, "pi").sessionShutdown();
    expect(f.core.hasSession("shutdown")).toBe(false);
  });

  it("bounds Cline deduplication and remembers only the current prompt per session", async () => {
    const onPrompt = vi.fn(async () => {});
    const hooks = createClineHooks({ onPrompt, getInjection: () => undefined, onTranscript: async () => {} });
    const prompt = async (session: string, id: string): Promise<void> => {
      await hooks.beforeModel({ snapshot: { agentId: session, messages: [{ id, role: "user", content: [{ type: "text", text: "prompt" }], createdAt: 1 }] }, request: { messages: [] } });
    };
    await prompt("first", "one");
    await prompt("first", "one");
    expect(onPrompt).toHaveBeenCalledTimes(1);
    for (let i = 0; i < MAX_RUNTIME_SESSIONS; i++) await prompt(`other-${i}`, "one");
    await prompt("first", "one");
    expect(onPrompt).toHaveBeenCalledTimes(MAX_RUNTIME_SESSIONS + 2);
    for (let i = 0; i < MAX_RUNTIME_SESSIONS; i++) await prompt("first", `turn-${i}`);
    const calls = onPrompt.mock.calls.length;
    await prompt("first", `turn-${MAX_RUNTIME_SESSIONS - 1}`);
    expect(onPrompt).toHaveBeenCalledTimes(calls);
  });

  it("disposes many completed sessions and releases keyed and unkeyed injection", async () => {
    const f = fixture();
    for (let i = 0; i < MAX_RUNTIME_SESSIONS * 2; i++) {
      const id = `completed-${i}`;
      await f.core.onPrompt(id, "prompt");
      await f.complete(id);
      expect(f.core.hasSession(id)).toBe(true);
      f.core.disposeSession(id);
      expect(f.core.hasSession(id)).toBe(false);
      expect(f.core.getInjection(id)).toBeUndefined();
      expect(f.core.getInjection(undefined)).toBeUndefined();
    }
  });

  it("evicts idle sessions and replaces the complete transcript when an evicted session resumes", async () => {
    const f = fixture();
    await f.complete("resumed");
    await f.fill();
    expect(f.core.hasSession("resumed")).toBe(false);
    await f.core.onPrompt("resumed", "continue");
    await f.core.onTranscript("resumed", [...f.turns, { role: "user", content: "later" }], true);
    await f.core.flush();
    const last = f.retain.mock.calls.at(-1);
    expect(last?.[2]).toBe("conversation:resumed");
    expect(last?.[5]?.updateMode).not.toBe("append");
    expect(last?.[0]).toContain("first");
    expect(last?.[0]).toContain("later");
  });

  it("preserves an active session and never falls back to another session's injection", async () => {
    const f = fixture();
    await f.core.onPrompt("active", "prompt");
    await f.fill();
    expect(f.core.hasSession("active")).toBe(true);
    expect(f.core.getInjection("active")).toContain("private memory");
    expect(f.core.getInjection("foreign")).toBeUndefined();
  });

  it("rejects admission when every slot is active instead of evicting active sessions", async () => {
    const f = fixture();
    for (let i = 0; i < MAX_RUNTIME_SESSIONS; i++) await f.core.onPrompt(`active-${i}`, "prompt");
    await f.core.onPrompt("overflow", "prompt");
    expect(diag).toHaveBeenCalledWith("opencode2", "session_capacity_reached", { limit: MAX_RUNTIME_SESSIONS });
    expect(f.core.hasSession("overflow")).toBe(false);
    expect(f.core.getInjection("overflow")).toBeUndefined();
    expect(f.core.getInjection(undefined)).toBeUndefined();
    expect(f.core.hasSession("active-0")).toBe(true);
  });

  it("defers disposal until a retain settles and preserves pending appends on failure", async () => {
    const f = fixture();
    await f.complete("pending");
    f.fail(true);
    await f.core.onTranscript("pending", [...f.turns, { role: "user", content: "buffered" }], true);
    await f.core.flush();
    f.core.disposeSession("pending");
    await f.fill();
    f.fail(false);
    await f.core.onPrompt("pending", "retry");
    await f.core.onTranscript("pending", [...f.turns, { role: "user", content: "buffered" }], true);
    await f.core.flush();
    const writes = f.retain.mock.calls.filter(call => call[2] === "conversation:pending");
    expect(writes.at(-1)?.[5]?.updateMode).toBe("append");
    expect(writes.at(-1)?.[0]).toBe(writes[1][0]);
    f.core.disposeSession("pending");
    expect(f.core.hasSession("pending")).toBe(false);
  });

  it("keeps a disposed in-flight retain pinned until it settles, then resumes with a replacement", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    f.retain.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await f.core.onTranscript("writing", f.turns, true);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.core.disposeSession("writing");
    // Other traffic must not evict the cursor out from under the unfinished request.
    for (let i = 0; i < MAX_RUNTIME_SESSIONS; i++) await f.core.onTranscript(`other-${i}`, f.turns, true);
    release?.();
    await f.core.flush();
    expect(f.core.hasSession("writing")).toBe(false);
    await f.complete("writing");
    expect(f.retain.mock.calls.at(-1)?.[5]?.updateMode).not.toBe("append");
  });

  it("keeps an idle fetch pinned and does not close a newer prompt when the fetch finishes", async () => {
    const f = fixture();
    let release: ((turns: typeof f.turns) => void) | undefined;
    f.core.setTranscriptSource(() => new Promise(resolve => { release = resolve; }));
    const idle = f.core.onSessionIdle("fetching");
    await f.core.onPrompt("fetching", "new prompt");
    release?.(f.turns);
    await idle;
    await f.core.flush();
    await f.fill();
    expect(f.core.hasSession("fetching")).toBe(true);
  });

  it("admits new sessions after completed sessions fail to fetch their transcripts", async () => {
    const f = fixture();
    f.core.setTranscriptSource(async () => { throw new Error("host unavailable"); });
    for (let i = 0; i < MAX_RUNTIME_SESSIONS; i++) {
      await f.core.onPrompt(`failed-fetch-${i}`, "prompt");
      await f.core.onSessionIdle(`failed-fetch-${i}`);
    }
    const recoveredSource = vi.fn(async () => f.turns);
    f.core.setTranscriptSource(recoveredSource);
    await f.core.onPrompt("after-recovery", "prompt");
    expect(f.core.hasSession("after-recovery")).toBe(true);
    await f.core.onSessionIdle("after-recovery");
    await f.core.flush();
    expect(recoveredSource).toHaveBeenCalledExactlyOnceWith("after-recovery");
    expect(f.retain).toHaveBeenCalledOnce();
  });

  it("keeps a newer prompt active when an older idle transcript fetch fails", async () => {
    const f = fixture();
    let reject: ((error: Error) => void) | undefined;
    f.core.setTranscriptSource(() => new Promise((_resolve, rejectFetch) => { reject = rejectFetch; }));
    await f.core.onPrompt("fetching", "old prompt");
    const idle = f.core.onSessionIdle("fetching");
    await f.core.onPrompt("fetching", "new prompt");
    reject?.(new Error("host unavailable"));
    await idle;
    await f.fill();
    expect(f.core.hasSession("fetching")).toBe(true);
    expect(f.core.getInjection("fetching")).toContain("private memory");
  });

  it("denies global events for foreign or evicted sessions until a scoped prompt readmits them", async () => {
    const f = fixture();
    type Prompt = (input: { sessionID: string; prompt: { text: string } }) => Promise<void>;
    let prompt: Prompt | undefined;
    let next: ((event: { type: string; data: { sessionID: string } }) => void) | undefined;
    let done = false;
    const context = vi.fn(async () => [{ type: "user", text: "first" }]);
    vi.spyOn(f.core, "toolSpecs").mockReturnValue([]);
    const teardown = await wireOpencode2Runtime(f.core, {
      session: { hook: async (name: string, callback: Prompt) => { if (name === "prompt") prompt = callback; }, context },
      tool: { transform: async () => {} },
      event: { subscribe: async function* () {
        while (!done) yield await new Promise<{ type: string; data: { sessionID: string } }>(resolve => { next = resolve; });
      } },
    } as unknown as Parameters<typeof wireOpencode2Runtime>[1]);
    async function emit(sessionID: string, type = "session.idle"): Promise<void> {
      next?.({ type, data: { sessionID } });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    try {
      await prompt?.({ sessionID: "owned", prompt: { text: "prompt" } });
      await f.complete("owned");
      await f.fill();
      await emit("foreign");
      await emit("owned");
      expect(context).not.toHaveBeenCalled();
      await prompt?.({ sessionID: "owned", prompt: { text: "resumed" } });
      await emit("owned");
      expect(context).toHaveBeenCalledExactlyOnceWith({ sessionID: "owned" });
      await f.core.flush();
      await emit("owned", "session.deleted");
      expect(f.core.hasSession("owned")).toBe(false);
      await emit("owned");
      expect(context).toHaveBeenCalledTimes(1);
      await prompt?.({ sessionID: "image-only", prompt: { text: "" } });
      await emit("image-only");
      expect(context).toHaveBeenLastCalledWith({ sessionID: "image-only" });
      await f.core.flush();
    } finally {
      done = true;
      teardown();
      next?.({ type: "ignored", data: { sessionID: "" } });
    }
  });
});

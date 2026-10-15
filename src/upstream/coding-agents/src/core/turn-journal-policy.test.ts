import { managedReadScope } from "@memory-router/coding-agents/runtime";
import { pendingContextKey, stashPendingContext } from "./session-cache";
import { runSessionStartHook } from "./session-start";
import * as humanSession from "@memory-router/coding-agents/human-session";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOOK_HARNESSES } from "../harness/hook-lifecycle";
import type { LoadOptions, RawConfig } from "./config";
import type { HindsightClient } from "./hindsight";
import { runHook } from "./hook";
import { runRetainHook } from "./retain-hook";
import { journalPath, readJournalTranscript } from "./turn-journal";

const input = vi.hoisted(() => ({ stdin: "", configPath: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (target: unknown, ...rest: unknown[]) =>
      target === 0 ? input.stdin : (actual.readFileSync as (...args: unknown[]) => unknown)(target, ...rest),
  };
});

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    loadConfig: (opts: LoadOptions) => actual.loadConfig({ ...opts, path: input.configPath }),
  };
});

let root: string;
let approved: string;
let managedPath: string;
const sessionId = "policy-session";
const prompt = "PRIVATE_USER_PROMPT";
const reply = "PRIVATE_ASSISTANT_REPLY";
const spec = HOOK_HARNESSES.zcode;

function configure(raw: RawConfig = {}) {
  writeFileSync(input.configPath, JSON.stringify({ autoInject: "none", autoSeed: false, ...raw }));
}

function authorize(options: { mapped?: boolean; readOnly?: boolean; bank?: string } = {}) {
  writeFileSync(managedPath, JSON.stringify({
    routerUrl: "https://router.example.test",
    principals: {
      zcode: {
        ...(options.readOnly ? {} : { writeBank: "A" }),
        additionalReadBanks: ["A", "B"],
        tokenEnv: "JOURNAL_POLICY_TOKEN",
        mapPathToBank: options.mapped === false ? {} : { [approved]: options.bank ?? "A" },
      },
    },
  }));
}

function event(cwd = approved) {
  input.stdin = JSON.stringify({ session_id: sessionId, cwd, prompt, responseText: reply });
}

function clients() {
  const promptClient = {
    reflect: vi.fn().mockResolvedValue(""),
    listPages: vi.fn().mockResolvedValue([]),
    searchKnowledgePages: vi.fn().mockResolvedValue([]),
    recallObservations: vi.fn().mockResolvedValue([]),
  };
  const retainClient = {
    retain: vi.fn<HindsightClient["retain"]>().mockResolvedValue(undefined),
    supportsAppendRetain: vi.fn<HindsightClient["supportsAppendRetain"]>().mockResolvedValue(false),
  };
  return {
    makePrompt: vi.fn(() => promptClient),
    makeRetain: vi.fn(() => retainClient),
    retain: retainClient.retain,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "journal-policy-"));
  approved = join(root, "approved");
  mkdirSync(approved);
  input.configPath = join(root, "coding-agent.json");
  managedPath = join(root, "managed.json");
  vi.stubEnv("TMPDIR", root);
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", managedPath);
  vi.stubEnv("JOURNAL_POLICY_TOKEN", `mr_zcode_${"a".repeat(64)}`);
  vi.stubEnv("HINDSIGHT_DIAG_FILE", join(root, "diag.jsonl"));
  vi.stubEnv("HINDSIGHT_LOG_FILE", join(root, "plugin.log"));
  vi.stubEnv("HINDSIGHT_USAGE_FILE", join(root, "usage.jsonl"));
  vi.stubEnv("HINDSIGHT_DISABLE_HOOKS", "");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  configure();
  authorize();
  event();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("ZCode journal retention policy", () => {
  it.each<[string, RawConfig]>([
    ["global disablement", { disabled: true }],
    ["harness disablement", { harnesses: { zcode: { disabled: true } } }],
    ["bank disablement", { banks: { A: { disabled: true } } }],
    ["global retention opt-out", { retainSessions: false }],
    ["harness retention opt-out", { harnesses: { zcode: { retainSessions: false } } }],
    ["bank retention opt-out", { banks: { A: { retainSessions: false } } }],
  ])("does not journal prompts or replies after %s", async (_name, raw) => {
    configure(raw);
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(existsSync(journalPath("zcode", sessionId))).toBe(false);
    expect(client.makeRetain).not.toHaveBeenCalled();
  });

  it.each(["unmapped path", "symlink escaping a mapped path"])("denies %s before either journal write", async (scenario) => {
    if (scenario === "unmapped path") {
      authorize({ mapped: false });
    } else {
      const outside = join(root, "outside");
      mkdirSync(outside);
      const escaped = join(approved, "escape");
      symlinkSync(outside, escaped);
      event(escaped);
    }
    const client = clients();
    await expect(runHook(spec.prompt, client.makePrompt)).rejects.toThrow("memory access denied");
    await expect(runRetainHook(spec.retain, client.makeRetain)).rejects.toThrow("memory access denied");
    expect(existsSync(journalPath("zcode", sessionId))).toBe(false);
    expect(client.makePrompt).not.toHaveBeenCalled();
    expect(client.makeRetain).not.toHaveBeenCalled();
  });

  it.each([
    { readOnly: true, bank: "A" },
    { readOnly: false, bank: "B" },
  ])("keeps reads available without journaling a bank the principal cannot write: %j", async (principal) => {
    authorize(principal);
    configure({ retainSessions: true, banks: { [principal.bank]: { retainSessions: true } } });
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(client.makePrompt).toHaveBeenCalled();
    expect(client.makeRetain).not.toHaveBeenCalled();
    expect(existsSync(journalPath("zcode", sessionId))).toBe(false);
  });

  it("journals and retains an authorized conversation when its bank overrides a global opt-out", async () => {
    configure({ retainSessions: false, banks: { A: { retainSessions: true } } });
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(readJournalTranscript(journalPath("zcode", sessionId))).toMatchObject([
      { role: "user", content: prompt },
      { role: "assistant", content: reply },
    ]);
    expect(client.retain).toHaveBeenCalledWith(
      expect.stringContaining(prompt),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(client.retain.mock.calls[0][0]).toContain(reply);
  });

  it("preserves authorized turns before network work can fail", async () => {
    const unavailable = () => { throw new Error("router unavailable"); };
    await expect(runHook(spec.prompt, unavailable)).rejects.toThrow("router unavailable");
    await expect(runRetainHook(spec.retain, unavailable)).rejects.toThrow("router unavailable");
    expect(readJournalTranscript(journalPath("zcode", sessionId))).toMatchObject([
      { role: "user", content: prompt },
      { role: "assistant", content: reply },
    ]);
  });

  it("stops appending to an existing journal after retention is disabled", async () => {
    const client = clients();
    await runHook(spec.prompt, client.makePrompt);
    const path = journalPath("zcode", sessionId);
    const before = readFileSync(path, "utf8");
    configure({ banks: { A: { retainSessions: false } } });
    event();
    await runHook(spec.prompt, client.makePrompt);
    await runRetainHook(spec.retain, client.makeRetain);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(client.makeRetain).not.toHaveBeenCalled();
  });
});


describe("one-time tool-hook handoff authorization", () => {
  const hook = { ...spec.prompt, journalPrompt: false, toolHook: {
    accept: (ev: Record<string, unknown>) => ev.tool === true,
    emit: (context: string) => ({ deliveredContext: context }),
  } };
  it("delivers pending context only after a fresh guarded read, once", async () => {
    await runHook(hook, clients().makePrompt);
    const out = vi.mocked(process.stdout.write);
    out.mockClear();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ items: [] }));
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await runHook(hook, clients().makePrompt);
    expect(out.mock.calls.flat().join()).toContain("deliveredContext");
    expect(fetch.mock.calls[0][0]).toBe("https://router.example.test/v1/default/banks/A/documents?limit=1");
    out.mockClear();
    await runHook(hook, clients().makePrompt);
    expect(out).not.toHaveBeenCalled();
  });
  it.each([401, 403])("refuses pending memory after HTTP %s", async (status) => {
    await runHook(hook, clients().makePrompt);
    const out = vi.mocked(process.stdout.write);
    out.mockClear();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("SECRET_AUTH_BODY", { status }));
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    expect(out).not.toHaveBeenCalled();
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ items: [] }));
    await runHook(hook, clients().makePrompt);
    expect(out).not.toHaveBeenCalled();
  });

  it("refuses a handoff when an additional read bank is removed from managed scope", async () => {
    await runHook(hook, clients().makePrompt);
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    config.principals.zcode.additionalReadBanks = ["A"];
    writeFileSync(managedPath, JSON.stringify(config));
    const out = vi.mocked(process.stdout.write); out.mockClear();
    const fetch = vi.spyOn(globalThis, "fetch");
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await runHook(hook, clients().makePrompt);
    expect(out).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403])("reauthorizes additional banks and refuses server revocation HTTP %s", async (status) => {
    await runHook(hook, clients().makePrompt);
    const out = vi.mocked(process.stdout.write); out.mockClear();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
      String(url).includes("/banks/B/") ? new Response("SECRET_BODY", { status }) : Response.json({ items: [] }));
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://router.example.test/v1/default/banks/A/documents?limit=1",
      "https://router.example.test/v1/default/banks/B/documents?limit=1",
    ]);
    expect(out).not.toHaveBeenCalled();
    fetch.mockClear();
    await runHook(hook, clients().makePrompt);
    expect(fetch).not.toHaveBeenCalled(); // failure consumed the handoff
  });
  function pending(context = "ORIGINAL_MEMORY") {
    const scope = managedReadScope("zcode", approved);
    stashPendingContext("zcode", pendingContextKey(scope.endpoint, scope.bankId, approved, sessionId, scope), context);
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
  }

  it.each(["A", "B"])("accepts an authorized missing backend bank %s and still probes all banks", async (missing) => {
    pending();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
      String(url).includes(`/banks/${missing}/`) ? new Response(null, { status: 404 }) : Response.json({ items: [] }));
    await runHook(hook, clients().makePrompt);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://router.example.test/v1/default/banks/A/documents?limit=1",
      "https://router.example.test/v1/default/banks/B/documents?limit=1",
    ]);
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join()).toContain("ORIGINAL_MEMORY");
    vi.mocked(process.stdout.write).mockClear();
    await runHook(hook, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each([503, 429, "timeout", "network"])("preserves pending memory after %s for a later successful tool event", async (failure) => {
    pending();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      if (!String(url).includes("/banks/B/")) return Response.json({ items: [] });
      if (failure === "timeout") throw new DOMException("deadline", "TimeoutError");
      if (failure === "network") throw new TypeError("connection closed");
      return new Response(null, { status: failure as number });
    });
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    expect(process.stdout.write).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ items: [] }));
    await runHook(hook, clients().makePrompt);
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join()).toContain("ORIGINAL_MEMORY");
    vi.mocked(process.stdout.write).mockClear();
    await runHook(hook, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each([200, 503])("preserves new context produced while a probe returning %s is pending", async (status) => {
    pending();
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] })).mockReturnValueOnce(response);
    const attempt = runHook(hook, clients().makePrompt);
    pending("NEW_MEMORY");
    release(new Response(null, { status }));
    if (status === 503) {
      await expect(attempt).rejects.toThrow();
      expect(process.stdout.write).not.toHaveBeenCalled();
      await runHook(hook, clients().makePrompt);
    } else {
      await attempt;
    }
    expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0][0])).deliveredContext)
      .toBe("ORIGINAL_MEMORY\n\nNEW_MEMORY");
  });

  it("lets concurrent successful tool events deliver a block only once", async () => {
    pending();
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await ready;
      return Response.json({ items: [] });
    });
    const first = runHook(hook, clients().makePrompt);
    const second = runHook(hook, clients().makePrompt);
    release();
    await Promise.all([first, second]);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join()).toContain("ORIGINAL_MEMORY");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("discards pending memory before an overlapping successful probe can deliver it after denial", async () => {
    pending();
    const responses: ((response: Response) => void)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (responses.length < 4) return new Promise<Response>((resolve) => { responses.push(resolve); });
      return Response.json({ items: [] });
    });
    const denied = expect(runHook(hook, clients().makePrompt)).rejects.toThrow("memory access denied");
    const allowed = runHook(hook, clients().makePrompt);
    responses[0](new Response(null, { status: 403 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    responses[2](Response.json({ items: [] }));
    responses[3](Response.json({ items: [] }));
    await allowed;
    expect(process.stdout.write).not.toHaveBeenCalled();
    responses[1](Response.json({ items: [] }));
    await denied;
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("keeps transiently deferred context bound to its original human principal", async () => {
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    delete config.principals.zcode.tokenEnv;
    config.principals.zcode.human = { credentialRef: "person" };
    writeFileSync(managedPath, JSON.stringify(config));
    let principal = "human-first";
    vi.spyOn(humanSession, "readHumanSession").mockImplementation(() => ({
      token: `mrh_${"a".repeat(32)}_${"b".repeat(64)}`, principal_id: principal,
      expires_at: Math.floor(Date.now() / 1000) + 300, routerUrl: config.routerUrl,
    }));
    pending();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    principal = "human-second";
    fetch.mockClear();
    fetch.mockResolvedValue(Response.json({ items: [] }));
    await runHook(hook, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    principal = "human-first";
    await runHook(hook, clients().makePrompt);
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join()).toContain("ORIGINAL_MEMORY");
  });

  it.each(["endpoint", "mapping", "scope", "workspace", "session"])("does not move pending memory to a new %s after a transient failure", async (change) => {
    pending();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    const original = readFileSync(managedPath, "utf8");
    const config = JSON.parse(original);
    if (change === "endpoint") config.routerUrl = "https://router.moved.test";
    else if (change === "mapping") config.principals.zcode.mapPathToBank[approved] = "B";
    else if (change === "scope") config.principals.zcode.additionalReadBanks = ["A"];
    else if (change === "workspace") {
      const other = join(root, "other-workspace");
      mkdirSync(other);
      config.principals.zcode.mapPathToBank[other] = "A";
      input.stdin = JSON.stringify({ session_id: sessionId, cwd: other, tool: true });
    } else input.stdin = JSON.stringify({ session_id: "another-session", cwd: approved, tool: true });
    writeFileSync(managedPath, JSON.stringify(config));
    fetch.mockClear();
    fetch.mockResolvedValue(Response.json({ items: [] }));
    if (change === "workspace") await expect(runHook(hook, clients().makePrompt)).rejects.toThrow("memory access denied");
    else await runHook(hook, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    writeFileSync(managedPath, original);
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await runHook(hook, clients().makePrompt);
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join()).toContain("ORIGINAL_MEMORY");
  });

  it("binds the handoff to the actual human principal without storing its identifier or token", async () => {
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    delete config.principals.zcode.tokenEnv;
    config.principals.zcode.human = { credentialRef: "person" };
    writeFileSync(managedPath, JSON.stringify(config));
    let principal = "human-first";
    const token = `mrh_${"a".repeat(32)}_${"b".repeat(64)}`;
    vi.spyOn(humanSession, "readHumanSession").mockImplementation(() => ({ token, principal_id: principal,
      expires_at: Math.floor(Date.now() / 1000) + 300, routerUrl: config.routerUrl }));
    await runHook(hook, clients().makePrompt);
    principal = "human-second";
    const out = vi.mocked(process.stdout.write); out.mockClear();
    const fetch = vi.spyOn(globalThis, "fetch");
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await runHook(hook, clients().makePrompt);
    expect(fetch).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    const state = readdirSync(root, { recursive: true }).join();
    expect(state).not.toContain("human-first");
    expect(state).not.toContain(token);
  });
  it("rejects a human principal that changes while bank grants are being checked", async () => {
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    delete config.principals.zcode.tokenEnv;
    config.principals.zcode.human = { credentialRef: "person" };
    writeFileSync(managedPath, JSON.stringify(config));
    let principal = "human-first";
    vi.spyOn(humanSession, "readHumanSession").mockImplementation(() => ({
      token: `mrh_${"a".repeat(32)}_${"b".repeat(64)}`, principal_id: principal,
      expires_at: Math.floor(Date.now() / 1000) + 300, routerUrl: config.routerUrl,
    }));
    await runHook(hook, clients().makePrompt);
    const out = vi.mocked(process.stdout.write); out.mockClear();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      principal = "human-second";
      return Response.json({ items: [] });
    });
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    expect(out).not.toHaveBeenCalled();
    principal = "human-first";
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ items: [] }));
    await runHook(hook, clients().makePrompt);
    expect(out).not.toHaveBeenCalled();
  });
  it.each(["endpoint", "mapping", "scope"])("rejects a changed %s during awaited bank grant probes", async (change) => {
    await runHook(hook, clients().makePrompt);
    const out = vi.mocked(process.stdout.write); out.mockClear();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const config = JSON.parse(readFileSync(managedPath, "utf8"));
      if (change === "endpoint") config.routerUrl = "https://router.moved.test";
      else if (change === "mapping") config.principals.zcode.mapPathToBank[approved] = "B";
      else config.principals.zcode.additionalReadBanks = ["A"];
      writeFileSync(managedPath, JSON.stringify(config));
      return Response.json({ items: [] });
    });
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await expect(runHook(hook, clients().makePrompt)).rejects.toThrow();
    expect(out).not.toHaveBeenCalled();
    authorize();
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ items: [] }));
    await runHook(hook, clients().makePrompt);
    expect(out).not.toHaveBeenCalled();
  });
  it.each(["endpoint", "mapping"])("refuses to stash context when its %s changes during the producing read", async (change) => {
    const makeClient = () => ({ ...clients().makePrompt(), listPages: async () => {
      const config = JSON.parse(readFileSync(managedPath, "utf8"));
      if (change === "endpoint") config.routerUrl = "https://router.moved.test";
      else config.principals.zcode.mapPathToBank[approved] = "B";
      writeFileSync(managedPath, JSON.stringify(config));
      return [];
    } });
    await expect(runHook(hook, makeClient)).rejects.toThrow();
    expect(readdirSync(root, { recursive: true }).some(name => /\.pending(?:\.|$)/.test(String(name)))).toBe(false);
  });
  it.each(["endpoint", "mapping"])("does not stash SessionStart context after an awaited %s switch", async (change) => {
    configure({ codebaseSurvey: false });
    const makeClient = () => ({ listDocumentIds: async () => new Set<string>(), listPages: async () => {
      const config = JSON.parse(readFileSync(managedPath, "utf8"));
      if (change === "endpoint") config.routerUrl = "https://router.moved.test";
      else config.principals.zcode.mapPathToBank[approved] = "B";
      writeFileSync(managedPath, JSON.stringify(config));
      return [];
    } });
    await runSessionStartHook({ ...HOOK_HARNESSES.zcode.sessionStart, deferContextToToolHook: true }, makeClient);
    expect(readdirSync(root, { recursive: true }).some(name => /\.pending(?:\.|$)/.test(String(name)))).toBe(false);
    expect(vi.mocked(process.stdout.write)).not.toHaveBeenCalled();
  });
  it("cannot hand old bank memory to a newly mapped bank", async () => {
    await runHook(hook, clients().makePrompt);
    const out = vi.mocked(process.stdout.write);
    out.mockClear();
    authorize({ bank: "B" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ items: [] }));
    input.stdin = JSON.stringify({ session_id: sessionId, cwd: approved, tool: true });
    await runHook(hook, clients().makePrompt);
    expect(out).not.toHaveBeenCalled();
  });
});


describe("Grok handoff across working-directory changes", () => {
  const grok = HOOK_HARNESSES["grok-build"];

  beforeEach(() => {
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    config.principals["grok-build"] = config.principals.zcode;
    writeFileSync(managedPath, JSON.stringify(config));
    configure({ codebaseSurvey: false });
  });

  function grokEvent(cwd: string, tool = false) {
    input.stdin = JSON.stringify({ sessionId, cwd, prompt, hookEventName: tool ? "post_tool_use" : "user_prompt_submit" });
  }

  async function produce(source: string, cwd = approved) {
    grokEvent(cwd);
    if (source === "SessionStart") {
      await runSessionStartHook(grok.sessionStart, () => ({
        ...clients().makePrompt(), listDocumentIds: async () => new Set<string>(),
      }));
    } else await runHook(grok.prompt, clients().makePrompt);
    vi.mocked(process.stdout.write).mockClear();
  }

  it.each(["SessionStart", "UserPromptSubmit"])("delivers %s context after cd into a project subdirectory, once", async (source) => {
    const nested = join(approved, "src");
    mkdirSync(nested);
    await produce(source);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
    grokEvent(nested, true);
    await runHook(grok.prompt, clients().makePrompt);
    const output = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0] ?? "null"));
    expect(output?.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse", additionalContext: expect.any(String) });
    expect(output.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://router.example.test/v1/default/banks/A/documents?limit=1",
      "https://router.example.test/v1/default/banks/B/documents?limit=1",
    ]);
    vi.mocked(process.stdout.write).mockClear();
    grokEvent(approved, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("shares one handoff between SessionStart at root, a prompt in a subdirectory, and a root tool event", async () => {
    const nested = join(approved, "src");
    mkdirSync(nested);
    await produce("SessionStart");
    await produce("UserPromptSubmit", nested);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
    grokEvent(approved, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    vi.mocked(process.stdout.write).mockClear();
    grokEvent(nested, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("discards the original handoff when its anchor mapping is removed during awaited probes", async () => {
    const nested = join(approved, "src");
    mkdirSync(nested);
    await produce("UserPromptSubmit");
    const original = readFileSync(managedPath, "utf8");
    const config = JSON.parse(original);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      config.principals["grok-build"].mapPathToBank = { [nested]: "A" };
      writeFileSync(managedPath, JSON.stringify(config));
      return Response.json({ items: [] });
    });
    grokEvent(nested, true);
    await expect(runHook(grok.prompt, clients().makePrompt)).rejects.toThrow("memory access denied");
    expect(process.stdout.write).not.toHaveBeenCalled();
    writeFileSync(managedPath, original);
    fetch.mockResolvedValue(Response.json({ items: [] }));
    grokEvent(approved, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each(["SessionStart", "UserPromptSubmit"])("delivers %s context from a stable root alias to its physical descendant", async (source) => {
    const physical = join(approved, "project");
    const nested = join(physical, "src");
    const alias = join(root, "session-root");
    mkdirSync(nested, { recursive: true });
    symlinkSync(physical, alias);
    await produce(source, alias);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
    grokEvent(nested, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    vi.mocked(process.stdout.write).mockClear();
    grokEvent(alias, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each([
    ["SessionStart", "before", "alias"], ["UserPromptSubmit", "before", "alias"],
    ["SessionStart", "before", "physical"], ["UserPromptSubmit", "before", "physical"],
    ["SessionStart", "during", "alias"], ["UserPromptSubmit", "during", "alias"],
  ])("keeps %s context out of a replacement workspace when its root alias changes %s probes (%s cwd)", async (source, when, spelling) => {
    const first = join(approved, "first");
    const second = join(approved, "second");
    const alias = join(root, "session-root");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias);
    await produce(source, alias);
    const retarget = () => { rmSync(alias); symlinkSync(second, alias); };
    if (when === "before") retarget();
    let changed = when === "before";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (!changed) { retarget(); changed = true; }
      return Response.json({ items: [] });
    });
    grokEvent(spelling === "physical" ? second : alias, true);
    const attempt = runHook(grok.prompt, clients().makePrompt);
    if (when === "during") await expect(attempt).rejects.toThrow("memory access denied");
    else await attempt;
    expect(process.stdout.write).not.toHaveBeenCalled();
    if (when === "before") expect(fetch).not.toHaveBeenCalled();
    else {
      rmSync(alias);
      symlinkSync(first, alias);
      grokEvent(alias, true);
      await runHook(grok.prompt, clients().makePrompt);
      expect(process.stdout.write).not.toHaveBeenCalled();
    }
  });

  it.each(["SessionStart", "UserPromptSubmit"])("does not publish %s context into a replacement root while its client read awaits", async (source) => {
    const first = join(approved, "first");
    const second = join(approved, "second");
    const alias = join(root, "session-root");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias);
    const scope = managedReadScope("grok-build", alias);
    const makeClient = () => ({
      ...clients().makePrompt(),
      listDocumentIds: async () => new Set<string>(),
      readScope: () => ({ endpoint: scope.endpoint, bankId: scope.bankId, identity: scope.identity, banks: scope.banks }),
      listPages: async () => { rmSync(alias); symlinkSync(second, alias); return []; },
    });
    grokEvent(alias);
    if (source === "SessionStart") await runSessionStartHook(grok.sessionStart, makeClient);
    else await expect(runHook(grok.prompt, makeClient)).rejects.toThrow("memory access denied");
    vi.mocked(process.stdout.write).mockClear();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
    grokEvent(alias, true);
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  function timedAuthorization() {
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    config.principals["grok-build"].additionalReadBanks = ["A", "B", "C"];
    writeFileSync(managedPath, JSON.stringify(config));
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
  }

  function delayedResponse(milliseconds: number | undefined, status: number, signal?: AbortSignal | null): Promise<Response> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = milliseconds === undefined ? undefined : setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(new Response(null, { status }));
      }, milliseconds);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  it("delivers after three individually successful 11-second bank probes within the Grok tool deadline", async () => {
    timedAuthorization();
    await produce("UserPromptSubmit");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      delayedResponse(11_000, 200, init?.signal));
    grokEvent(approved, true);
    const started = Date.now();
    let complete = false;
    const attempt = runHook(grok.prompt, clients().makePrompt).then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(complete).toBe(true);
    await attempt;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    const hostTimeout = grok.additionalHooks?.find((registration) => registration.event === "PostToolUse")?.timeout;
    expect(hostTimeout).toBe(30);
    expect(Date.now() - started).toBeLessThan((hostTimeout ?? 0) * 1000);
  });

  it("bounds all stalled bank probes below the host deadline and retains context for a successful retry", async () => {
    timedAuthorization();
    await produce("UserPromptSubmit");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      delayedResponse(undefined, 200, init?.signal));
    grokEvent(approved, true);
    let error: unknown;
    const attempt = runHook(grok.prompt, clients().makePrompt).catch((failure) => { error = failure; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(error).toBeInstanceOf(Error);
    await attempt;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new Set(fetch.mock.calls.map(([, init]) => init?.signal)).size).toBe(1);
    expect(process.stdout.write).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ items: [] }));
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("does not let an early transient hide sibling HTTP %s while another bank stalls", async (status) => {
    timedAuthorization();
    await produce("UserPromptSubmit");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("/banks/A/")) return delayedResponse(1000, 503, init?.signal);
      if (String(url).includes("/banks/B/")) return delayedResponse(12_000, status, init?.signal);
      return delayedResponse(undefined, 200, init?.signal);
    });
    grokEvent(approved, true);
    let error: unknown;
    const attempt = runHook(grok.prompt, clients().makePrompt).catch((failure) => { error = failure; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(error).toMatchObject({ message: "memory access denied" });
    await attempt;
    expect(process.stdout.write).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ items: [] }));
    await runHook(grok.prompt, clients().makePrompt);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it.each(["unmapped", "different bank", "another workspace", "symlink escape"])("does not deliver old workspace memory after moving into %s", async (boundary) => {
    await produce("UserPromptSubmit");
    const next = join(root, "other-workspace");
    mkdirSync(next);
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    let cwd = next;
    if (boundary === "different bank") {
      cwd = join(approved, "different-bank");
      mkdirSync(cwd);
      config.principals["grok-build"].mapPathToBank[cwd] = "B";
    } else if (boundary !== "unmapped") {
      config.principals["grok-build"].mapPathToBank[next] = "A";
      if (boundary === "symlink escape") {
        cwd = join(approved, "escape");
        symlinkSync(next, cwd);
      }
    }
    writeFileSync(managedPath, JSON.stringify(config));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
    grokEvent(cwd, true);
    await expect(runHook(grok.prompt, clients().makePrompt)).rejects.toThrow("memory access denied");
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rechecks the recorded root's current mapping instead of using its cached authorization", async () => {
    const nested = join(approved, "src");
    mkdirSync(nested);
    await produce("UserPromptSubmit");
    const config = JSON.parse(readFileSync(managedPath, "utf8"));
    config.principals["grok-build"].mapPathToBank = { [nested]: "A" };
    writeFileSync(managedPath, JSON.stringify(config));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ items: [] }));
    grokEvent(nested, true);
    await expect(runHook(grok.prompt, clients().makePrompt)).rejects.toThrow("memory access denied");
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

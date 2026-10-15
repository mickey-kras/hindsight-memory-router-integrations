import { execFileSync } from "node:child_process";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { buildSessionStartContext } from "./session-start";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@memory-router/shared/bank-access";
import { managedBank } from "@memory-router/coding-agents/runtime";
import { ensureDaemon } from "./daemon";
import { applyBankConfig, loadConfig, resolveConfig } from "./config";
import { HindsightClient } from "./hindsight";

let directory: string;
let configPath: string;
const credential = `mr_codex_${"b".repeat(64)}`;
function managed(routerUrl: unknown) {
  writeFileSync(configPath, JSON.stringify({ routerUrl, principals: {
    codex: { tokenEnv: "ROUTER_CLIENT_TEST_TOKEN", writeBank: "A", additionalReadBanks: ["B"], mapPathToBank: { [directory]: "A" } },
    reader: { tokenEnv: "ROUTER_CLIENT_TEST_TOKEN", additionalReadBanks: ["A"], mapPathToBank: { [directory]: "A" } },
  } }));
}
function client(harness = "codex") {
  return new HindsightClient({ routerHarness: harness, apiUrl: "https://router.test", bank: "A" });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "router-client-"));
  configPath = join(directory, "managed.json");
  managed("https://router.test");
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", configPath);
  vi.stubEnv("ROUTER_CLIENT_TEST_TOKEN", credential);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

it("routes every document, page, seed and operation request through the configured facade", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/version")) return Response.json({ api_version: "0.10.2" });
    if (path.endsWith("/reflect")) return Response.json({ text: "safe reflection" });
    if (path.endsWith("/recall")) return Response.json({ results: [{ text: "safe recall" }] });
    if (path.endsWith("/operations/op")) return Response.json({ status: "completed" });
    if (path.endsWith("/folders")) return Response.json({ id: "folder" });
    if (path.endsWith("/pages") && init?.method === "POST") return Response.json({ id: "page" });
    return Response.json({ roots: [], items: [], total: 0, operation_id: "op", results: [] });
  });
  const c = client();
  await c.retain("git data", "context", "git:sha", ["source:git"], "git");
  await c.retain("chat data", "context", "chat:session", ["source:chat"], "conversation");
  await c.recallObservations("query", { timeoutMs: 100 });
  await c.reflect("query", { timeoutMs: 100 });
  await c.listDocumentIds("source:git");
  await c.deleteDocument("doc");
  await c.activeOperations();
  await c.drain(["op"], "test", 100);
  await c.supportsIdempotentRetain();
  await c.listPages();
  await c.getPage("page");
  await c.searchKnowledgePages("query");
  await c.configureBank();
  await c.captureInitiative({ title: "Feature", summary: "Safe summary" });
  expect(send.mock.calls.some(([url]) => /\/(?:config|import)$/.test(String(url)))).toBe(false);
  expect(send.mock.calls.some(([url, init]) => String(url) === "https://router.test/v1/default/banks/A" && init?.method === "DELETE")).toBe(false);
  expect(send.mock.calls.some(([url, init]) => String(url).endsWith("/knowledge-base/pages") && init?.method === "POST")).toBe(true);
  for (const [url, init] of send.mock.calls) {
    expect(String(url)).toMatch(/^https:\/\/router\.test\/(?:(?:v1\/)?version|v1\/default\/banks\/[AB]\/)/);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
    expect(new Headers(init?.headers).get("x-memory-router-agent")).toBe("codex");
    expect(init?.redirect).toBe("error");
  }
});

it.each(["src/foo.ts", "coverage100%", "C:\\project"])("preserves coding-agent search text %s", async (query) => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  await client().searchKnowledgePages(query);
  expect(send).toHaveBeenCalledOnce();
  const url = new URL(String(send.mock.calls[0][0]));
  expect(url.pathname).toBe("/v1/default/banks/A/knowledge-base/search");
  expect(url.searchParams.get("q")).toBe(query);
});
it.each([undefined, "", "http://localhost:8888", "invalid", "https://api.hindsight.vectorize.io", "https://user:secret@router.test", "https://router.test?secret=1"])("rejects invalid managed endpoints %s before any request", (endpoint) => {
  managed(endpoint);
  const send = vi.spyOn(globalThis, "fetch");
  expect(() => client()).toThrow();
  expect(send).not.toHaveBeenCalled();
});
it("rejects direct URLs, missing config, unmapped projects and local deployment without fallback", async () => {
  const send = vi.spyOn(globalThis, "fetch");
  expect(() => new HindsightClient({ routerHarness: "codex", apiUrl: "https://api.hindsight.vectorize.io", bank: "A" })).toThrow(AccessDeniedError);
  await expect(client().req("GET", "https://upstream.test/v1/default/banks/A/config")).rejects.toThrow(AccessDeniedError);
  expect(() => managedBank("codex", tmpdir())).toThrow(AccessDeniedError);
  await expect(ensureDaemon(resolveConfig({ serverMode: "daemon" }), "codex")).rejects.toThrow(AccessDeniedError);
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", "");
  expect(() => client()).toThrow(AccessDeniedError);
  expect(send).not.toHaveBeenCalled();
});
it("rejects normal-config direct deployment settings and keeps the managed mapping", () => {
  const path = join(directory, "normal.json");
  for (const settings of [{ apiUrl: "https://upstream.test" }, { serverMode: "daemon" }, { serverMode: "cloud" }]) {
    writeFileSync(path, JSON.stringify(settings));
    expect(() => loadConfig({ harness: "codex", path })).toThrow(AccessDeniedError);
  }
  writeFileSync(path, JSON.stringify({ apiUrl: "https://router.test/", apiToken: "ignored" }));
  expect(loadConfig({ harness: "codex", path })).toMatchObject({ apiUrl: "https://router.test", apiToken: undefined });
  expect(managedBank("codex", directory)).toBe("A");
});

it.each([401, 403])("fails closed on %s in probes, drain and folder creation", async (status) => {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(credential, { status }));
  for (const operation of [
    (c: HindsightClient) => c.supportsIdempotentRetain(),
    (c: HindsightClient) => c.configureBank(),
    (c: HindsightClient) => c.ensureFolder("Initiatives"),
    (c: HindsightClient) => c.drain(["op"], "test", 100),
    (c: HindsightClient) => c.recallObservations("query", { timeoutMs: 100 }),
    (c: HindsightClient) => c.reflect("query", { timeoutMs: 100 }),
  ]) {
    const c = client();
    await expect(operation(c)).rejects.toThrow(/(?:access|authorization) denied/);
    const count = send.mock.calls.length;
    await expect(c.retain("data", "context", "doc", [], "document")).rejects.toThrow("memory access denied");
    expect(send).toHaveBeenCalledTimes(count);
  }
});
it.each([401, 403])("fails closed when routed page seeding returns %s", async (status) => {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url).endsWith("/knowledge-base/tree")
      ? Response.json({ roots: [] })
      : new Response(credential, { status })
  );
  const c = client();
  await expect(c.configureBank()).rejects.toThrow(AccessDeniedError);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0]).toBe("https://router.test/v1/default/banks/A/knowledge-base/pages");
  await expect(c.configureBank()).rejects.toThrow(AccessDeniedError);
  expect(send).toHaveBeenCalledTimes(2);
});
it.each([{ reset: true }, { manage: true }])("rejects operator-owned provisioning %j before any request", async (opts) => {
  const send = vi.spyOn(globalThis, "fetch");
  await expect(client().configureBank(opts)).rejects.toThrow(AccessDeniedError);
  expect(send).not.toHaveBeenCalled();
});
it.each([{}, { manage: false }])("seeds pages without reading or modifying bank configuration %j", async (opts) => {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/knowledge-base/tree")) return Response.json({ roots: [] });
    if (String(url).endsWith("/knowledge-base/pages") && init?.method === "POST") return Response.json({ id: "page" });
    throw new Error("unexpected provisioning request");
  });
  await client().configureBank(opts);
  expect(send.mock.calls[0][0]).toBe("https://router.test/v1/default/banks/A/knowledge-base/tree");
  expect(send.mock.calls.length).toBeGreaterThan(1);
  for (const [url, init] of send.mock.calls.slice(1)) {
    expect(url).toBe("https://router.test/v1/default/banks/A/knowledge-base/pages");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toHaveProperty("source_query");
  }
});
it("keeps page capability unknown on redacted 404 without attempting bank provisioning", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
  await expect(client().configureBank()).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][0]).toBe("https://router.test/v1/default/banks/A/knowledge-base/tree");
});

it("preserves read-only identity and refuses writes before fetch", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ results: [] }));
  const c = client("reader");
  await c.recallObservations("query", { timeoutMs: 100 });
  await expect(c.retain("data", "context", "doc", [], "document")).rejects.toThrow(AccessDeniedError);
  expect(send).toHaveBeenCalledTimes(1);
  expect(new Headers(send.mock.calls[0][1]?.headers).get("x-memory-router-agent")).toBe("reader");
});
it("tolerates page-creation conflicts without leaking router response bodies", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(credential, { status: 409 }));
  const response = await client().req("POST", client().bankUrl("/knowledge-base/pages"), { name: "Page" }, [409]);
  expect(response.status).toBe(409);
  expect(await response.text()).toBe("");
  expect(send).toHaveBeenCalledTimes(1);
});

it("cancels every assigned-bank recall at the caller's remaining deadline", async () => {
  vi.useFakeTimers();
  try {
    const signals: AbortSignal[] = [];
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing recall cancellation signal");
      signals.push(signal);
      return new Promise<Response>(() => {});
    });
    const pending = client().recallObservations("query", { timeoutMs: 7_000 });
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([]);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it.each([401, 403])("shares explicit-bank %s denial across root and sibling views until token rotation", async status => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("denied", { status }))
    .mockImplementation(async () => Response.json({ results: [] }));
  const readerToken = `mr_reader_${"d".repeat(64)}`;
  const managedConfig = JSON.parse(readFileSync(configPath, "utf8"));
  managedConfig.principals.reader.tokenEnv = "ROUTER_READER_TEST_TOKEN";
  writeFileSync(configPath, JSON.stringify(managedConfig));
  vi.stubEnv("ROUTER_READER_TEST_TOKEN", readerToken);
  const unrelated = client("reader");
  const root = client();
  const selected = root.forBank("B");
  const sibling = root.forBank("A");
  await expect(selected.searchKnowledgePages("query")).rejects.toThrow(AccessDeniedError);
  await expect(root.searchKnowledgePages("query")).rejects.toThrow(AccessDeniedError);
  await expect(sibling.searchKnowledgePages("query")).rejects.toThrow(AccessDeniedError);
  expect(() => root.forBank("B")).toThrow(AccessDeniedError);
  expect(send).toHaveBeenCalledTimes(1);
  await unrelated.searchKnowledgePages("query");
  expect(new Headers(send.mock.calls[1][1]?.headers).get("Authorization")).toBe(`Bearer ${readerToken}`);
  expect(new Headers(send.mock.calls[1][1]?.headers).get("x-memory-router-agent")).toBe("reader");
  const rotated = `mr_codex_${"c".repeat(64)}`;
  vi.stubEnv("ROUTER_CLIENT_TEST_TOKEN", rotated);
  await selected.searchKnowledgePages("query");
  await root.searchKnowledgePages("query");
  await sibling.searchKnowledgePages("query");
  await root.forBank("B").searchKnowledgePages("query");
  expect(send.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    "/v1/default/banks/B/knowledge-base/search", "/v1/default/banks/A/knowledge-base/search",
    "/v1/default/banks/B/knowledge-base/search",
    "/v1/default/banks/A/knowledge-base/search", "/v1/default/banks/A/knowledge-base/search",
    "/v1/default/banks/B/knowledge-base/search",
  ]);
  for (const [, init] of send.mock.calls.slice(2)) {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${rotated}`);
    expect(new Headers(init?.headers).get("x-memory-router-agent")).toBe("codex");
  }
});


it("uses both guarded version routes before selecting append and honours bank document storage", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).endsWith("/v1/version")) return new Response(null, { status: 404 });
    if (String(url).endsWith("/version")) return Response.json({ api_version: "1.0.0" });
    return Response.json({ config: { store_document_text: false } });
  });
  await expect(client().supportsAppendRetain()).resolves.toBe(false);
  expect(send.mock.calls.map(([url]) => String(url))).toEqual([
    "https://router.test/v1/version", "https://router.test/version", "https://router.test/v1/default/banks/A/config",
  ]);
});
it.each([401, 403])("does not try a fallback after version probe authorization failure %s", async (status) => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("SECRET_BODY", { status }));
  const c = client();
  await expect(c.supportsAppendRetain()).rejects.toThrow(AccessDeniedError);
  await expect(c.hasDocuments()).rejects.toThrow(AccessDeniedError);
  expect(send).toHaveBeenCalledOnce();
});
it("guards new document freshness reads and denies initiative writes to extra read banks", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ items: [{ id: "gitlog:repo", tags: ["head:abc"] }], total: 1 }));
  const c = client().forBank("B");
  await expect(c.hasDocuments()).resolves.toBe(true);
  await expect(c.documentTags("gitlog:repo")).resolves.toEqual(["head:abc"]);
  await expect(c.captureInitiative({ title: "change", summary: "plan" })).rejects.toThrow(AccessDeniedError);
  expect(send.mock.calls.every(([url, init]) => String(url).includes("/banks/B/") && init?.method === "GET")).toBe(true);
});

it.each([[400, 1], [500, 12]])("bounds guarded HTTP %s operation polling to %s calls", async (status, calls) => {
  vi.useFakeTimers();
  try {
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("SECRET_BODY", { status }));
    const log = vi.fn();
    const c = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A", log });
    const drained = c.drain(["op"], "test", 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await drained;
    expect(send).toHaveBeenCalledTimes(calls);
    expect(log.mock.calls.flat().join()).toContain("1 done, 1 failed");
    expect(log.mock.calls.flat().join()).not.toContain("SECRET_BODY");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("resets the guarded operation 5xx budget after a successful pending status", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return calls === 12 ? Response.json({ status: "pending" }) : new Response(null, { status: 500 });
    });
    const log = vi.fn();
    const c = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A", log });
    const drained = c.drain(["op"], "test", 180_000);
    await vi.advanceTimersByTimeAsync(180_000);
    await drained;
    expect(send).toHaveBeenCalledTimes(24);
    expect(log.mock.calls.flat().join()).toContain("1 done, 1 failed");
  } finally { vi.useRealTimers(); }
});

it.each([false, true])("reapplies read-only managed policy after path tuning with banks section %s", async (withBank) => {
  const normalPath = join(directory, "normal.json");
  const unsafe = { manageBankConfig: true, retainSessions: true, autoSeed: true, codebaseSurvey: true, gitIngest: "full", autoUpdate: true,
    apiUrl: "http://localhost:8888", apiToken: "unmanaged", reflectTimeoutMs: 345_000, toolGuideExtra: "project-specific guidance" };
  writeFileSync(normalPath, JSON.stringify({ paths: { [directory]: unsafe }, ...(withBank ? { banks: { A: unsafe } } : {}) }));
  const loaded = loadConfig({ harness: "reader", path: normalPath });
  const applied = applyBankConfig(loaded, "A", directory).cfg;
  expect(applied).toMatchObject({ routerHarness: "reader", apiUrl: "https://router.test", apiToken: undefined,
    manageBankConfig: false, retainSessions: false, autoSeed: false, codebaseSurvey: false, gitIngest: "none", autoUpdate: false,
    reflectTimeoutMs: 345_000, toolGuideExtra: "project-specific guidance" });
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ roots: [] }));
  const startSeed = vi.fn();
  const startSurvey = vi.fn();
  await buildSessionStartContext({ cwd: directory, bankId: "A", cfg: applied, client: client("reader"), harness: "reader",
    hasGit: () => true, startSeed, startSurvey });
  expect(startSeed).not.toHaveBeenCalled();
  expect(startSurvey).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toBe("https://router.test/v1/default/banks/A/knowledge-base/tree");
});

it("initializes a cold Node dispatcher on its first guarded request without replacing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "router-cold-dispatcher-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    for (const file of ["router-transport", "bank-access", "patterns", "router-url"]) {
      const source = readFileSync(new URL(`../../../../shared/${file}.ts`, import.meta.url), "utf8");
      writeFileSync(
        join(directory, `${file}.js`),
        transpileModule(source, {
          compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
        }).outputText,
      );
    }
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { pathToFileURL } from "node:url";
const symbol = Symbol.for("undici.globalDispatcher.1");
const cold = globalThis[symbol] === undefined;
const { RouterTransport } = await import(pathToFileURL(process.argv[1]).href);
const signal = new AbortController().signal;
let observed;
let host;
const transport = new RouterTransport({
  routerUrl: "https://router.test", access: { writeBank: "A", additionalReadBanks: [] },
  token: () => "mr_test_" + "a".repeat(64),
  fetch: async (_url, init) => {
    host = globalThis[symbol];
    observed = {
      cold, initialized: host !== undefined, signalPreserved: init.signal === signal,
      composedWhenSupported: (init.dispatcher !== undefined) === (typeof host?.compose === "function"),
      redirect: init.redirect,
    };
    return new Response(null, { status: 200 });
  },
});
await transport.request(transport.bankUrl("A", "/documents"), { signal });
console.log(JSON.stringify({ ...observed, hostPreserved: globalThis[symbol] === host }));
`,
        join(directory, "router-transport.js"),
      ],
      {
        env: { ...process.env, NODE_OPTIONS: "", NODE_USE_ENV_PROXY: "" },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(JSON.parse(output)).toEqual({
      cold: true,
      initialized: true,
      signalPreserved: true,
      composedWhenSupported: true,
      redirect: "error",
      hostPreserved: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([310_000, 350_000])("lets the 330s managed reflect deadline govern a response after %sms through Node fetch", async (delay) => {
  vi.useFakeTimers();
  void globalThis.Headers;
  const symbol = Symbol.for("undici.globalDispatcher.1");
  const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
  type Handler = {
    onConnect(abort: (reason: Error) => void): void;
    onHeaders(status: number, headers: string[], resume: () => void, text: string): void;
    onData(body: Buffer): void;
    onComplete(trailers: string[]): void;
    onError(error: Error): void;
  };
  type Dispatch = (options: Record<string, unknown>, handler: Handler) => boolean;
  const options: Record<string, unknown>[] = [];
  const aborted: boolean[] = [];
  const dispatch: Dispatch = (opts, handler) => {
    const index = options.push(opts) - 1;
    const timer = setTimeout(() => {
      handler.onHeaders(200, ["content-type", "application/json"], () => {}, "OK");
      handler.onData(Buffer.from(JSON.stringify({ text: "late managed answer" })));
      handler.onComplete([]);
    }, delay);
    handler.onConnect((error) => {
      aborted[index] = true;
      clearTimeout(timer);
      handler.onError(error);
    });
    return true;
  };
  // Exercise Node's actual fetch dispatcher path, retaining the host dispatcher instead of
  // creating an Agent or replacing its proxy settings. No network or real multi-minute wait.
  const hostDispatcher = { compose: (intercept: (next: Dispatch) => Dispatch) => ({ dispatch: intercept(dispatch) }) };
  Object.defineProperty(globalThis, symbol, previous ? { value: hostDispatcher } : { configurable: true, writable: true, value: hostDispatcher });
  try {
    const pending = client().reflect("query", { timeoutMs: 330_000 });
    let settled = false;
    const observed = pending.then(() => { settled = true; }, () => { settled = true; });
    const outcome = delay < 330_000
      ? expect(pending).resolves.toBe("late managed answer")
      : expect(pending).rejects.toThrow("reflection unavailable for all assigned banks");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);
    expect(options).toHaveLength(2);
    expect(options.every(opts => opts.headersTimeout === 0 && opts.bodyTimeout === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(delay < 330_000 ? 10_000 : 30_000);
    await outcome;
    await observed;
    if (delay > 330_000) expect(aborted).toEqual([true, true]);
    expect((globalThis as Record<symbol, unknown>)[symbol]).toBe(hostDispatcher);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, symbol, previous);
    else Reflect.deleteProperty(globalThis, symbol);
    vi.useRealTimers();
  }
});

it.each(["initial", "baseline", "documents"])("stops SessionStart background work on terminal %s probe denial", async (point) => {
  const startSeed = vi.fn(); const startSurvey = vi.fn().mockResolvedValue(false);
  const denied = new AccessDeniedError();
  const probe = {
    listDocumentIds: vi.fn(async (tag: string) => {
      if (point === "initial" || (point === "baseline" && tag !== "source:git")) throw denied;
      return new Set<string>();
    }),
    hasDocuments: vi.fn(async () => { if (point === "documents") throw denied; return false; }),
    listPages: vi.fn().mockResolvedValue([]),
  };
  await expect(buildSessionStartContext({ cwd: directory, bankId: "A", cfg: resolveConfig({ codebaseSurvey: true }),
    client: probe, harness: "codex", hasGit: () => true, startSeed, startSurvey, headSha: () => null })).rejects.toBe(denied);
  expect(startSeed).not.toHaveBeenCalled(); expect(startSurvey).not.toHaveBeenCalled();
  expect(probe.listPages).not.toHaveBeenCalled();
});
it("preserves transient baseline/document probe fallback in SessionStart", async () => {
  const startSeed = vi.fn(); const startSurvey = vi.fn().mockResolvedValue(false);
  const probe = { listDocumentIds: vi.fn(async (tag: string) => {
    if (tag !== "source:git") throw new Error("transient server outage"); return new Set<string>();
  }), hasDocuments: vi.fn().mockRejectedValue(new Error("transient server outage")), listPages: vi.fn().mockResolvedValue([]) };
  const output = await buildSessionStartContext({ cwd: directory, bankId: "A", cfg: resolveConfig({ codebaseSurvey: true }),
    client: probe, harness: "codex", hasGit: () => true, startSeed, startSurvey, headSha: () => null });
  expect(startSeed).toHaveBeenCalledOnce(); expect(startSurvey).toHaveBeenCalledOnce();
  expect(output.deferInitialReflect).toBe(false);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@memory-router/shared/bank-access";
import { managedBank } from "@memory-router/coding-agents/runtime";
import { ensureDaemon } from "./daemon";
import { loadConfig, resolveConfig } from "./config";
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
    expect(String(url)).toMatch(/^https:\/\/router\.test\/(?:version|v1\/default\/banks\/[AB]\/)/);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
    expect(new Headers(init?.headers).get("x-memory-router-agent")).toBe("codex");
    expect(init?.redirect).toBe("error");
  }
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
it("preserves upstream page-capability fallback without attempting bank provisioning", async () => {
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
  await expect(client().configureBank()).resolves.toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
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

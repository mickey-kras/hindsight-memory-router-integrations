import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, classifyOperation, requireBank, visibleBanks } from "../src/shared/bank-access.js";
import { RouterTransport, RouterRequestError } from "../src/shared/router-transport.js";
import { harnessTransport, managedBank, managedSettings } from "../src/coding-agents/runtime.js";
import { readAcrossBanks } from "../src/shared/read-execution.js";
import { PrincipalCredentialResolver } from "../src/shared/principal-credential-resolver.js";

const token = (id: string) => `mr_${id}_${"a".repeat(64)}`;
const access = { writeBank: "A", additionalReadBanks: ["B", "C"] };
const url = "https://router.example.test";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "router-test-")); dirs.push(dir);
  const path = join(dir, "router.json");
  writeFileSync(path, JSON.stringify({ routerUrl: url, principals: {
    codex: { ...access, tokenEnv: "TEST_CODEX_TOKEN", mapPathToBank: { "/approved": "A", "/escape": "hidden" } },
    "claude-code": { ...access, tokenEnv: "TEST_CLAUDE_TOKEN" },
    opencode: { writeBank: "D", additionalReadBanks: ["B", "E"], tokenEnv: "TEST_OPEN_TOKEN" },
  } }));
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
  vi.stubEnv("TEST_CODEX_TOKEN", token("codex"));
  vi.stubEnv("TEST_CLAUDE_TOKEN", token("claude"));
  vi.stubEnv("TEST_OPEN_TOKEN", token("open"));
  return path;
}
function transport(send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}))) {
  return { client: new RouterTransport({ routerUrl: url, access, token: () => token("test"), fetch: send }), send };
}

describe("managed harness identities", () => {
  it("binds distinct harness principals to distinct credentials", async () => {
    setup();
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
    for (const [harness, bank] of [["codex", "A"], ["claude-code", "A"], ["opencode", "D"]]) {
      const client = harnessTransport(harness);
      await client.request(client.bankUrl(bank, "/config"));
    }
    expect(send.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization")))
      .toEqual(["codex", "claude", "open"].map(id => `Bearer ${token(id)}`));
  });
  it.each([undefined, "", "unknown", "__proto__", "constructor"])("denies missing/unknown identity %s", harness => {
    setup(); expect(() => harnessTransport(harness)).toThrow(AccessDeniedError);
  });
  it("denies missing credentials, invalid secrets and missing managed config", () => {
    setup(); vi.stubEnv("TEST_CODEX_TOKEN", ""); expect(() => harnessTransport("codex")).toThrow(AccessDeniedError);
    vi.stubEnv("TEST_CODEX_TOKEN", "invalid"); expect(() => harnessTransport("codex")).toThrow(AccessDeniedError);
    vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", ""); expect(() => harnessTransport("codex")).toThrow(AccessDeniedError);
  });
  it("accepts only explicitly mapped paths and assigned banks", () => {
    setup(); expect(managedBank("codex", "/approved/subdir")).toBe("A");
    for (const path of ["/approved-other", "/random/repo", "/escape", ""]) expect(() => managedBank("codex", path)).toThrow(AccessDeniedError);
    expect(managedSettings("codex")).toMatchObject({ harness: "codex", autoUpdate: false, dynamicBankId: false, optInOnly: true, apiToken: undefined });
  });
  it("rejects plaintext tokens and wildcard bank grants", () => {
    const path = setup();
    for (const principal of [{ ...access, tokenEnv: "TEST_CODEX_TOKEN", token: token("codex") }, { writeBank: "*", additionalReadBanks: [], tokenEnv: "TEST_CODEX_TOKEN" }]) {
      writeFileSync(path, JSON.stringify({ routerUrl: url, principals: { codex: principal } }));
      expect(() => harnessTransport("codex")).toThrow(AccessDeniedError);
    }
  });
  it("does not serialize credentials", () => {
    setup(); expect(JSON.stringify(harnessTransport("codex"))).not.toContain(token("codex"));
    const resolver = new PrincipalCredentialResolver({ principals: { codex: { ...access, token: token("codex") } } });
    const credentials = resolver.resolve("codex");
    expect(credentials.token).toBe(token("codex")); expect(JSON.stringify(credentials)).not.toContain(token("codex"));
  });
});

describe("bank isolation", () => {
  it("calculates the write plus read-only union with no wildcard", () => {
    expect(visibleBanks({ writeBank: "A", additionalReadBanks: ["A", "B", "B"] })).toEqual(["A", "B"]);
    expect(visibleBanks({ additionalReadBanks: ["B"] })).toEqual(["B"]);
    expect(visibleBanks({ additionalReadBanks: [] })).toEqual([]);
    expect(() => visibleBanks({ additionalReadBanks: ["*"] })).toThrow(AccessDeniedError);
  });
  it("lists only configured IDs without a global-bank request", async () => {
    const { client, send } = transport();
    expect(await (await client.request(`${url}/v1/default/banks`)).json()).toEqual({ banks: [{ bank_id: "A" }, { bank_id: "B" }, { bank_id: "C" }] });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["/config", "/reflect", "/memories/recall", "/knowledge-base/tree", ""])("unassigned bank stays invisible for %s", async suffix => {
    const { client, send } = transport();
    for (const bank of ["exists-secret", "nonexistent"]) {
      await expect(client.request(`${url}/v1/default/banks/${bank}${suffix}`, { method: suffix.includes("reflect") || suffix.includes("recall") ? "POST" : "GET" })).rejects.toThrow("memory access denied");
    }
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["/memories", "/config", "/knowledge-base/pages", "/import", ""])("only writeBank can mutate %s", async suffix => {
    const { client, send } = transport();
    await client.request(client.bankUrl("A", suffix), { method: "POST", body: "{}" });
    await expect(client.request(client.bankUrl("B", suffix), { method: "POST", body: "{}" })).rejects.toThrow(AccessDeniedError);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["/config", "/knowledge-base/tree", "/documents", "/operations/id", ""])("permits assigned non-mutating operation %s", async suffix => {
    const { client } = transport(); await expect(client.request(client.bankUrl("B", suffix))).resolves.toBeInstanceOf(Response);
  });
  it.each(["https://other.test/v1/default/banks/A/config", `${url}/v1/default/banks/A/../hidden/config`, `${url}/v1/default/banks/A/%2e%2e/hidden/config`, `${url}/v1/default/banks/A%2fhidden/config`, `${url}/v1/default/banks/A%252fhidden/config`, `${url}/v1/default/banks/A/config#secret`])("rejects alternate or encoded destination", async destination => {
    const { client, send } = transport(); await expect(client.request(destination)).rejects.toThrow(AccessDeniedError); expect(send).not.toHaveBeenCalled();
  });
  it("classifies read POSTs and denies unknown operations", () => {
    expect(classifyOperation("POST", "/reflect")).toBe("read");
    expect(classifyOperation("POST", "/memories/recall")).toBe("read");
    expect(() => classifyOperation("POST", "/unknown")).toThrow(AccessDeniedError);
    expect(() => requireBank({ additionalReadBanks: ["B"] }, "B", "write")).toThrow(AccessDeniedError);
  });
  it.each([401, 403])("fails closed on %s without error-body leakage", async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(token("test"), { status }));
    const { client } = transport(send); await expect(client.request(client.bankUrl("A"))).rejects.toThrow("memory access denied");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("strips error bodies, catches network errors and blocks redirect following", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(token("test"))).mockResolvedValueOnce(new Response(token("test"), { status: 500 }));
    const { client } = transport(send);
    await expect(client.request(client.bankUrl("A"))).rejects.toThrow(RouterRequestError);
    await expect(client.request(client.bankUrl("A"))).rejects.toThrow("memory request failed (500)");
    expect(send.mock.calls[0][1]?.redirect).toBe("error");
  });
});

describe("multi-bank read execution", () => {
  it("merges and deduplicates only assigned banks", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ results: [{ text: "same", score: 1 }] }));
    const { client } = transport(send);
    const result = await readAcrossBanks(client, "recall", { query: "q" }, { timeoutMs: 100, maxTokens: 100 });
    expect(result.results).toEqual([{ text: "same", score: 1 }]); expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([url]) => url)).toEqual(["A", "B", "C"].map(bank => client.bankUrl(bank, "/memories/recall")));
  });
  it("returns documented partial reads on transient failure", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ text: "retained" })).mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(Response.json({ text: "retained" }));
    const { client } = transport(send);
    expect(await readAcrossBanks(client, "reflect", { query: "q" }, { timeoutMs: 100, maxTokens: 100 })).toMatchObject({ results: [{ text: "retained" }], partial: true, failedBanks: ["B"] });
  });
  it.each([401, 403])("discards all successes when any read returns %s", async status => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ text: "must not escape" })).mockResolvedValueOnce(new Response("denied", { status })).mockResolvedValueOnce(Response.json({ text: "also hidden" }));
    const { client } = transport(send);
    await expect(readAcrossBanks(client, "reflect", {}, { timeoutMs: 100, maxTokens: 100 })).rejects.toThrow();
  });
});

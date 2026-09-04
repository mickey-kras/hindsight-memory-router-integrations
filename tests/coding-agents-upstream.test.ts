import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HindsightClient } from "../integrations/coding-agents/upstream/src/core/hindsight";
import { loadConfig, applyBankConfig } from "../integrations/coding-agents/upstream/src/core/config";
import { deriveBankId } from "../integrations/coding-agents/upstream/src/core/bank";
const dirs: string[] = [];
const token = `mr_codex_${"b".repeat(64)}`;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "upstream-router-")); dirs.push(dir);
  const path = join(dir, "managed.json");
  writeFileSync(path, JSON.stringify({ routerUrl: "https://router.test", principals: {
    codex: { writeBank: "A", additionalReadBanks: ["B"], tokenEnv: "UPSTREAM_TEST_TOKEN", mapPathToBank: { [dir]: "A" } },
  } }));
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path); vi.stubEnv("UPSTREAM_TEST_TOKEN", token);
  return dir;
}
it("upstream config cannot override harness, credentials, endpoint or bank assignment", () => {
  const dir = setup(); const path = join(dir, "normal.json");
  writeFileSync(path, JSON.stringify({ harness: "opencode", apiToken: "plaintext", apiUrl: "https://evil.test", bankId: "hidden", dynamicBankId: true, banks: { A: { bank: "hidden", apiToken: "plaintext" } } }));
  const cfg = loadConfig({ harness: "codex", path });
  expect(cfg).toMatchObject({ harness: "codex", routerHarness: "codex", apiUrl: "https://router.test", apiToken: undefined, dynamicBankId: false, autoUpdate: false });
  expect(deriveBankId(cfg, dir, "codex")).toBe("A");
  expect(applyBankConfig(cfg, "A", dir)).toMatchObject({ bankId: "A", cfg: { apiToken: undefined, apiUrl: "https://router.test" } });
  expect(() => deriveBankId(cfg, "/unmapped", "codex")).toThrow("memory access denied");
});
it("upstream client uses managed authentication, fans out reflect, and guards arbitrary requests", async () => {
  setup();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => Response.json(init?.method === "POST" ? { text: "memory", operation_id: "op" } : {}));
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://evil.test", apiToken: "plaintext", bank: "A" });
  expect(await client.reflect("query", { timeoutMs: 100 })).toBe("memory");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["A", "B"].map(bank => `https://router.test/v1/default/banks/${bank}/reflect`));
  await client.retain("text", "context", "doc", [], "conversation");
  expect(client.opIds).toEqual(["op"]);
  await expect(client.req("PATCH", "https://router.test/v1/default/banks/B/config", {})).rejects.toThrow("memory access denied");
  await expect(client.req("GET", "https://router.test/v1/default/banks/hidden/config")).rejects.toThrow("memory access denied");
  expect(JSON.stringify(client)).not.toContain(token);
  expect(fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer ${token}`)).toBe(true);
});
it("upstream client requires a known harness and discards all reads on authorization failure", async () => {
  setup();
  expect(() => new HindsightClient({ apiUrl: "https://router.test", bank: "A" })).toThrow("memory access denied");
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ text: "must disappear" })).mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  await expect(client.reflect("q", { timeoutMs: 100 })).rejects.toThrow();
});

import { execFileSync, spawnSync } from "node:child_process";
import { run as install } from "../src/upstream/coding-agents/src/installer";
import { readFileSync } from "node:fs";
import { buildKnowledgeTools } from "../src/upstream/coding-agents/src/core/knowledge-tools";
import { buildHookOutput } from "../src/upstream/coding-agents/src/core/hook";
import { resolveConfig } from "../src/upstream/coding-agents/src/core/config";
import { readSessionCache, writeSessionCache } from "../src/upstream/coding-agents/src/core/session-cache";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HindsightClient } from "../src/upstream/coding-agents/src/core/hindsight";
import { loadConfig, applyBankConfig } from "../src/upstream/coding-agents/src/core/config";
import { deriveBankId } from "../src/upstream/coding-agents/src/core/bank";
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

it("drops cached memory and suppresses successful reflect when page access is denied", async () => {
  const dir = setup();
  const cacheFile = join(dir, "cache.json");
  writeSessionCache(cacheFile, { pages: { atTurn: 1, list: [{ id: "secret", title: "old-bank" }] }, reflectAnswer: "old content" });
  expect(readSessionCache(cacheFile)).toEqual({ reflectAnswer: "" });
  rmSync(cacheFile);
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ text: "must not escape" }))
    .mockResolvedValueOnce(Response.json({ text: "must not escape" }))
    .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  await expect(buildHookOutput({ harness: "codex", prompt: "query", cfg: resolveConfig({ autoReflect: true }), client, cacheFile })).rejects.toThrow("memory access denied");
  expect(() => client.assertAuthorized()).toThrow("memory access denied");
});

it("lets page tools address assigned read banks while denying hidden banks and mutations", async () => {
  setup();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ content: "page" }));
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  const tools = buildKnowledgeTools(client, "A", { harness: "codex" });
  const read = tools.find(tool => tool.name === "hindsight_read_knowledge_page")!;
  const result = await read.handler({ bankId: "B", page_id: "page" });
  expect(result.isError).not.toBe(true);
  expect(fetch.mock.calls[0][0]).toContain("/banks/B/knowledge-base/pages/page");
  expect((await read.handler({ bankId: "hidden", page_id: "page" })).isError).toBe(true);
  const write = tools.find(tool => tool.name === "hindsight_ingest_document")!;
  expect((await write.handler({ bankId: "B", title: "doc", content: "text" })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("installs harness-specific MCP identities without migrating or storing tokens", () => {
  const dir = setup();
  execFileSync("tar", ["-xzf", new URL("../packages/mickey-kras-hindsight-memory-router-coding-agents-0.5.1-router.1.tgz", import.meta.url).pathname, "-C", dir]);
  const packageRoot = join(dir, "package");
  const cli = vi.fn(() => true);
  const context = { home: dir, pkgRoot: packageRoot, dist: join(packageRoot, "dist"), interactive: false,
    claudeMcp: cli, nodeSqlite: () => true, readLegacy: vi.fn(() => { throw new Error("must not migrate old credentials"); }) };
  expect(install(["install", "codex", "claude-code", "opencode"], context)).toBe(0);
  expect(context.readLegacy).not.toHaveBeenCalled();
  expect(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).toContain("codex");
  expect(cli.mock.calls.flat(2).join(" ")).toContain("HINDSIGHT_MCP_HARNESS=claude-code");
  expect(() => install(["install", "codex", "--api-token", "plaintext"], context)).toThrow("tokenEnv");
});

it("runs the packaged Codex hook with harness-bound credentials and fails closed without them", () => {
  const dir = setup();
  execFileSync("tar", ["-xzf", new URL("../packages/mickey-kras-hindsight-memory-router-coding-agents-0.5.1-router.1.tgz", import.meta.url).pathname, "-C", dir]);
  const normal = join(dir, "normal.json");
  writeFileSync(normal, JSON.stringify({ autoSeed: false, codebaseSurvey: false, autoReflect: true, pageRefreshEveryTurns: 1 }));
  const trace = join(dir, "trace.jsonl");
  const shim = join(dir, "fetch.mjs");
  writeFileSync(shim, `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      appendFileSync(process.env.TEST_TRACE, JSON.stringify({ url, authorization: new Headers(init.headers).get('authorization') }) + '\\n');
      return Response.json(String(url).endsWith('/reflect') ? { text: 'packaged memory' } : { roots: [] });
    };`);
  const args = ["--import", shim, join(dir, "package", "dist", "codex-hook.js")];
  const env = { ...process.env, HINDSIGHT_CONFIG: normal, TEST_TRACE: trace, HINDSIGHT_DIAG_FILE: join(dir, "diag.jsonl") };
  const input = JSON.stringify({ prompt: "What decisions did we make?", session_id: dir.split("/").at(-1), cwd: dir, harness: "opencode", bankId: "hidden" });
  const output = execFileSync(process.execPath, args, { input, env, encoding: "utf8" });
  expect(output).toContain("packaged memory");
  const requests = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as { url: string; authorization: string });
  expect(requests.map(request => request.url)).toEqual([
    "https://router.test/v1/default/banks/A/reflect", "https://router.test/v1/default/banks/B/reflect",
    "https://router.test/v1/default/banks/A/knowledge-base/tree",
  ]);
  expect(requests.every(request => request.authorization === `Bearer ${token}`)).toBe(true);
  const denied = spawnSync(process.execPath, args, { input, env: { ...env, UPSTREAM_TEST_TOKEN: "" }, encoding: "utf8" });
  expect(denied.status).toBe(1);
  expect(denied.stdout).toBe("");
  expect(denied.stderr).not.toContain(token);
  expect(readFileSync(trace, "utf8").trim().split("\n")).toHaveLength(3);
});

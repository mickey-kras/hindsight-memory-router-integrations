import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { deriveBankId } from "../src/upstream/coding-agents/src/core/bank";
import { applyBankConfig, loadConfig, resolveConfig } from "../src/upstream/coding-agents/src/core/config";
import { HindsightClient, RateLimitedError } from "../src/upstream/coding-agents/src/core/hindsight";
import { buildHookOutput } from "../src/upstream/coding-agents/src/core/hook";
import { buildKnowledgeTools } from "../src/upstream/coding-agents/src/core/knowledge-tools";
import { readSessionCache, writeSessionCache } from "../src/upstream/coding-agents/src/core/session-cache";
import { run as install, parseJsonc } from "../src/upstream/coding-agents/src/installer";

const dirs: string[] = [];
const token = `mr_codex_${"b".repeat(64)}`;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.splice(0).forEach((p) => {
    rmSync(p, { recursive: true, force: true });
  });
});
let cachedPackage: string | undefined;
function codingAgentsPackage() {
  // packages/ is gitignored; pack the tarball from source on demand.
  if (!cachedPackage) {
    const source = new URL("../src/upstream/coding-agents", import.meta.url).pathname;
    execFileSync("npm", ["run", "build", "--silent"], { cwd: source });
    // Not tracked in `dirs`: the cache must survive afterEach cleanup.
    const dir = mkdtempSync(join(tmpdir(), "coding-agents-pack-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    const [{ filename }] = JSON.parse(
      execFileSync("npm", ["pack", "--pack-destination", dir, "--json"], { cwd: source, encoding: "utf8" }),
    );
    cachedPackage = join(dir, filename);
  }
  return cachedPackage;
}
beforeAll(() => {
  // Build and pack once; npm pack exceeds the default per-test timeout.
  codingAgentsPackage();
}, 120000);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "upstream-router-"));
  dirs.push(dir);
  const path = join(dir, "managed.json");
  writeFileSync(
    path,
    JSON.stringify({
      routerUrl: "https://router.test",
      principals: {
        codex: {
          writeBank: "A",
          additionalReadBanks: ["B"],
          tokenEnv: "UPSTREAM_TEST_TOKEN",
          mapPathToBank: { [dir]: "A" },
        },
      },
    }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
  vi.stubEnv("UPSTREAM_TEST_TOKEN", token);
  return dir;
}
it("upstream config cannot override harness, credentials, endpoint or bank assignment", () => {
  const dir = setup();
  const path = join(dir, "normal.json");
  writeFileSync(
    path,
    JSON.stringify({
      harness: "opencode",
      apiToken: "plaintext",
      apiUrl: "https://evil.test",
      bankId: "hidden",
      dynamicBankId: true,
      banks: { A: { bank: "hidden", apiToken: "plaintext" } },
    }),
  );
  const cfg = loadConfig({ harness: "codex", path });
  expect(cfg).toMatchObject({
    harness: "codex",
    routerHarness: "codex",
    apiUrl: "https://router.test",
    apiToken: undefined,
    dynamicBankId: false,
    autoUpdate: false,
  });
  expect(deriveBankId(cfg, dir, "codex")).toBe("A");
  expect(applyBankConfig(cfg, "A", dir)).toMatchObject({
    bankId: "A",
    cfg: { apiToken: undefined, apiUrl: "https://router.test" },
  });
  expect(() => deriveBankId(cfg, "/unmapped", "codex")).toThrow("memory access denied");
});
it("upstream client uses managed authentication, fans out reflect, and guards arbitrary requests", async () => {
  setup();
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) =>
      Response.json(init?.method === "POST" ? { text: "memory", operation_id: "op" } : {}),
    );
  const client = new HindsightClient({
    routerHarness: "codex",
    apiUrl: "https://evil.test",
    apiToken: "plaintext",
    bank: "A",
  });
  expect(await client.reflect("query", { timeoutMs: 100 })).toBe("memory");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(
    ["A", "B"].map((bank) => `https://router.test/v1/default/banks/${bank}/reflect`),
  );
  await client.retain("text", "context", "doc", [], "conversation");
  expect(client.opIds).toEqual(["op"]);
  await expect(client.req("PATCH", "https://router.test/v1/default/banks/B/config", {})).rejects.toThrow(
    "memory access denied",
  );
  await expect(client.req("GET", "https://router.test/v1/default/banks/hidden/config")).rejects.toThrow(
    "memory access denied",
  );
  expect(JSON.stringify(client)).not.toContain(token);
  expect(
    fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer ${token}`),
  ).toBe(true);
});
it("upstream client requires a known harness and discards all reads on authorization failure", async () => {
  setup();
  expect(() => new HindsightClient({ apiUrl: "https://router.test", bank: "A" })).toThrow("memory access denied");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ text: "must disappear" }))
    .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  const client = new HindsightClient({
    routerHarness: "codex",
    apiUrl: "https://router.test",
    bank: "A",
  });
  await expect(client.reflect("q", { timeoutMs: 100 })).rejects.toThrow();
});

it("drops cached memory and suppresses successful reflect when page access is denied", async () => {
  const dir = setup();
  const cacheFile = join(dir, "cache.json");
  writeSessionCache(cacheFile, {
    pages: { atTurn: 1, list: [{ id: "secret", title: "old-bank" }] },
    reflectAnswer: "old content",
  });
  expect(readSessionCache(cacheFile)).toEqual({ reflectAnswer: "" });
  rmSync(cacheFile);
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ text: "must not escape" }))
    .mockResolvedValueOnce(Response.json({ text: "must not escape" }))
    .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
  const client = new HindsightClient({
    routerHarness: "codex",
    apiUrl: "https://router.test",
    bank: "A",
  });
  await expect(
    buildHookOutput({
      harness: "codex",
      prompt: "query",
      cfg: resolveConfig({ autoReflect: true }),
      client,
      cacheFile,
    }),
  ).rejects.toThrow("memory access denied");
  expect(() => client.assertAuthorized()).toThrow("memory access denied");
});

it("lets page tools address assigned read banks while denying hidden banks and mutations", async () => {
  setup();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ content: "page" }));
  const client = new HindsightClient({
    routerHarness: "codex",
    apiUrl: "https://router.test",
    bank: "A",
  });
  const tools = buildKnowledgeTools(client, "A", { harness: "codex" });
  const read = tools.find((tool) => tool.name === "hindsight_read_knowledge_page")!;
  const result = await read.handler({ bankId: "B", page_id: "page" });
  expect(result.isError).not.toBe(true);
  expect(fetch.mock.calls[0][0]).toContain("/banks/B/knowledge-base/pages/page");
  expect((await read.handler({ bankId: "hidden", page_id: "page" })).isError).toBe(true);
  const write = tools.find((tool) => tool.name === "hindsight_ingest_document")!;
  expect((await write.handler({ bankId: "B", title: "doc", content: "text" })).isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("installs harness-specific MCP identities without migrating or storing tokens", () => {
  const dir = setup();
  execFileSync("tar", ["-xzf", codingAgentsPackage(), "-C", dir]);
  const packageRoot = join(dir, "package");
  const cli = vi.fn(() => true);
  const context = {
    home: dir,
    pkgRoot: packageRoot,
    dist: join(packageRoot, "dist"),
    interactive: false,
    claudeMcp: cli,
    nodeSqlite: () => true,
    readLegacy: vi.fn(() => {
      throw new Error("must not migrate old credentials");
    }),
  };
  expect(install(["install", "codex", "claude-code", "opencode"], context)).toBe(0);
  expect(context.readLegacy).not.toHaveBeenCalled();
  expect(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).toContain("codex");
  expect(cli.mock.calls.flat(2).join(" ")).toContain("HINDSIGHT_MCP_HARNESS=claude-code");
  expect(() => install(["install", "codex", "--api-token", "plaintext"], context)).toThrow("tokenEnv");
});

it("runs the packaged Codex hook with harness-bound credentials and fails closed without them", () => {
  const dir = setup();
  execFileSync("tar", ["-xzf", codingAgentsPackage(), "-C", dir]);
  const normal = join(dir, "normal.json");
  writeFileSync(
    normal,
    JSON.stringify({
      autoSeed: false,
      codebaseSurvey: false,
      autoReflect: true,
      pageRefreshEveryTurns: 1,
    }),
  );
  const trace = join(dir, "trace.jsonl");
  const shim = join(dir, "fetch.mjs");
  writeFileSync(
    shim,
    `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      appendFileSync(process.env.TEST_TRACE, JSON.stringify({ url, authorization: new Headers(init.headers).get('authorization') }) + '\\n');
      return Response.json(String(url).endsWith('/reflect') ? { text: 'packaged memory' } : { roots: [] });
    };`,
  );
  const args = ["--import", shim, join(dir, "package", "dist", "codex-hook.js")];
  const env = {
    ...process.env,
    HINDSIGHT_CONFIG: normal,
    TEST_TRACE: trace,
    HINDSIGHT_DIAG_FILE: join(dir, "diag.jsonl"),
  };
  const input = JSON.stringify({
    prompt: "What decisions did we make?",
    session_id: dir.split("/").at(-1),
    cwd: dir,
    harness: "opencode",
    bankId: "hidden",
  });
  const output = execFileSync(process.execPath, args, {
    input,
    env,
    encoding: "utf8",
  });
  expect(output).toContain("packaged memory");
  const requests = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { url: string; authorization: string });
  expect(requests.map((request) => request.url)).toEqual([
    "https://router.test/v1/default/banks/A/reflect",
    "https://router.test/v1/default/banks/B/reflect",
    "https://router.test/v1/default/banks/A/knowledge-base/tree",
  ]);
  expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
  const denied = spawnSync(process.execPath, args, {
    input,
    env: { ...env, UPSTREAM_TEST_TOKEN: "" },
    encoding: "utf8",
  });
  expect(denied.status).toBe(1);
  expect(denied.stdout).toBe("");
  expect(denied.stderr).not.toContain(token);
  expect(readFileSync(trace, "utf8").trim().split("\n")).toHaveLength(3);
});

it.each(["", "\n"])("Codex uninstall preserves adjacent tables with EOF suffix %j", (ending) => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  const kept = '[mcp_servers.other]\ncommand = "other"\n\n[features]\nhooks = true\n';
  writeFileSync(
    path,
    '[mcp_servers.hindsight]\ncommand = "old"\n\n' + kept + '[mcp_servers.hindsight.env]\nTOKEN = "old"' + ending,
  );
  expect(
    install(["uninstall", "codex"], {
      home: dir,
      pkgRoot: dir,
      dist: join(dir, "dist"),
      interactive: false,
    }),
  ).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(kept);
});

it("parses JSONC without editing literal plugin paths and rejects malformed roots", () => {
  expect(parseJsonc('{/* comment */"plugin":["/opt/plugins/parser,].js"],}')).toEqual({
    plugin: ["/opt/plugins/parser,].js"],
  });
  for (const text of ["[]", "null", '"string"', '{"plugin": [}']) expect(parseJsonc(text)).toBeNull();
  const home = setup();
  const directory = join(home, ".config", "opencode");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "opencode.jsonc");
  writeFileSync(path, '// kept comment\n{"plugin":["/opt/plugins/parser,].js"],}');
  expect(install(["install", "opencode"], { home, pkgRoot: home, dist: join(home, "dist"), interactive: false })).toBe(
    0,
  );
  const installed = readFileSync(path, "utf8");
  expect(installed).toContain("// kept comment");
  expect(parseJsonc(installed)?.plugin).toContain("/opt/plugins/parser,].js");
});

it("preserves page-search and recall options in explicitly scoped clients", async () => {
  setup();
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ results: [] }));
  const client = new HindsightClient({
    routerHarness: "codex",
    apiUrl: "https://router.test",
    bank: "A",
    pageSearchLimit: 2,
    recallOptions: { types: ["world"] },
  });
  for (const scoped of [client, client.forBank("A"), client.forBank("B")]) {
    await scoped.searchKnowledgePages("query");
    await scoped.recallObservations("query", { timeoutMs: 100 });
  }
  const searches = send.mock.calls.filter(([, init]) => init?.method === "GET");
  const recalls = send.mock.calls.filter(([, init]) => init?.method === "POST");
  expect(recalls).toHaveLength(6);
  for (const [, init] of recalls) expect(JSON.parse(String(init?.body)).types).toEqual(["world"]);
  expect(searches.map(([url]) => String(url))).toEqual([
    "https://router.test/v1/default/banks/A/knowledge-base/search?q=query&limit=2",
    "https://router.test/v1/default/banks/A/knowledge-base/search?q=query&limit=2",
    "https://router.test/v1/default/banks/B/knowledge-base/search?q=query&limit=2",
  ]);
});

it("falls back to healthy page search when every reflection bank fails", async () => {
  const dir = setup();
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).endsWith("/reflect")) return new Response("private failure body", { status: 500 });
    if (String(url).includes("/search?"))
      return Response.json({ results: [{ id: "page", name: "Recovery", snippet: "recovered fact", score: 1 }] });
    return Response.json({ roots: [] });
  });
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  const result = await buildHookOutput({
    harness: "codex",
    prompt: "query",
    cfg: resolveConfig({ autoReflect: true }),
    client,
    cacheFile: join(dir, "cache.json"),
  });
  expect(result.context).toContain("recovered fact");
  expect(send.mock.calls.filter(([url]) => String(url).includes("/search?"))).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("private failure body");
});

it("keeps successful partial reflection and does not trigger fallback for empty successful reads", async () => {
  setup();
  const send = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ text: "usable memory" }))
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockImplementation(async () => Response.json({ text: "" }));
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  expect(await client.reflect("query", { timeoutMs: 100 })).toBe("usable memory");
  expect(await client.reflect("query", { timeoutMs: 100 })).toBe("");
  expect(send).toHaveBeenCalledTimes(4);
});

it("translates router rate limits into bounded coding retain recovery errors", async () => {
  setup();
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("private rate-limit body", { status: 429, headers: { "Retry-After": "8" } }),
  );
  const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
  await expect(client.retain("content", "context", "doc", [], "conversation")).rejects.toMatchObject({
    name: "RateLimitedError",
    retryAfterMs: 8000,
  });
  await expect(client.req("GET", client.bankUrl("/operations/op"))).rejects.toBeInstanceOf(RateLimitedError);
  const tolerated = await client.req("GET", client.bankUrl("/operations/op"), undefined, [429]);
  expect(tolerated.status).toBe(429);
  expect(await tolerated.text()).toBe("");
});

it.each([{ disabled: true }, { banks: { A: { disabled: true } } }])(
  "returns inert managed host memory for disabled settings %j",
  async (settings) => {
    const dir = setup();
    const config = join(dir, "disabled.json");
    writeFileSync(config, JSON.stringify(settings));
    vi.stubEnv("HINDSIGHT_CONFIG", config);
    vi.resetModules();
    const { resolveHostMemory } = await import("../src/upstream/coding-agents/src/core/host-client");
    const send = vi.spyOn(globalThis, "fetch");
    expect(resolveHostMemory("codex", dir)).toMatchObject({ disabled: true, client: null, cfg: { disabled: true } });
    expect(send).not.toHaveBeenCalled();
  },
);

it("passes the selected harness to conversation import and its retry command", () => {
  const dir = setup();
  const sessions = join(dir, ".codex", "sessions");
  const dist = join(dir, "dist");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(dist);
  writeFileSync(
    join(sessions, "history.jsonl"),
    [
      { type: "session_meta", payload: { id: "import-session", cwd: process.cwd() } },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remember import" }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "remembered" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  const trace = join(dir, "import-args.json");
  writeFileSync(
    join(dist, "deepen.js"),
    `require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2))); process.exit(1);`,
  );
  const log = vi.fn();
  expect(
    install(["install", "codex", "--import-conversations"], {
      home: dir,
      pkgRoot: dir,
      dist,
      interactive: false,
      nodeSqlite: () => true,
      log,
    }),
  ).toBe(0);
  const args = JSON.parse(readFileSync(trace, "utf8")) as string[];
  expect(args.slice(0, 4)).toEqual(["--harness", "codex", "--repo", process.cwd()]);
  const input = args[args.indexOf("--conversations") + 1];
  dirs.push(dirname(input));
  expect(JSON.parse(readFileSync(input, "utf8"))).toHaveLength(1);
  expect(log.mock.calls.map(([line]) => line).join("\n")).toContain('--harness "codex"');
});

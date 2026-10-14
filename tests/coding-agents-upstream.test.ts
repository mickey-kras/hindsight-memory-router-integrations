import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import plugin, { PLUGIN_ID } from "../src/plugin.js";
import { deriveBankId } from "../src/upstream/coding-agents/src/core/bank";
import { applyBankConfig, loadConfig, resolveConfig } from "../src/upstream/coding-agents/src/core/config";
import { HindsightClient, RateLimitedError } from "../src/upstream/coding-agents/src/core/hindsight";
import { buildHookOutput } from "../src/upstream/coding-agents/src/core/hook";
import { buildKnowledgeTools } from "../src/upstream/coding-agents/src/core/knowledge-tools";
import { readSessionCache, writeSessionCache } from "../src/upstream/coding-agents/src/core/session-cache";
import { run as install, parseJsonc } from "../src/upstream/coding-agents/src/installer";
import { selectTools } from "../src/upstream/coding-agents/src/mcp-server";
import { stageNativeKeychain } from "../src/upstream/coding-agents/src/native-storage";

const dirs: string[] = [];
const token = `mr_codex_${"b".repeat(64)}`;
const { parse: parseToml } = createRequire(new URL("../src/upstream/coding-agents/package.json", import.meta.url))(
  "smol-toml",
) as { parse: (text: string) => { mcp_servers: { hindsight: CodexRegistration } } };
interface CodexRegistration {
  command: string;
  args: string[];
  env_vars: (string | { name: string; source?: "local" | "remote" })[];
  env: Record<string, string>;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  enabled?: boolean;
}
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
    execFileSync("npm", ["run", "build", "--prefix", source, "--silent"], { cwd: source });
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
      queueDir: join(dir, "queue"),
      principals: {
        "claude-code": { writeBank: "A", tokenEnv: "UPSTREAM_TEST_TOKEN", mapPathToBank: { [process.cwd()]: "A" } },
        opencode: { writeBank: "A", tokenEnv: "UPSTREAM_TEST_TOKEN", mapPathToBank: { [process.cwd()]: "A" } },
        codex: {
          writeBank: "A",
          additionalReadBanks: ["B"],
          tokenEnv: "UPSTREAM_TEST_TOKEN",
          mapPathToBank: { [dir]: "A", [process.cwd()]: "A" },
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
  expect(() => loadConfig({ harness: "codex", path })).toThrow("memory access denied");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  delete settings.apiUrl;
  writeFileSync(path, JSON.stringify(settings));
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
    apiUrl: "https://router.test",
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
  expect(install(["install", "codex", "--api-token", "plaintext"], context)).toBe(1);
});

it.each([
  ["C# setup", "C++ setup"],
  ["a b", "a-b"],
  ["Runbook", "runbook"],
  ["Notes", " Notes "],
  ["记忆文档一", "记忆文档二"],
  ["Résumé", "Re\u0301sume\u0301"],
  ["\ud800", "\ud801"],
  ["\ufffd", "\ud800"],
  ["!!!", "???"],
])(
  "ingest handlers keep exact titles distinct and update the same document across hosts: %j / %j",
  async (title, otherTitle) => {
    const dir = setup();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const documents = new Map<string, string>([["c-setup", "legacy content"]]);
    const sentIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toBe("https://router.test/v1/default/banks/A/memories");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { items: Array<{ document_id: string; content: string }> };
      const item = body.items[0];
      documents.set(item.document_id, item.content);
      sentIds.push(item.document_id);
      return Response.json({});
    });
    const client = new HindsightClient({ routerHarness: "codex", apiUrl: "https://router.test", bank: "A" });
    const coding = buildKnowledgeTools(client, "A").find((tool) => tool.name === "hindsight_ingest_document");
    const mcp = selectTools(loadConfig({ harness: "codex" }), client, "A", { cwd: dir, harness: "codex" }).find(
      (tool) => tool.name === "hindsight_ingest_document",
    );
    let openclawTools: Array<{ name: string; execute(id: string, params: Record<string, unknown>): Promise<unknown> }> =
      [];
    plugin({
      config: {
        plugins: {
          entries: {
            [PLUGIN_ID]: {
              config: {
                routerUrl: "https://router.test",
                agents: { codex: { token, writeBank: "A" } },
                enableKnowledgeTools: true,
                queueDir: join(dir, "queue"),
              },
            },
          },
        },
      },
      logger,
      on: vi.fn(),
      registerService: vi.fn(),
      registerTool(factory) {
        openclawTools = factory({ agentId: "codex" }) as typeof openclawTools;
      },
    });
    const openclaw = openclawTools.find((tool) => tool.name === "agent_knowledge_ingest");
    if (!coding || !mcp || !openclaw) throw new Error("ingest tool missing");
    const handlers = [coding.handler, mcp.handler, (args: Record<string, unknown>) => openclaw.execute("call", args)];
    for (const handler of handlers) {
      expect(await handler({ title, content: "first document" })).not.toMatchObject({ isError: true });
      expect(await handler({ title: otherTitle, content: "second document" })).not.toMatchObject({ isError: true });
      expect(await handler({ title, content: "updated first document" })).not.toMatchObject({ isError: true });
      const [firstId, secondId, updatedId] = sentIds.slice(-3);
      expect(firstId).not.toBe(secondId);
      expect(updatedId).toBe(firstId);
      expect(documents).toEqual(
        new Map([
          ["c-setup", "legacy content"],
          [firstId, "updated first document"],
          [secondId, "second document"],
        ]),
      );
    }
    expect(sentIds).toHaveLength(9);
  },
);

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
  writeFileSync(path, `${ownedCodexRegistration(dir)}\n${kept}[mcp_servers.hindsight.env]\nTOKEN = "old"${ending}`);
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

function ownedCodexRegistration(dir: string): string {
  return `[mcp_servers.hindsight]\ncommand = "node"\nargs = [${JSON.stringify(join(dir, ".hindsight", "coding-agents", "dist", "mcp-server.js"))}]\n`;
}

function installPackagedCodex(dir: string) {
  execFileSync("tar", ["-xzf", codingAgentsPackage(), "-C", dir]);
  return spawnSync(process.execPath, [join(dir, "package", "dist", "installer.js"), "install", "codex"], {
    env: { ...process.env, HOME: dir },
    cwd: dir,
    encoding: "utf8",
    timeout: 10000,
  });
}

it.each([undefined, "abc_"].flatMap((prefix) => ["missing", "malformed"].map((problem) => ({ prefix, problem }))))(
  "packaged CLI uninstalls $prefix with $problem managed configuration",
  ({ prefix, problem }) => {
    const dir = setup();
    const configPath = process.env.HINDSIGHT_ROUTER_CONFIG;
    if (!configPath) throw new Error("managed test configuration missing");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...config, toolPrefix: prefix }));
    const installed = installPackagedCodex(dir);
    expect(installed.status, installed.stderr).toBe(0);
    const id = prefix?.slice(0, -1) ?? "hindsight";
    const tomlPath = join(dir, ".codex/config.toml");
    const foreign = '[mcp_servers.foreign]\ncommand = "foreign"\n';
    writeFileSync(tomlPath, `${readFileSync(tomlPath, "utf8")}\n${foreign}`);
    if (problem === "missing") rmSync(configPath);
    else writeFileSync(configPath, "{malformed");
    const removed = spawnSync(process.execPath, [join(dir, "package/dist/installer.js"), "uninstall", "codex"], {
      env: { ...process.env, HOME: dir },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(removed.status, removed.stderr).toBe(0);
    expect(readFileSync(tomlPath, "utf8")).toContain(foreign);
    expect(readFileSync(tomlPath, "utf8")).not.toContain(`[mcp_servers.${id}]`);
    expect(existsSync(join(dir, ".agents/skills", `${id}-coding-agent`))).toBe(false);
    expect(readFileSync(join(dir, ".codex/hooks.json"), "utf8")).not.toContain("codex-hook.js");
  },
);

function initializeCodexMcp(
  dir: string,
  registration: CodexRegistration,
  hostEnv: NodeJS.ProcessEnv = process.env,
  cwd = dir,
) {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "TMPDIR", ...registration.env_vars]) {
    if (typeof entry !== "string" && entry.source === "remote") throw new Error("remote env requires remote stdio");
    const name = typeof entry === "string" ? entry : entry.name;
    if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
  }
  return spawnSync(registration.command, registration.args, {
    env: { ...env, HOME: dir, ...registration.env },
    cwd,
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codex-env-test", version: "1" } },
    })}\n`,
    encoding: "utf8",
    timeout: 10000,
  });
}

it("initializes the staged Codex MCP server through its generated allowlist without storing credentials", () => {
  const dir = setup();
  vi.stubEnv("OTHER_PRINCIPAL_TOKEN", "unrelated-secret");
  expect(installPackagedCodex(dir).status).toBe(0);
  const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
  const registration = parseToml(toml).mcp_servers.hindsight;
  expect(registration.env_vars).toEqual(
    expect.arrayContaining([
      "HINDSIGHT_ROUTER_CONFIG",
      "UPSTREAM_TEST_TOKEN",
      "HINDSIGHT_CONFIG",
      "HINDSIGHT_MCP_PROJECT_CWD",
      "HINDSIGHT_DISABLED",
      "HINDSIGHT_REFLECT_TOOL_TIMEOUT_MS",
      "HINDSIGHT_LOG_FILE",
      "HINDSIGHT_DIAG_FILE",
    ]),
  );
  expect(toml).not.toContain(token);
  expect(toml).not.toContain("OTHER_PRINCIPAL_TOKEN");
  expect(registration.args).toEqual([join(dir, ".hindsight", "coding-agents", "dist", "mcp-server.js")]);
  const initialized = initializeCodexMcp(dir, registration);
  expect(initialized.error).toBeUndefined();
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(JSON.parse(initialized.stdout).result.serverInfo.name).toBe("hindsight");
  for (const name of ["HINDSIGHT_ROUTER_CONFIG", "UPSTREAM_TEST_TOKEN"]) {
    const denied = initializeCodexMcp(dir, registration, { ...process.env, [name]: undefined });
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).not.toContain(token);
  }
});

it("forwards the optional project directory to the staged Codex MCP server", () => {
  const dir = setup();
  const unmapped = mkdtempSync(join(tmpdir(), "codex-unmapped-"));
  dirs.push(unmapped);
  vi.stubEnv("HINDSIGHT_MCP_PROJECT_CWD", dir);
  expect(installPackagedCodex(dir).status).toBe(0);
  const registration = parseToml(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).mcp_servers.hindsight;
  const initialized = initializeCodexMcp(dir, registration, process.env, unmapped);
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(JSON.parse(initialized.stdout).result.serverInfo.name).toBe("hindsight");
  const denied = initializeCodexMcp(
    dir,
    registration,
    { ...process.env, HINDSIGHT_MCP_PROJECT_CWD: undefined },
    unmapped,
  );
  expect(denied.status).toBe(1);
  expect(denied.stdout).toBe("");
});

it("rejects conflicting Codex launch config and preserves overrides after explicit operator migration", () => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  const override = join(dir, "override.json");
  const config = JSON.parse(readFileSync(process.env.HINDSIGHT_ROUTER_CONFIG!, "utf8"));
  config.principals.codex.tokenEnv = "CUSTOM_CODEX_TOKEN";
  writeFileSync(override, JSON.stringify(config));
  vi.stubEnv("CUSTOM_CODEX_TOKEN", token);
  writeFileSync(
    path,
    `[mcp_servers.other]\ncommand = "untouched"\n\n${ownedCodexRegistration(dir)}env_vars = ["USER_APPROVED_ENV", "HINDSIGHT_CONFIG"]\nstartup_timeout_sec = 45\ntool_timeout_sec = 180\nenabled = true\n\n[mcp_servers.hindsight.env]\nHINDSIGHT_ROUTER_CONFIG = ${JSON.stringify(override)}\nHINDSIGHT_MCP_HARNESS = "codex"\nHINDSIGHT_LOG_LEVEL = "error"\n`,
  );
  const original = readFileSync(path, "utf8");
  const rejected = installPackagedCodex(dir);
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).toBe("");
  expect(rejected.stderr).not.toContain(token);
  expect(readFileSync(path, "utf8")).toBe(original);
  for (const newPath of [".hindsight", ".agents", ".codex/hooks.json", ".codex/config.toml.hindsight-backup"]) {
    expect(existsSync(join(dir, newPath))).toBe(false);
  }
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", override);
  expect(installPackagedCodex(dir).status).toBe(0);
  const installed = readFileSync(path, "utf8");
  const registration = parseToml(installed).mcp_servers.hindsight;
  expect(registration).toMatchObject({
    startup_timeout_sec: 45,
    tool_timeout_sec: 180,
    enabled: true,
    env: { HINDSIGHT_ROUTER_CONFIG: override, HINDSIGHT_MCP_HARNESS: "codex", HINDSIGHT_LOG_LEVEL: "error" },
  });
  expect(registration.env_vars).toEqual(expect.arrayContaining(["CUSTOM_CODEX_TOKEN", "USER_APPROVED_ENV"]));
  expect(registration.env_vars).not.toContain("UPSTREAM_TEST_TOKEN");
  expect(installed).toContain('[mcp_servers.other]\ncommand = "untouched"');
  expect(installed).not.toContain(token);
  const initialized = initializeCodexMcp(dir, registration);
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(JSON.parse(initialized.stdout).result.serverInfo.name).toBe("hindsight");
  expect(installPackagedCodex(dir).status).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(installed);
});

it.each(["local", "remote", undefined] as const)(
  "preserves structured Codex allowlist entries with source %s across reinstalls",
  (source) => {
    const dir = setup();
    mkdirSync(join(dir, ".codex"));
    const path = join(dir, ".codex", "config.toml");
    const sourceField = source === undefined ? "" : `, source = "${source}"`;
    const entries = [
      '"USER_STRING_ENV"',
      `{ name = "USER_STRUCTURED_ENV"${sourceField} }`,
      '{ name = "HINDSIGHT_ROUTER_CONFIG" }',
      '{ name = "UPSTREAM_TEST_TOKEN", source = "local" }',
    ];
    writeFileSync(path, `${ownedCodexRegistration(dir)}env_vars = [${entries.join(", ")}]\n`);
    expect(installPackagedCodex(dir).status).toBe(0);
    const installed = readFileSync(path, "utf8");
    const registration = parseToml(installed).mcp_servers.hindsight;
    expect(registration.env_vars.slice(0, 4)).toEqual([
      "USER_STRING_ENV",
      source === undefined ? { name: "USER_STRUCTURED_ENV" } : { name: "USER_STRUCTURED_ENV", source },
      { name: "HINDSIGHT_ROUTER_CONFIG" },
      { name: "UPSTREAM_TEST_TOKEN", source: "local" },
    ]);
    const names = registration.env_vars.map((entry) => (typeof entry === "string" ? entry : entry.name));
    expect(names.filter((name) => name === "HINDSIGHT_ROUTER_CONFIG")).toHaveLength(1);
    expect(names.filter((name) => name === "UPSTREAM_TEST_TOKEN")).toHaveLength(1);
    expect(installed).not.toContain(token);
    if (source !== "remote") {
      const initialized = initializeCodexMcp(dir, registration);
      expect(initialized.status, initialized.stderr).toBe(0);
      expect(JSON.parse(initialized.stdout).result.serverInfo.name).toBe("hindsight");
    }
    expect(installPackagedCodex(dir).status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(installed);
  },
);

it.each([
  "7",
  '{ source = "local" }',
  '{ name = "USER_ENV", source = "unknown" }',
  `{ name = "USER_ENV", value = "${token}" }`,
])("rejects invalid structured Codex allowlist entry %# without writing host config", (entry) => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  const existing = `${ownedCodexRegistration(dir)}env_vars = [${entry}]\n`;
  writeFileSync(path, existing);
  const installed = installPackagedCodex(dir);
  expect(installed.status).toBe(1);
  expect(installed.stderr).toContain(
    "installation unavailable: verify operator provisioning, harness identity, project mapping and credentials",
  );
  expect(installed.stderr).not.toContain(token);
  expect(readFileSync(path, "utf8")).toBe(existing);
  expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(false);
  expect(existsSync(`${path}.hindsight-backup`)).toBe(false);
});

it("preserves structured Codex allowlist entries written as array tables", () => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  writeFileSync(
    path,
    ownedCodexRegistration(dir) +
      '\n[[mcp_servers.hindsight.env_vars]]\nname = "UPSTREAM_TEST_TOKEN"\nsource = "local"\n',
  );
  expect(installPackagedCodex(dir).status).toBe(0);
  const installed = readFileSync(path, "utf8");
  const registration = parseToml(installed).mcp_servers.hindsight;
  expect(registration.env_vars[0]).toEqual({ name: "UPSTREAM_TEST_TOKEN", source: "local" });
  const initialized = initializeCodexMcp(dir, registration);
  expect(initialized.status, initialized.stderr).toBe(0);
  expect(JSON.parse(initialized.stdout).result.serverInfo.name).toBe("hindsight");
  expect(installPackagedCodex(dir).status).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(installed);
});

it.each(["missing", "invalid", "unknown-principal"])(
  "refuses Codex installation with %s managed configuration",
  (kind) => {
    const dir = setup();
    if (kind === "missing") vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", "");
    if (kind === "invalid") writeFileSync(process.env.HINDSIGHT_ROUTER_CONFIG!, "{invalid");
    if (kind === "unknown-principal") writeFileSync(process.env.HINDSIGHT_ROUTER_CONFIG!, '{"principals":{}}');
    const installed = installPackagedCodex(dir);
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain(
      "installation unavailable: verify operator provisioning, harness identity, project mapping and credentials",
    );
    expect(installed.stderr).not.toContain(token);
    expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(false);
  },
);

it("refuses to copy a literal managed token when repairing an existing Codex registration", () => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  const existing = `${ownedCodexRegistration(dir)}env = { UPSTREAM_TEST_TOKEN = "${token}" }\n`;
  writeFileSync(path, existing);
  const installed = installPackagedCodex(dir);
  expect(installed.status).toBe(1);
  expect(installed.stderr).toContain(
    "installation unavailable: verify operator provisioning, harness identity, project mapping and credentials",
  );
  expect(installed.stderr).not.toContain(token);
  expect(readFileSync(path, "utf8")).toBe(existing);
  expect(existsSync(`${path}.hindsight-backup`)).toBe(false);
});

it("leaves malformed Codex TOML untouched without reporting its contents", () => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  const existing = `[mcp_servers.hindsight]\nenv = { UPSTREAM_TEST_TOKEN = "${token}"\n`;
  writeFileSync(path, existing);
  const installed = installPackagedCodex(dir);
  expect(installed.status).toBe(1);
  expect(installed.stderr).toContain(
    "installation unavailable: verify operator provisioning, harness identity, project mapping and credentials",
  );
  expect(installed.stderr).not.toContain(token);
  expect(readFileSync(path, "utf8")).toBe(existing);
  expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(false);
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
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "dist", "installer.js"), "runtime");
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
  writeFileSync(join(dist, "installer.js"), "runtime");
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

vi.mock("../src/coding-agents/human-session.js", async (original) => {
  const actual = await original<typeof import("../src/coding-agents/human-session.js")>();
  return {
    ...actual,
    readHumanSession: () => ({ token: `mrh_${"a".repeat(32)}_${"b".repeat(64)}`, principal_id: "human-example" }),
  };
});
const directories: string[] = [];
const packageRoot = new URL("../src/upstream/coding-agents", import.meta.url).pathname;
function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "human-install-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("stages native prebuilt dependency without npm lifecycle scripts or source-cache dependence", () => {
  const source = temporary();
  const staged = temporary();
  writeFileSync(join(source, "package.json"), "{}");
  stageNativeKeychain(packageRoot, source);
  stageNativeKeychain(source, staged);
  rmSync(source, { recursive: true, force: true });
  const result = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const {Entry} = require(${JSON.stringify(join(staged, "node_modules/@napi-rs/keyring"))});
    if (typeof Entry !== 'function') process.exit(2);
    if (process.platform === 'linux') {
      try { new Entry('synthetic-test','synthetic-user',{linux:{store:'secret-service'}}).getPassword(); process.exit(3); }
      catch { process.stdout.write('secure-store-unavailable'); }
    }
  `,
    ],
    { encoding: "utf8", env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-human-auth-test" } },
  );
  if (process.platform === "linux") expect(result).toBe("secure-store-unavailable");
});

it("bare updates stage native dependencies and preserve them when the next source lacks optional packages", () => {
  const home = temporary();
  const source = temporary();
  cpSync(join(packageRoot, "dist"), join(source, "dist"), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(source, "package.json"));
  stageNativeKeychain(packageRoot, source);
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", "");
  const ctx = { home, pkgRoot: source, dist: join(source, "dist") };
  expect(install(["update"], ctx)).toBe(0);
  const staged = join(home, ".hindsight/coding-agents");
  const nextSource = temporary();
  cpSync(join(packageRoot, "dist"), join(nextSource, "dist"), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(nextSource, "package.json"));
  writeFileSync(join(nextSource, "dist/new-entry.js"), "updated runtime");
  expect(install(["update"], { ...ctx, pkgRoot: nextSource, dist: join(nextSource, "dist") })).toBe(0);
  rmSync(nextSource, { recursive: true });
  rmSync(source, { recursive: true });
  expect(readFileSync(join(staged, "dist/new-entry.js"), "utf8")).toBe("updated runtime");
  expect(
    execFileSync(
      process.execPath,
      [
        "-e",
        `
    const requireNative = require("node:module").createRequire(${JSON.stringify(join(staged, "package.json"))});
    if (typeof requireNative("@napi-rs/keyring").Entry !== "function") process.exit(1);
    process.stdout.write("native-ready");
  `,
      ],
      { encoding: "utf8" },
    ),
  ).toBe("native-ready");
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

it("installs human-mode Codex without a token environment name and keeps native runtime with staged installer", () => {
  const home = temporary();
  const configPath = join(home, "managed.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      routerUrl: "https://router.example.test",
      principals: {
        codex: {
          human: { credentialRef: "person" },
          writeBank: "private",
          mapPathToBank: { [process.cwd()]: "private" },
        },
      },
    }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", configPath);
  vi.stubEnv("HINDSIGHT_MCP_HARNESS", "codex");
  const messages: string[] = [];
  const ctx = {
    home,
    pkgRoot: packageRoot,
    dist: join(packageRoot, "dist"),
    log: (message: string) => messages.push(message),
  };
  expect(install(["install", "codex"], ctx)).toBe(0);
  const registration = readFileSync(join(home, ".codex/config.toml"), "utf8");
  expect(registration).toContain("HINDSIGHT_ROUTER_CONFIG");
  expect(registration).not.toContain("tokenEnv");
  expect(registration).not.toContain("mrh_");
  expect(messages.join()).not.toContain("human-example");
  const native = join(home, ".hindsight/coding-agents/node_modules/@napi-rs/keyring/index.js");
  expect(existsSync(native)).toBe(true);
  const staged = join(home, ".hindsight/coding-agents");
  expect(install(["install", "codex"], { ...ctx, pkgRoot: staged, dist: join(staged, "dist") })).toBe(0);
  expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(registration);
  rmSync(configPath);
  expect(install(["uninstall", "codex"], { ...ctx, pkgRoot: staged, dist: join(staged, "dist") })).toBe(0);
  expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).not.toContain("mcp_servers.hindsight");
  expect(existsSync(join(home, ".agents/skills/hindsight-coding-agent"))).toBe(false);
});

it("keeps native support through a staged application-to-human migration after source cache removal", () => {
  const home = temporary();
  const source = temporary();
  cpSync(join(packageRoot, "dist"), join(source, "dist"), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(source, "package.json"));
  stageNativeKeychain(packageRoot, source);
  authMigrationConfig(home, false);
  expect(install(["install", "codex"], { home, pkgRoot: source, dist: join(source, "dist") })).toBe(0);
  rmSync(source, { recursive: true, force: true });
  const staged = join(home, ".hindsight/coding-agents");
  const loadNative = () =>
    execFileSync(
      process.execPath,
      [
        "-e",
        `
    const requireNative = require("node:module").createRequire(${JSON.stringify(join(staged, "package.json"))});
    const { Entry } = requireNative("@napi-rs/keyring");
    if (typeof Entry !== "function") throw new Error("native module missing");
    process.stdout.write("native-ready");
  `,
      ],
      { encoding: "utf8" },
    );
  expect(loadNative()).toBe("native-ready");
  authMigrationConfig(home, true);
  expect(install(["install", "codex"], { home, pkgRoot: staged, dist: join(staged, "dist") })).toBe(0);
  expect(loadNative()).toBe("native-ready");
  const current = parseToml(readFileSync(join(home, ".codex/config.toml"), "utf8")).mcp_servers.hindsight;
  expect(current.env.HINDSIGHT_ROUTER_AUTH_MODE).toBe("human");
  expect(current.env_vars).not.toContain("OLD_CODEX_TOKEN");
});

it("fails before host changes for an older staged runtime without native support and explains recovery", () => {
  const home = temporary();
  authMigrationConfig(home, true);
  const staged = join(home, ".hindsight/coding-agents");
  cpSync(join(packageRoot, "dist"), join(staged, "dist"), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(staged, "package.json"));
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml");
  const previous = ownedCodexRegistration(home);
  writeFileSync(path, previous);
  const result = spawnSync(process.execPath, [join(staged, "dist/installer.js"), "install", "codex"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain("reinstall from a verified package");
  expect(readFileSync(path, "utf8")).toBe(previous);
  expect(existsSync(`${path}.hindsight-backup`)).toBe(false);
  expect(existsSync(join(staged, "node_modules"))).toBe(false);
});

it("allows absent optional native packages without swallowing invalid package metadata", () => {
  const source = temporary();
  const staged = temporary();
  expect(stageNativeKeychain(source, staged, false)).toBe(false);
  const home = temporary();
  authMigrationConfig(home, false);
  cpSync(join(packageRoot, "dist"), join(source, "dist"), { recursive: true });
  cpSync(join(packageRoot, "package.json"), join(source, "package.json"));
  const log = vi.fn();
  expect(install(["install", "codex"], { home, pkgRoot: source, dist: join(source, "dist"), log })).toBe(0);
  expect(log.mock.calls.flat().join()).toContain("human login requires reinstalling from a verified package");
  expect(existsSync(join(home, ".hindsight/coding-agents/node_modules"))).toBe(false);
  const module = join(source, "node_modules/@napi-rs/keyring");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "package.json"), JSON.stringify({ version: "2.1.1", optionalDependencies: {} }));
  expect(stageNativeKeychain(source, staged, false)).toBe(false);
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ version: "2.1.1", optionalDependencies: { "untrusted-module": "2.1.1" } }),
  );
  expect(() => stageNativeKeychain(source, staged, false)).toThrow("invalid keychain package");
  expect(existsSync(join(staged, "node_modules"))).toBe(false);
});

it("rejects missing native dependency before replacing managed runtime", () => {
  const staged = temporary();
  mkdirSync(join(staged, "node_modules/@napi-rs"), { recursive: true });
  writeFileSync(join(staged, "node_modules/@napi-rs/owned"), "original");
  expect(() => stageNativeKeychain(temporary(), staged)).toThrow();
  expect(readFileSync(join(staged, "node_modules/@napi-rs/owned"), "utf8")).toBe("original");
});

function authMigrationConfig(home: string, human: boolean): void {
  const path = join(home, "managed.json");
  writeFileSync(
    path,
    JSON.stringify({
      routerUrl: "https://router.example.test",
      principals: {
        codex: {
          ...(human ? { human: { credentialRef: "person" } } : { tokenEnv: "OLD_CODEX_TOKEN" }),
          writeBank: "private",
          mapPathToBank: { [process.cwd()]: "private" },
        },
      },
    }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
  vi.stubEnv("HINDSIGHT_MCP_HARNESS", "codex");
  vi.stubEnv("OLD_CODEX_TOKEN", token);
}

it("removes the owned application binding on human migration and preserves user environment settings", () => {
  const home = temporary();
  authMigrationConfig(home, false);
  const ctx = { home, pkgRoot: packageRoot, dist: join(packageRoot, "dist") };
  expect(install(["install", "codex"], ctx)).toBe(0);
  const path = join(home, ".codex/config.toml");
  const old = readFileSync(path, "utf8");
  const previous = parseToml(old).mcp_servers.hindsight;
  expect(previous.env.HINDSIGHT_ROUTER_AUTH_MODE).toBe("persistent");
  expect(previous.env.HINDSIGHT_ROUTER_TOKEN_ENV).toBe("OLD_CODEX_TOKEN");
  writeFileSync(
    path,
    old.replace("env_vars = [", 'env_vars = ["USER_APPROVED_ENV", ') +
      `\nOLD_CODEX_TOKEN = ${JSON.stringify(token)}\nUSER_SETTING = "preserved"\n`,
  );
  authMigrationConfig(home, true);
  expect(install(["install", "codex"], ctx)).toBe(0);
  const current = readFileSync(path, "utf8");
  const installed = parseToml(current).mcp_servers.hindsight;
  expect(current).not.toContain("OLD_CODEX_TOKEN");
  expect(current).not.toContain(token);
  expect(installed.env).not.toHaveProperty("HINDSIGHT_ROUTER_TOKEN_ENV");
  expect(installed.env.HINDSIGHT_ROUTER_AUTH_MODE).toBe("human");
  expect(installed.env.USER_SETTING).toBe("preserved");
  expect(installed.env_vars).toContain("USER_APPROVED_ENV");
  expect(install(["install", "codex"], ctx)).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(current);
});

it("rejects ambiguous unmarked human migration before changes and preserves unknown user settings", () => {
  const home = temporary();
  authMigrationConfig(home, true);
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml");
  const old = `${ownedCodexRegistration(home)}env_vars = ["OLD_CODEX_TOKEN", "USER_APPROVED_ENV"]\n\n[mcp_servers.hindsight.env]\nUSER_SETTING = "preserved"\n`;
  writeFileSync(path, old);
  const log = vi.fn();
  expect(install(["install", "codex"], { home, pkgRoot: packageRoot, dist: join(packageRoot, "dist"), log })).toBe(1);
  expect(log.mock.calls.flat().join()).toContain("legacy credential bindings are unknown");
  expect(log.mock.calls.flat().join()).not.toContain(token);
  expect(readFileSync(path, "utf8")).toBe(old);
  expect(existsSync(join(home, ".hindsight"))).toBe(false);
  expect(existsSync(`${path}.hindsight-backup`)).toBe(false);
});

it.each([
  'env_vars = ["HINDSIGHT_LOG_FILE"]\n',
  'env_vars = [{ name = "HINDSIGHT_DIAG_FILE", source = "local" }]\n',
  `[mcp_servers.hindsight.env]\nHINDSIGHT_LOG_FILE = ${JSON.stringify(token)}\n`,
])("rejects reserved legacy credential bindings before writes %#", (environment) => {
  const home = temporary();
  authMigrationConfig(home, true);
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml");
  const old = ownedCodexRegistration(home) + environment;
  writeFileSync(path, old);
  const log = vi.fn();
  const ctx = { home, pkgRoot: packageRoot, dist: join(packageRoot, "dist"), log };
  expect(install(["install", "codex"], ctx)).toBe(1);
  expect(log.mock.calls.flat().join()).toContain("legacy credential bindings are unknown");
  expect(log.mock.calls.flat().join()).not.toContain(token);
  expect(readFileSync(path, "utf8")).toBe(old);
  expect(existsSync(join(home, ".hindsight"))).toBe(false);
  expect(existsSync(`${path}.hindsight-backup`)).toBe(false);
  writeFileSync(path, ownedCodexRegistration(home));
  expect(install(["install", "codex"], ctx)).toBe(0);
  const installed = parseToml(readFileSync(path, "utf8")).mcp_servers.hindsight;
  expect(installed.env_vars).toEqual(["HINDSIGHT_ROUTER_CONFIG"]);
  expect(installed.env).not.toHaveProperty("HINDSIGHT_LOG_FILE");
});

it("keeps ambiguous reserved legacy bindings unmarked through application reinstall", () => {
  const home = temporary();
  authMigrationConfig(home, false);
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml");
  writeFileSync(path, `${ownedCodexRegistration(home)}env_vars = ["HINDSIGHT_LOG_FILE"]\n`);
  const ctx = { home, pkgRoot: packageRoot, dist: join(packageRoot, "dist") };
  expect(install(["install", "codex"], ctx)).toBe(0);
  const previous = readFileSync(path, "utf8");
  expect(parseToml(previous).mcp_servers.hindsight.env).not.toHaveProperty("HINDSIGHT_ROUTER_AUTH_MODE");
  authMigrationConfig(home, true);
  expect(install(["install", "codex"], ctx)).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(previous);
});

it.each([
  'HINDSIGHT_ROUTER_AUTH_MODE = "other"',
  'HINDSIGHT_ROUTER_AUTH_MODE = "persistent"\nHINDSIGHT_ROUTER_TOKEN_ENV = "HINDSIGHT_ROUTER_CONFIG"',
  'HINDSIGHT_ROUTER_AUTH_MODE = "persistent"\nHINDSIGHT_ROUTER_TOKEN_ENV = 42',
  'HINDSIGHT_ROUTER_AUTH_MODE = "human"\nHINDSIGHT_ROUTER_TOKEN_ENV = "OLD_CODEX_TOKEN"',
])("rejects invalid owned credential metadata %# before changes", (metadata) => {
  const home = temporary();
  authMigrationConfig(home, true);
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml");
  const old = `${ownedCodexRegistration(home)}\n[mcp_servers.hindsight.env]\n${metadata}\n`;
  writeFileSync(path, old);
  expect(install(["install", "codex"], { home, pkgRoot: packageRoot, dist: join(packageRoot, "dist") })).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(old);
  expect(existsSync(join(home, ".hindsight"))).toBe(false);
});

it.each([undefined, "abc_"])("brands the packaged manual seed CLI for %s", (prefix) => {
  const dir = setup();
  const configPath = process.env.HINDSIGHT_ROUTER_CONFIG;
  if (!configPath) throw new Error("missing test managed config");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.principals["claude-code"].mapPathToBank[dir] = "A";
  writeFileSync(configPath, JSON.stringify({ ...config, toolPrefix: prefix }));
  execFileSync("tar", ["-xzf", codingAgentsPackage(), "-C", dir]);
  const seedPath = join(dir, "package/dist/hindsight-seed.js");
  const script = `
    const child = require("node:child_process");
    child.spawn = () => ({ on() {}, unref() {} });
    require("node:module").syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(seedPath)}, "seed", "--repo", ${JSON.stringify(dir)}];
    import(${JSON.stringify(seedPath)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", script], {
    env: { ...process.env, HOME: dir },
    cwd: dir,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`${prefix ? "abc" : "Hindsight"} is learning this repo`);
  if (prefix) expect(result.stdout).not.toContain("Hindsight");
});
it.each([undefined, "abc_"])("brands MCP startup failure after configuration initializes for %s", (prefix) => {
  const dir = setup();
  const configPath = process.env.HINDSIGHT_ROUTER_CONFIG;
  if (!configPath) throw new Error("missing test managed config");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, toolPrefix: prefix }));
  execFileSync("tar", ["-xzf", codingAgentsPackage(), "-C", dir]);
  const serverPath = join(dir, "package/dist/mcp-server.js");
  const script = `
    process.stdin.on = () => { throw new Error("startup test failure"); };
    process.argv[1] = ${JSON.stringify(serverPath)};
    import(${JSON.stringify(serverPath)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", script], {
    env: { ...process.env, HOME: dir, HINDSIGHT_MCP_HARNESS: "codex", HINDSIGHT_DISABLED: "1" },
    cwd: dir,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${prefix ? "abc" : "hindsight"} mcp-server failed:`);
  expect(result.stderr).toContain("startup test failure");
});

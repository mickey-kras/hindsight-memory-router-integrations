import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { loadMcpStack } from "../src/mcp/managed-config.js";
import { buildTools } from "../src/mcp/tools.js";
import plugin, { PLUGIN_ID } from "../src/plugin.js";
import { deriveBankId } from "../src/upstream/coding-agents/src/core/bank";
import { applyBankConfig, loadConfig, resolveConfig } from "../src/upstream/coding-agents/src/core/config";
import { HindsightClient, RateLimitedError } from "../src/upstream/coding-agents/src/core/hindsight";
import { buildHookOutput } from "../src/upstream/coding-agents/src/core/hook";
import { buildKnowledgeTools } from "../src/upstream/coding-agents/src/core/knowledge-tools";
import { readSessionCache, writeSessionCache } from "../src/upstream/coding-agents/src/core/session-cache";
import { run as install, parseJsonc } from "../src/upstream/coding-agents/src/installer";

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
      queueDir: join(dir, "queue"),
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
    const mcp = buildTools(loadMcpStack({ ...process.env, HINDSIGHT_ROUTER_PRINCIPAL: "codex" }, logger)).find(
      (tool) => tool.name === "agent_knowledge_ingest",
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

function installPackagedCodex(dir: string) {
  execFileSync("tar", ["-xzf", codingAgentsPackage(), "-C", dir]);
  return spawnSync(process.execPath, [join(dir, "package", "dist", "installer.js"), "install", "codex"], {
    env: { ...process.env, HOME: dir },
    cwd: dir,
    encoding: "utf8",
    timeout: 10000,
  });
}

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

it("preserves Codex overrides and manual allowlist entries when reinstalling with a different managed config", () => {
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
    `[mcp_servers.other]\ncommand = "untouched"\n\n[mcp_servers.hindsight]\ncommand = "old-node"\nargs = ["old.js"]\nenv_vars = ["USER_APPROVED_ENV", "HINDSIGHT_CONFIG"]\nstartup_timeout_sec = 45\ntool_timeout_sec = 180\nenabled = true\n\n[mcp_servers.hindsight.env]\nHINDSIGHT_ROUTER_CONFIG = ${JSON.stringify(override)}\nHINDSIGHT_MCP_HARNESS = "wrong"\nHINDSIGHT_LOG_LEVEL = "error"\n`,
  );
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
    writeFileSync(path, `[mcp_servers.hindsight]\ncommand = "node"\nenv_vars = [${entries.join(", ")}]\n`);
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
  const existing = `[mcp_servers.hindsight]\ncommand = "node"\nenv_vars = [${entry}]\n`;
  writeFileSync(path, existing);
  const installed = installPackagedCodex(dir);
  expect(installed.status).toBe(1);
  expect(installed.stderr).toContain("env_vars must contain names or { name, source } entries");
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
    '[mcp_servers.hindsight]\ncommand = "node"\n\n[[mcp_servers.hindsight.env_vars]]\nname = "UPSTREAM_TEST_TOKEN"\nsource = "local"\n',
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
    expect(installed.stderr).toContain("HINDSIGHT_ROUTER_CONFIG");
    expect(installed.stderr).not.toContain(token);
    expect(existsSync(join(dir, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(false);
  },
);

it("refuses to copy a literal managed token when repairing an existing Codex registration", () => {
  const dir = setup();
  mkdirSync(join(dir, ".codex"));
  const path = join(dir, ".codex", "config.toml");
  const existing = `[mcp_servers.hindsight]\ncommand = "node"\nenv = { UPSTREAM_TEST_TOKEN = "${token}" }\n`;
  writeFileSync(path, existing);
  const installed = installPackagedCodex(dir);
  expect(installed.status).toBe(1);
  expect(installed.stderr).toContain("remove its literal MCP env value");
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
  expect(installed.stderr).toContain("invalid config.toml");
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

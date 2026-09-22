import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { deriveBankId } from "../src/upstream/coding-agents/src/core/bank";
import { applyBankConfig, loadConfig, resolveConfig } from "../src/upstream/coding-agents/src/core/config";
import { HindsightClient } from "../src/upstream/coding-agents/src/core/hindsight";
import { buildHookOutput } from "../src/upstream/coding-agents/src/core/hook";
import { buildKnowledgeTools } from "../src/upstream/coding-agents/src/core/knowledge-tools";
import { readSessionCache, writeSessionCache } from "../src/upstream/coding-agents/src/core/session-cache";
import { run as install } from "../src/upstream/coding-agents/src/installer";

const dirs: string[] = [];
const token = `mr_codex_${"b".repeat(64)}`;
const { parse: parseToml } = createRequire(new URL("../src/upstream/coding-agents/package.json", import.meta.url))(
  "smol-toml",
) as { parse: (text: string) => { mcp_servers: { hindsight: CodexRegistration } } };
interface CodexRegistration {
  command: string;
  args: string[];
  env_vars: string[];
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
  execFileSync("tar", [
    "-xzf",
    codingAgentsPackage(),
    "-C",
    dir,
  ]);
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
  execFileSync("tar", [
    "-xzf",
    codingAgentsPackage(),
    "-C",
    dir,
  ]);
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
  for (const name of ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "TMPDIR", ...registration.env_vars]) {
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

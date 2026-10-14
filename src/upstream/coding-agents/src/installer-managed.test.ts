import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InstallTransaction } from "./install-transaction";
import { INSTALLERS, parseJsonc, run, type InstallCtx } from "./installer";
import * as humanSession from "@memory-router/coding-agents/human-session";

let root: string;
let ctx: InstallCtx;
let messages: string[];
function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function snapshot(path: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [file, entry.isDirectory() ? "directory" : readFileSync(file).toString("base64")];
    }));
}
function provision(names: string[], extra: Record<string, unknown> = {}) {
  const principals = Object.fromEntries(names.map((name) => [name, {
    tokenEnv: "TEST_MEMORY_TOKEN", writeBank: "A", additionalReadBanks: [],
    mapPathToBank: { [process.cwd()]: "A" }, ...extra,
  }]));
  const path = join(root, "router.json");
  put(path, JSON.stringify({ routerUrl: "https://router.example", principals }));
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "installer-managed-")); messages = [];
  ctx = { home: join(root, "home"), pkgRoot: join(root, "pkg"), dist: join(root, "pkg/dist"),
    interactive: false, log: (message) => messages.push(message), claudeMcp: () => true,
    qwenMcp: () => true, clinePlugin: () => true, dcodePlugin: () => true, nodeSqlite: () => true };
  mkdirSync(ctx.home); put(join(ctx.dist, "installer.js"), "runtime");
  put(join(ctx.pkgRoot, "package.json"), '{"version":"1.0.0"}');
  put(join(ctx.pkgRoot, "skill/SKILL.md"), "Use hindsight_recall");
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", ""); vi.stubEnv("HINDSIGHT_MCP_HARNESS", "");
  vi.stubEnv("TEST_MEMORY_TOKEN", `mr_test_${"a".repeat(64)}`);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("unattended runtime update", () => {
  function packagedPlugin(): void {
    put(join(ctx.pkgRoot, "plugin.json"), JSON.stringify({
      skills: "./skill",
      mcpServers: { hindsight: {
        command: "node", args: ["${PLUGIN_ROOT}/dist/mcp-server.js"],
        env: { HINDSIGHT_MCP_HARNESS: "dcode" },
      } },
    }));
  }

  it.each(["unset", "missing", "invalid"])("stages without %s managed configuration or harness detection", (state) => {
    if (state !== "unset") vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", join(root, "missing.json"));
    if (state === "invalid") put(join(root, "missing.json"), "{invalid config");
    vi.stubEnv("HINDSIGHT_MCP_HARNESS", "unavailable-harness");
    vi.stubEnv("TEST_MEMORY_TOKEN", "");
    const probes = INSTALLERS.map((installer) => vi.spyOn(installer, "detect"));
    packagedPlugin();
    expect(run(["update"], ctx)).toBe(0);
    expect(readFileSync(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"), "utf8")).toBe("runtime");
    expect(readdirSync(ctx.home)).toEqual([".hindsight"]);
    for (const probe of probes) expect(probe).not.toHaveBeenCalled();
  });

  it.each(["unset", "changed"])("preserves installed branding, metadata and every host file with %s configuration", (state) => {
    packagedPlugin();
    provision(["codex", "cursor-cli"]);
    const configPath = join(root, "router.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    put(configPath, JSON.stringify({ ...config, toolPrefix: "abc_" }));
    expect(run(["install", "codex", "cursor-cli"], ctx)).toBe(0);
    const staged = join(ctx.home, ".hindsight/coding-agents");
    put(join(staged, ".update-check.json"), '{"lastCheck":123,"latest":"2.0.0"}');
    put(join(staged, "dist/stale.js"), "stale runtime");
    const hostBefore = snapshot(ctx.home);
    const hostFiles = (files: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith(staged)));
    if (state === "unset") vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", "");
    else put(configPath, JSON.stringify({ ...config, toolPrefix: "memory_" }));
    vi.stubEnv("TEST_MEMORY_TOKEN", "");
    put(join(ctx.dist, "installer.js"), "updated runtime");
    put(join(ctx.pkgRoot, "package.json"), '{"version":"2.0.0"}');
    const adapters = INSTALLERS.map((installer) => vi.spyOn(installer, "install"));
    expect(run(["update"], ctx)).toBe(0);
    expect(hostFiles(snapshot(ctx.home))).toEqual(hostFiles(hostBefore));
    for (const adapter of adapters) expect(adapter).not.toHaveBeenCalled();
    expect(readFileSync(join(staged, "dist/installer.js"), "utf8")).toBe("updated runtime");
    expect(existsSync(join(staged, "dist/stale.js"))).toBe(false);
    expect(readFileSync(join(staged, "package.json"), "utf8")).toBe('{"version":"2.0.0"}');
    expect(readFileSync(join(staged, ".update-check.json"), "utf8")).toBe('{"lastCheck":123,"latest":"2.0.0"}');
    const manifest = JSON.parse(readFileSync(join(staged, "plugin.json"), "utf8")) as { skills: string; mcpServers: Record<string, unknown> };
    expect(manifest.skills).toBe("./abc-coding-agent");
    expect(Object.keys(manifest.mcpServers)).toEqual(["abc"]);
    expect(readFileSync(join(staged, "abc-coding-agent/SKILL.md"), "utf8")).toContain("abc_recall");
    expect(existsSync(join(staged, "memory-coding-agent"))).toBe(false);
    const origin = JSON.parse(readFileSync(join(staged, ".install-origin.json"), "utf8")) as { source: string; stagedAt: string };
    expect(origin.source).toBe(ctx.pkgRoot);
    expect(Number.isNaN(Date.parse(origin.stagedAt))).toBe(false);
  });

  it.each(["ambiguous", "malformed"])("rejects %s staged branding before writes", (state) => {
    const staged = join(ctx.home, ".hindsight/coding-agents");
    put(join(staged, "dist/installer.js"), "previous runtime");
    put(join(staged, "abc-coding-agent/SKILL.md"), "<!-- hindsight-tool-prefix: abc_ -->");
    const prefix = state === "ambiguous" ? "memory_" : "INVALID";
    put(join(staged, "memory-coding-agent/SKILL.md"), "<!-- hindsight-tool-prefix: " + prefix + " -->");
    const before = snapshot(ctx.home);
    expect(run(["update"], ctx)).toBe(1);
    expect(snapshot(ctx.home)).toEqual(before);
  });

  it.each(["unavailable", "expired"])("updates without reading %s human credentials", (state) => {
    provision(["codex"], { tokenEnv: undefined, human: { credentialRef: "synthetic" } });
    const read = vi.spyOn(humanSession, "readHumanSession").mockImplementation(() => {
      if (state === "unavailable") throw new humanSession.HumanLoginRequiredError();
      return humanSession.validateHumanSession({
        token: "mrh_" + "a".repeat(32) + "_" + "b".repeat(64),
        principal_id: "synthetic", expires_at: 1, routerUrl: "https://router.example",
      }, "https://router.example");
    });
    expect(run(["install", "codex"], ctx)).toBe(1);
    expect(read).toHaveBeenCalled();
    read.mockClear();
    expect(run(["update"], ctx)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(readdirSync(ctx.home)).toEqual([".hindsight"]);
  });

  it("restores runtime and metadata when staging fails", () => {
    const staged = join(ctx.home, ".hindsight/coding-agents");
    put(join(staged, "dist/installer.js"), "previous runtime");
    put(join(staged, ".install-origin.json"), '{"source":"previous"}');
    put(join(staged, "skill"), "obstruct copy");
    const before = snapshot(ctx.home);
    expect(run(["update"], ctx)).toBe(1);
    expect(snapshot(ctx.home)).toEqual(before);
    expect(messages).toHaveLength(1);
  });

  it("rejects history import without an explicit install", () => {
    expect(run(["update", "--import-conversations"], ctx)).toBe(1);
    expect(readdirSync(ctx.home)).toEqual([]);
  });
});

describe("operator-managed installation", () => {
  it.each(["--api-token", "--api-token=secret-do-not-print", "--api-url", "--api-url=https://secret", "--server", "--server=daemon"])("rejects %s before mutation", (flag) => {
    expect(run(["install", "codex", flag, "secret-do-not-print"], ctx)).toBe(1);
    expect(readdirSync(ctx.home)).toEqual([]); expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("secret-do-not-print");
  });
  it.each(["missing config", "missing token", "missing mapping", "invalid identity"])("fails closed: %s", (problem) => {
    provision(["codex"]); vi.stubEnv("HINDSIGHT_MCP_HARNESS", "codex");
    if (problem === "missing config") vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", "");
    if (problem === "missing token") vi.stubEnv("TEST_MEMORY_TOKEN", "");
    if (problem === "missing mapping") provision(["codex"], { mapPathToBank: {} });
    if (problem === "invalid identity") vi.stubEnv("HINDSIGHT_MCP_HARNESS", "secret-do-not-print");
    expect(run(["install"], ctx)).toBe(1); expect(readdirSync(ctx.home)).toEqual([]);
    expect(messages).toHaveLength(1); expect(messages[0]).not.toContain("secret-do-not-print");
  });
  it.each(["cursor-cli", "claude-code", "qwen-code"])("uninstalls owned old namespace for %s while preserving foreign desired namespace", (harness) => {
    provision([harness]);
    const routerPath = join(root, "router.json");
    const router = JSON.parse(readFileSync(routerPath, "utf8"));
    put(routerPath, JSON.stringify({ ...router, toolPrefix: "abc_" }));
    const native = vi.fn<(args: string[]) => boolean>(() => true);
    ctx.claudeMcp = native;
    ctx.qwenMcp = native;
    expect(run(["install", harness], ctx)).toBe(0);
    const path = join(ctx.home, harness === "cursor-cli" ? ".cursor/mcp.json" : harness === "claude-code" ? ".claude.json" : ".qwen/settings.json");
    const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    const foreign = { command: "foreign", args: ["foreign-server.js"] };
    config.mcpServers = {
      ...config.mcpServers,
      abc: { command: "node", args: [join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")], env: { HINDSIGHT_MCP_HARNESS: harness } },
      memory: foreign,
    };
    put(path, JSON.stringify(config));
    put(routerPath, JSON.stringify({ ...router, toolPrefix: "memory_" }));
    native.mockClear();
    expect(run(["uninstall", harness], ctx)).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.mcpServers.memory).toEqual(foreign);
    expect(after.mcpServers.abc).toBeUndefined();
    expect(native.mock.calls.some(([args]) => args.includes("memory"))).toBe(false);
    if (harness !== "cursor-cli") expect(native.mock.calls.some(([args]) => args.includes("abc"))).toBe(true);
  });
  it.each([
    ["antigravity-cli", ".gemini/config/mcp_config.json"],
    ["devin-cli", ".config/devin/mcp_config.json"],
    ["cursor-cli", ".cursor/mcp.json"],
    ["copilot-cli", ".copilot/mcp-config.json"],
    ["cline-cli", ".cline/data/settings/cline_mcp_settings.json"],
    ["factory-droid", ".factory/mcp.json"],
    ["zcode", ".zcode/cli/config.json"],
  ])("preserves foreign current namespace when uninstalling %s", (harness, relativePath) => {
    provision([harness]);
    const routerPath = join(root, "router.json");
    put(routerPath, JSON.stringify({ ...JSON.parse(readFileSync(routerPath, "utf8")), toolPrefix: "memory_" }));
    const path = join(ctx.home, relativePath);
    const servers = {
      abc: { command: "node", args: [join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")], env: { HINDSIGHT_MCP_HARNESS: harness } },
      memory: { command: "foreign", args: ["foreign-server.js"] },
    };
    put(path, JSON.stringify(harness === "zcode" ? { mcp: { servers } } : { mcpServers: servers }));
    expect(run(["uninstall", harness], ctx)).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(harness === "zcode" ? after.mcp.servers : after.mcpServers).toEqual({ memory: servers.memory });
  });
  it("rejects ambiguous detection", () => {
    provision(["codex", "cursor-cli"]); mkdirSync(join(ctx.home, ".codex")); mkdirSync(join(ctx.home, ".cursor"));
    expect(run(["install"], ctx)).toBe(1); expect(existsSync(join(ctx.home, ".hindsight"))).toBe(false);
  });
  it("preflights every selected principal before staging", () => {
    provision(["cursor-cli"]);
    expect(run(["install", "cursor-cli", "codex"], ctx)).toBe(1);
    expect(readdirSync(ctx.home)).toEqual([]); expect(messages).toHaveLength(1);
  });
  it("preflights all adapters before staging", () => {
    provision(["cursor-cli", "factory-droid"]);
    put(join(ctx.home, ".factory/mcp.json"), '{"mcpServers":{"hindsight":{"command":"foreign"}}}');
    expect(run(["install", "cursor-cli", "factory-droid"], ctx)).toBe(1);
    expect(existsSync(join(ctx.home, ".cursor"))).toBe(false);
    expect(existsSync(join(ctx.home, ".hindsight"))).toBe(false); expect(messages).toHaveLength(1);
  });
  it.each(["opencode", "opencode2", "kilo"].flatMap((name) => [
    { name, targets: [name] }, { name, targets: ["cursor-cli", name] },
  ]))("rejects malformed $name JSONC atomically for $targets", ({ name, targets }) => {
    provision(targets);
    const config = name === "kilo" ? ".config/kilo/kilo.jsonc" : ".config/opencode/opencode.jsonc";
    put(join(ctx.home, config), '{bad secret-do-not-print\n');
    put(join(ctx.home, ".cursor/hooks.json"), '{"hooks":{"stop":[{"command":"foreign"}]}}');
    put(join(ctx.home, ".cursor/mcp.json"), '{"mcpServers":{"foreign":{"command":"foreign"}}}');
    put(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"), "old runtime");
    put(join(ctx.home, ".cursor/skills/hindsight-coding-agent/SKILL.md"), "old skill");
    const before = snapshot(ctx.home);
    const installs = targets.map((target) => vi.spyOn(INSTALLERS.find((installer) => installer.name === target)!, "install"));
    expect(run(["install", ...targets], ctx)).toBe(1);
    expect(snapshot(ctx.home)).toEqual(before);
    for (const install of installs) expect(install).not.toHaveBeenCalled();
    expect(messages).toEqual(["installation unavailable: verify operator provisioning, harness identity, project mapping and credentials"]);
  });
  it.each(["opencode", "opencode2", "kilo"])("reports malformed %s config as adapter failure", (name) => {
    const config = name === "kilo" ? ".config/kilo/kilo.jsonc" : ".config/opencode/opencode.jsonc";
    put(join(ctx.home, config), "{bad");
    const adapter = INSTALLERS.find((installer) => installer.name === name)!;
    expect(adapter.install(ctx)).toBe(false);
    expect(readFileSync(join(ctx.home, config), "utf8")).toBe("{bad");
  });
  it.each(["opencode", "opencode2", "kilo"])("preserves valid %s JSONC comments and trailing commas", (name) => {
    provision([name]);
    const config = name === "kilo" ? ".config/kilo/kilo.jsonc" : ".config/opencode/opencode.jsonc";
    put(join(ctx.home, config), '{\n  // user settings\n  "provider": {\n    "name": "foreign",\n  },\n}\n');
    expect(run(["install", name], ctx)).toBe(0);
    const text = readFileSync(join(ctx.home, config), "utf8");
    expect(text).toContain('// user settings\n  "provider": {\n    "name": "foreign",\n  },');
    expect(parseJsonc(text)?.plugin).toHaveLength(1);
  });
  it("reinstalls a provisioned current harness idempotently and preserves foreign hooks", () => {
    provision(["cursor-cli"]); vi.stubEnv("HINDSIGHT_MCP_HARNESS", "cursor-cli");
    put(join(ctx.home, ".cursor/hooks.json"), '{"hooks":{"stop":[{"command":"foreign"}]}}');
    expect(run(["install"], ctx)).toBe(0);
    const first = readFileSync(join(ctx.home, ".cursor/hooks.json"), "utf8");
    expect(run(["install"], ctx)).toBe(0);
    expect(readFileSync(join(ctx.home, ".cursor/hooks.json"), "utf8")).toBe(first);
    expect(first).toContain("foreign"); expect(first).toContain(".hindsight/coding-agents/dist");
  });
  it.each(INSTALLERS.map((installer) => installer.name))("preserves supported adapter %s", (name) => {
    provision([name]); expect(run(["install", name], ctx)).toBe(0);
    expect(existsSync(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"))).toBe(true);
  });
  it("rolls back runtime, host files, backups and skills on native CLI failure", () => {
    provision(["cursor-cli", "claude-code"]);
    const original = '{"hooks":{"stop":[{"command":"foreign"}]}}';
    put(join(ctx.home, ".cursor/hooks.json"), original);
    put(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"), "old runtime");
    put(join(ctx.home, ".claude.json"), "old native registry");
    ctx.claudeMcp = () => { put(join(ctx.home, ".claude.json"), "changed registry"); throw new Error("secret-do-not-print"); };
    expect(run(["install", "cursor-cli", "claude-code"], ctx)).toBe(1);
    expect(readFileSync(join(ctx.home, ".cursor/hooks.json"), "utf8")).toBe(original);
    expect(readFileSync(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"), "utf8")).toBe("old runtime");
    expect(readFileSync(join(ctx.home, ".claude.json"), "utf8")).toBe("old native registry");
    expect(existsSync(join(ctx.home, ".cursor/hooks.json.hindsight-backup"))).toBe(false);
    expect(existsSync(join(ctx.home, ".claude"))).toBe(false); expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain("secret-do-not-print");
  });
  it("restores the old runtime when staging fails halfway", () => {
    provision(["cursor-cli"]);
    put(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"), "old runtime");
    put(join(ctx.home, ".hindsight/coding-agents/skill"), "obstruct copy");
    expect(run(["install", "cursor-cli"], ctx)).toBe(1);
    expect(readFileSync(join(ctx.home, ".hindsight/coding-agents/dist/installer.js"), "utf8")).toBe("old runtime");
    expect(existsSync(join(ctx.home, ".cursor"))).toBe(false); expect(messages).toHaveLength(1);
  });
  it("rejects linked mutation paths without changing their targets", () => {
    provision(["cursor-cli"]);
    const target = join(root, "external-hooks.json"); put(target, '{}');
    mkdirSync(join(ctx.home, ".cursor")); symlinkSync(target, join(ctx.home, ".cursor/hooks.json"));
    expect(run(["install", "cursor-cli"], ctx)).toBe(1);
    expect(readFileSync(target, "utf8")).toBe('{}');
    expect(existsSync(join(ctx.home, ".hindsight"))).toBe(false);
  });
  it.each([
    ".hindsight/coding-agents/package.json",
    ".cursor/skills/hindsight-coding-agent/SKILL.md",
  ])("refuses descendant destination links at %s before staging or adapters", (relativePath) => {
    provision(["cursor-cli", "claude-code"]);
    const external = join(root, "external-target"); put(external, "external original");
    const destination = join(ctx.home, relativePath);
    mkdirSync(dirname(destination), { recursive: true }); symlinkSync(external, destination);
    const runtime = join(ctx.home, ".hindsight/coding-agents/dist/installer.js");
    put(runtime, "previous runtime");
    const failAdapter = vi.spyOn(INSTALLERS.find((installer) => installer.name === "claude-code")!, "install")
      .mockImplementation(() => { throw new Error("forced later adapter failure"); });
    expect(run(["install", "cursor-cli", "claude-code"], ctx)).toBe(1);
    expect(readFileSync(external, "utf8")).toBe("external original");
    expect(readFileSync(runtime, "utf8")).toBe("previous runtime");
    expect(failAdapter).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.home, ".cursor/hooks.json"))).toBe(false);
    expect(messages).toHaveLength(1);
  });
  it.each([
    ".hindsight/coding-agents/package.json",
    ".cursor/skills/hindsight-coding-agent/SKILL.md",
  ])("refuses hardlinked destination files at %s before mutation", (relativePath) => {
    provision(["cursor-cli", "claude-code"]);
    const external = join(root, "external-hardlink-target"); put(external, "external original");
    const destination = join(ctx.home, relativePath);
    mkdirSync(dirname(destination), { recursive: true }); linkSync(external, destination);
    const runtime = join(ctx.home, ".hindsight/coding-agents/dist/installer.js");
    put(runtime, "previous runtime");
    const failAdapter = vi.spyOn(INSTALLERS.find((installer) => installer.name === "claude-code")!, "install")
      .mockImplementation(() => false);
    expect(run(["install", "cursor-cli", "claude-code"], ctx)).toBe(1);
    expect(readFileSync(external, "utf8")).toBe("external original");
    expect(readFileSync(runtime, "utf8")).toBe("previous runtime");
    expect(failAdapter).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.home, ".cursor/hooks.json"))).toBe(false);
    expect(messages).toHaveLength(1);
  });
  it.each(["package.json", "skill/SKILL.md"])("copies hardlinked source %s into independent destination files", (relativePath) => {
    provision(["cursor-cli"]);
    const source = join(ctx.pkgRoot, relativePath);
    const original = readFileSync(source, "utf8");
    const external = join(root, "external-source-hardlink"); put(external, original);
    rmSync(source); linkSync(external, source);
    expect(run(["install", "cursor-cli"], ctx)).toBe(0);
    expect(readFileSync(external, "utf8")).toBe(original);
  });
  it("rejects packaged skill links before copying them into writable destinations", () => {
    provision(["cursor-cli"]);
    const external = join(root, "external-source-skill"); put(external, "Use hindsight_recall");
    rmSync(join(ctx.pkgRoot, "skill/SKILL.md"));
    symlinkSync(external, join(ctx.pkgRoot, "skill/SKILL.md"));
    expect(run(["install", "cursor-cli"], ctx)).toBe(1);
    expect(readFileSync(external, "utf8")).toBe("Use hindsight_recall");
    expect(readdirSync(ctx.home)).toEqual([]); expect(messages).toHaveLength(1);
  });
  it("retains originals when rollback cannot restore a path", () => {
    const original = join(root, "restore-parent/original.json"); put(original, "original data");
    const transaction = new InstallTransaction([original]);
    rmSync(dirname(original), { recursive: true }); put(dirname(original), "blocks parent creation");
    expect(() => transaction.rollback()).toThrow("rollback incomplete");
    expect(readFileSync(join(transaction.recoveryDirectory, "0"), "utf8")).toBe("original data");
    rmSync(dirname(original)); transaction.rollback();
    expect(readFileSync(original, "utf8")).toBe("original data");
  });
  it("prints one sanitized line if rollback fails", () => {
    provision(["cursor-cli"]);
    vi.spyOn(INSTALLERS.find((installer) => installer.name === "cursor-cli")!, "install").mockImplementation(() => { throw new Error("secret-do-not-print"); });
    vi.spyOn(InstallTransaction.prototype, "rollback").mockImplementation(function (this: InstallTransaction) { this.commit(); throw new Error("secret-do-not-print"); });
    expect(run(["install", "cursor-cli"], ctx)).toBe(1);
    expect(messages).toEqual(["installation failed; rollback incomplete; recovery snapshots retained"]);
  });
  it("rejects an incomplete runtime without falling back to cache paths", () => {
    provision(["cursor-cli"]); rmSync(join(ctx.dist, "installer.js"));
    expect(run(["install", "cursor-cli"], ctx)).toBe(1); expect(readdirSync(ctx.home)).toEqual([]);
  });
});


it.each([
  ["workbuddy", ".workbuddy/mcp.json"],
  ["codebuddy", ".codebuddy/.mcp.json"],
  ["kimi-code", ".kimi-code/mcp.json"],
])("installs %s with its managed identity and custom namespace and preserves foreign servers", (name, relative) => {
  provision([name]);
  const configPath = join(root, "router.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  put(configPath, JSON.stringify({ ...config, toolPrefix: "abc_" }));
  const path = join(ctx.home, relative);
  const foreign = { command: "foreign", args: [] };
  put(path, JSON.stringify({ mcpServers: { unrelated: foreign } }));
  expect(run(["install", name], ctx)).toBe(0);
  const servers = JSON.parse(readFileSync(path, "utf8")).mcpServers;
  expect(servers.abc.env.HINDSIGHT_MCP_HARNESS).toBe(name);
  expect(servers).not.toHaveProperty("hindsight");
  expect(servers.unrelated).toEqual(foreign);
  expect(run(["uninstall", name], ctx)).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({ unrelated: foreign });
});
it.each([
  ["workbuddy", ".workbuddy/mcp.json"],
  ["codebuddy", ".codebuddy/.mcp.json"],
  ["kimi-code", ".kimi-code/mcp.json"],
])("refuses foreign registration collision in new %s adapter before any mutation", (name, relative) => {
  provision([name]);
  put(join(ctx.home, relative), JSON.stringify({ mcpServers: { hindsight: { command: "foreign", args: [] } } }));
  const before = snapshot(ctx.home);
  expect(run(["install", name], ctx)).toBe(1);
  expect(snapshot(ctx.home)).toEqual(before);
});

it("installs Trae workspace MCP only in explicitly managed projects using the branded identity", () => {
  provision(["traecode"], { mapPathToBank: { [root]: "A" } });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  const configPath = join(root, "router.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  put(configPath, JSON.stringify({ ...config, toolPrefix: "abc_" }));
  put(join(ctx.dist, "mcp-server.js"), "runtime");
  expect(run(["install", "traecode"], ctx)).toBe(0);
  const file = join(root, ".trae/mcp.json");
  const entry = JSON.parse(readFileSync(file, "utf8")).mcpServers.abc;
  expect(entry.env).toMatchObject({ HINDSIGHT_MCP_HARNESS: "traecode", HINDSIGHT_MCP_PROJECT_CWD: root });
  expect(existsSync(join(ctx.home, ".config/Trae CN/User/settings.json"))).toBe(false);
  expect(run(["uninstall", "traecode"], ctx)).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).not.toHaveProperty("abc");
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InstallTransaction } from "./install-transaction";
import { INSTALLERS, parseJsonc, run, type InstallCtx } from "./installer";

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

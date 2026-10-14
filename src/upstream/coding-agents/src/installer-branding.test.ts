import { assertCompanionSkillPrefix } from "./core/skill-sync";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { run, type InstallCtx } from "./installer";

let root: string;
let ctx: InstallCtx;
let cli = vi.fn((_args: string[]) => true);
function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function provision(toolPrefix?: string) {
  const path = join(root, "router.json");
  put(path, JSON.stringify({ routerUrl: "https://router.example", toolPrefix, principals: Object.fromEntries([
    "codex", "cursor-cli", "claude-code", "qwen-code", "grok-build", "dcode", "zcode", "factory-droid", "copilot-cli", "antigravity-cli", "devin-cli", "cline-cli", "dsh", "kilo",
  ].map(name => [name, { tokenEnv: "TEST_MEMORY_TOKEN", writeBank: "A", mapPathToBank: { [process.cwd()]: "A" } }])) }));
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "installer-branding-")); cli = vi.fn((_args: string[]) => true);
  ctx = { home: join(root, "home"), pkgRoot: join(root, "pkg"), dist: join(root, "pkg/dist"), interactive: false,
    claudeMcp: cli, qwenMcp: cli, clinePlugin: cli, dcodePlugin: cli, nodeSqlite: () => true };
  mkdirSync(ctx.home); put(join(ctx.dist, "installer.js"), "runtime"); put(join(ctx.pkgRoot, "package.json"), '{"name":"stable-package","version":"1.0.0"}');
  put(join(ctx.pkgRoot, "skill/SKILL.md"), '---\nname: hindsight-coding-agent\ndescription: Hindsight memory\n---\nCall hindsight_reflect. From Hindsight memory.');
  put(join(ctx.pkgRoot, "plugin.json"), JSON.stringify({ name: "hindsight-coding-agents", skills: "./skill", mcpServers: { hindsight: { command: "node", args: ["${PLUGIN_ROOT}/dist/mcp-server.js"], env: { HINDSIGHT_MCP_HARNESS: "dcode" } } } }));
  vi.stubEnv("TEST_MEMORY_TOKEN", `mr_test_${"a".repeat(64)}`); vi.stubEnv("HINDSIGHT_MCP_HARNESS", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
it.each([undefined, "abc_", "chatgpt_", "memory_"])("brands native MCP, installed skill and staged plugin from %s", prefix => {
  provision(prefix); const id = prefix?.slice(0, -1) ?? "hindsight";
  expect(run(["install", "codex", "cursor-cli", "dcode"], ctx)).toBe(0);
  const toml = parseToml(readFileSync(join(ctx.home, ".codex/config.toml"), "utf8"));
  expect(Object.keys(toml.mcp_servers as object)).toEqual([id]);
  expect(Object.keys(JSON.parse(readFileSync(join(ctx.home, ".cursor/mcp.json"), "utf8")).mcpServers)).toEqual([id]);
  const skill = readFileSync(join(ctx.home, ".agents/skills", `${id}-coding-agent/SKILL.md`), "utf8");
  expect(skill).toContain(`name: ${id}-coding-agent`); expect(skill).toContain(`${prefix ?? "hindsight_"}reflect`);
  expect(skill).toContain(`From ${prefix ? id : "Hindsight"} memory`);
  const manifest = JSON.parse(readFileSync(join(ctx.home, ".hindsight/coding-agents/plugin.json"), "utf8"));
  expect(Object.keys(manifest.mcpServers)).toEqual([id]); expect(manifest.skills).toBe(`./${id}-coding-agent`);
  expect(manifest.name).toBe("hindsight-coding-agents");
  expect(JSON.parse(readFileSync(join(ctx.home, ".hindsight/coding-agents/package.json"), "utf8")).name).toBe("stable-package");
});
it.each(["claude-code", "qwen-code"])("passes the brand to real %s native MCP commands", harness => {
  provision("abc_"); expect(run(["install", harness], ctx)).toBe(0);
  const add = cli.mock.calls.map(call => call[0] as string[]).find(args => args[0] === "mcp" && args[1] === "add");
  expect(add).toContain("abc"); expect(add).not.toContain("hindsight");
});
it("migrates default and custom skills/registrations atomically without deleting unrelated skills", () => {
  provision(); expect(run(["install", "codex", "cursor-cli"], ctx)).toBe(0);
  put(join(ctx.home, ".agents/skills/personal-coding-agent/SKILL.md"), "User-owned notes");
  for (const prefix of ["abc_", "memory_"]) {
    provision(prefix); expect(run(["update", "codex", "cursor-cli"], ctx)).toBe(0);
    const id = prefix.slice(0, -1);
    expect(Object.keys((parseToml(readFileSync(join(ctx.home, ".codex/config.toml"), "utf8")).mcp_servers as object))).toEqual([id]);
    expect(Object.keys(JSON.parse(readFileSync(join(ctx.home, ".cursor/mcp.json"), "utf8")).mcpServers)).toEqual([id]);
    expect(readFileSync(join(ctx.home, ".agents/skills/personal-coding-agent/SKILL.md"), "utf8")).toBe("User-owned notes");
  }
  expect(existsSync(join(ctx.home, ".agents/skills/hindsight-coding-agent"))).toBe(false);
  expect(existsSync(join(ctx.home, ".agents/skills/abc-coding-agent"))).toBe(false);
  provision(); expect(run(["update", "codex", "cursor-cli"], ctx)).toBe(0);
  expect(Object.keys(parseToml(readFileSync(join(ctx.home, ".codex/config.toml"), "utf8")).mcp_servers as object)).toEqual(["hindsight"]);
  provision("chatgpt_"); expect(run(["uninstall", "codex", "cursor-cli"], ctx)).toBe(0);
  expect(existsSync(join(ctx.home, ".agents/skills/memory-coding-agent"))).toBe(false);
  expect(existsSync(join(ctx.home, ".agents/skills/personal-coding-agent"))).toBe(true);
  expect((parseToml(readFileSync(join(ctx.home, ".codex/config.toml"), "utf8")).mcp_servers)).toBeUndefined();
  expect(JSON.parse(readFileSync(join(ctx.home, ".cursor/mcp.json"), "utf8")).mcpServers).toEqual({});
});
it.each(["skill", "JSON MCP", "TOML MCP"])("rejects an unrelated target %s collision without mutation", kind => {
  provision("abc_"); let path: string; let previous: string;
  if (kind === "skill") { path = join(ctx.home, ".agents/skills/abc-coding-agent/SKILL.md"); previous = "User-owned instructions"; }
  else if (kind === "JSON MCP") { path = join(ctx.home, ".cursor/mcp.json"); previous = '{"mcpServers":{"abc":{"command":"foreign"}}}'; }
  else { path = join(ctx.home, ".codex/config.toml"); previous = '[mcp_servers.abc]\ncommand="foreign"\n'; }
  put(path, previous); expect(run(["install", "codex", "cursor-cli"], ctx)).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(previous); expect(existsSync(join(ctx.home, ".hindsight"))).toBe(false);
});
it("rolls a brand change back when native registration fails", () => {
  provision(); expect(run(["install", "codex", "claude-code"], ctx)).toBe(0);
  const path = join(ctx.home, ".codex/config.toml"); const previous = readFileSync(path, "utf8");
  provision("abc_"); ctx.claudeMcp = () => false;
  expect(run(["install", "codex", "claude-code"], ctx)).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(previous);
  expect(existsSync(join(ctx.home, ".agents/skills/hindsight-coding-agent"))).toBe(true);
  expect(existsSync(join(ctx.home, ".agents/skills/abc-coding-agent"))).toBe(false);
});

it.each([
  ["antigravity-cli", ".gemini/config/mcp_config.json"], ["devin-cli", ".config/devin/mcp_config.json"],
  ["cursor-cli", ".cursor/mcp.json"], ["copilot-cli", ".copilot/mcp-config.json"],
  ["cline-cli", ".cline/data/settings/cline_mcp_settings.json"], ["factory-droid", ".factory/mcp.json"],
])("brands %s JSON registration and preserves foreign entries on uninstall", (harness, relative) => {
  provision("abc_"); const path = join(ctx.home, relative);
  put(path, '{"mcpServers":{"hindsight":{"command":"unrelated"}}}');
  expect(run(["install", harness], ctx)).toBe(0);
  expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers)).toEqual(["hindsight", "abc"]);
  expect(run(["uninstall", harness], ctx)).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers).toEqual({ hindsight: { command: "unrelated" } });
});
it("brands Grok's actual TOML MCP table through custom and default migrations", () => {
  for (const prefix of ["abc_", "memory_", undefined]) {
    provision(prefix); expect(run(["install", "grok-build"], ctx)).toBe(0);
    expect(Object.keys(parseToml(readFileSync(join(ctx.home, ".grok/config.toml"), "utf8")).mcp_servers as object)).toEqual([prefix?.slice(0, -1) ?? "hindsight"]);
  }
});
it.each(["claude-code", "qwen-code"])("removes only saved managed native CLI aliases when %s branding changes", harness => {
  provision("abc_"); const path = join(ctx.home, harness === "claude-code" ? ".claude.json" : ".qwen/settings.json");
  const entry = { command: "node", args: [join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")], env: { HINDSIGHT_MCP_HARNESS: harness } };
  put(path, JSON.stringify({ mcpServers: { oldbrand: entry, hindsight: { command: "foreign" } } }));
  expect(run(["install", harness], ctx)).toBe(0);
  const removes = cli.mock.calls.map(call => call[0] as string[]).filter(args => args[0] === "mcp" && args[1] === "remove");
  expect(removes.flat()).toContain("oldbrand"); expect(removes.flat()).not.toContain("hindsight");
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.hindsight).toEqual({ command: "foreign" });
});
it.each([undefined, "abc_"])("migrates owned Codex array tables while preserving adjacent foreign tables: %s", prefix => {
  provision(prefix); const path = join(ctx.home, ".codex/config.toml"); const source = prefix ? "legacy" : "hindsight";
  const foreign = '  [mcp_servers.foreign]\n  command = "foreign"\n\n  [[mcp_servers.foreign.env_vars]]\n  name = "FOREIGN_TOKEN"\n  source = "remote"\n';
  const owned = `[mcp_servers.${source}]\ncommand = "node"\nargs = ${JSON.stringify([join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")])}\n\n` +
    `  [[mcp_servers.${source}.env_vars]]\n  name = "TEST_MEMORY_TOKEN"\n  source = "local"\n\n`;
  put(path, owned + foreign);
  expect(run(["install", "codex"], ctx)).toBe(0);
  const first = readFileSync(path, "utf8"); const parsed = parseToml(first);
  const servers = parsed.mcp_servers as Record<string, { env_vars?: { name: string; source: string }[] }>;
  expect(servers[prefix ? "abc" : "hindsight"].env_vars?.[0]).toEqual({ name: "TEST_MEMORY_TOKEN", source: "local" });
  expect(servers.foreign.env_vars).toEqual([{ name: "FOREIGN_TOKEN", source: "remote" }]);
  expect(first).toContain(foreign);
  if (prefix) expect(servers).not.toHaveProperty("legacy");
  expect(run(["install", "codex"], ctx)).toBe(0); expect(readFileSync(path, "utf8")).toBe(first);
  expect(run(["uninstall", "codex"], ctx)).toBe(0);
  const remaining = readFileSync(path, "utf8"); expect(remaining).toContain(foreign);
  expect(Object.keys(parseToml(remaining).mcp_servers as object)).toEqual(["foreign"]);
});

const baselineSkill = readFileSync(new URL("./core/fixtures/baseline-companion-skill.md", import.meta.url), "utf8");
it.each([undefined, "abc_"])("upgrades the exact baseline-generated companion skill for %s", prefix => {
  provision(prefix); const base = join(ctx.home, ".agents/skills"); const previous = join(base, "hindsight-coding-agent");
  put(join(previous, "SKILL.md"), baselineSkill);
  if (prefix) expect(() => assertCompanionSkillPrefix("codex", prefix, ctx.home)).toThrow("reinstall");
  else expect(() => assertCompanionSkillPrefix("codex", "hindsight_", ctx.home)).not.toThrow();
  expect(run(["update", "codex"], ctx)).toBe(0);
  const selected = join(base, `${prefix?.slice(0, -1) ?? "hindsight"}-coding-agent`);
  const upgraded = readFileSync(join(selected, "SKILL.md"), "utf8");
  expect(upgraded).toContain(`name: ${prefix?.slice(0, -1) ?? "hindsight"}-coding-agent`);
  expect(upgraded).toContain(`<!-- hindsight-tool-prefix: ${prefix ?? "hindsight_"} -->`);
  expect(() => assertCompanionSkillPrefix("codex", prefix ?? "hindsight_", ctx.home)).not.toThrow();
  if (prefix) expect(existsSync(previous)).toBe(false);
  expect(run(["uninstall", "codex"], ctx)).toBe(0); expect(existsSync(selected)).toBe(false);
});
it("rolls a baseline skill migration back exactly if the next native adapter fails", () => {
  provision("abc_"); const path = join(ctx.home, ".agents/skills/hindsight-coding-agent/SKILL.md"); put(path, baselineSkill);
  ctx.claudeMcp = () => false; expect(run(["install", "codex", "claude-code"], ctx)).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(baselineSkill); expect(existsSync(join(ctx.home, ".agents/skills/abc-coding-agent"))).toBe(false);
});
it("preserves an unrelated default namesake through custom install and uninstall", () => {
  provision("abc_"); const path = join(ctx.home, ".agents/skills/hindsight-coding-agent/SKILL.md");
  const userSkill = '---\nname: hindsight-coding-agent\n---\nUser-owned instructions without generated provenance.';
  put(path, userSkill); expect(run(["install", "codex"], ctx)).toBe(0); expect(run(["uninstall", "codex"], ctx)).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(userSkill);
  provision(); expect(run(["install", "codex"], ctx)).toBe(1); expect(readFileSync(path, "utf8")).toBe(userSkill);
});

it.each(["install", "update"])("rejects conflicting retained Codex launch provisioning before any %s writes", command => {
  provision("abc_"); const alternate = join(root, "alternate-router.json");
  put(alternate, JSON.stringify({ routerUrl: "https://router.example", toolPrefix: "xyz_", principals: {
    codex: { tokenEnv: "TEST_MEMORY_TOKEN", writeBank: "B", mapPathToBank: { [process.cwd()]: "B" } },
  } }));
  const path = join(ctx.home, ".codex/config.toml");
  const original = stringifyToml({ mcp_servers: { xyz: {
    command: "node", args: [join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")],
    env: { HINDSIGHT_ROUTER_CONFIG: alternate, HINDSIGHT_MCP_HARNESS: "codex", EXTRA_OPTION: "preserved" },
  } } });
  put(path, original);
  expect(run([command, "cursor-cli", "codex"], ctx)).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(original);
  for (const newPath of [".hindsight", ".agents", ".cursor", ".codex/hooks.json", ".codex/config.toml.hindsight-backup"])
    expect(existsSync(join(ctx.home, newPath))).toBe(false);
});
it.each([false, true])("preserves retained same-file Codex launch configuration and unrelated overrides (alias=%s)", alias => {
  provision("abc_"); const canonical = process.env.HINDSIGHT_ROUTER_CONFIG ?? "";
  const launchPath = alias ? join(root, "same-config-alias.json") : canonical;
  if (alias) symlinkSync(canonical, launchPath);
  const path = join(ctx.home, ".codex/config.toml");
  put(path, stringifyToml({ mcp_servers: { hindsight: {
    command: "node", args: [join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")],
    env_vars: [{ name: "EXTRA_ENV", source: "local" }],
    env: { HINDSIGHT_ROUTER_CONFIG: launchPath, EXTRA_OPTION: "preserved" },
  } } }));
  expect(run(["install", "codex"], ctx)).toBe(0);
  const registration = (parseToml(readFileSync(path, "utf8")).mcp_servers as Record<string, { env: Record<string, string>; env_vars: unknown[] }>).abc;
  expect(registration.env.HINDSIGHT_ROUTER_CONFIG).toBe(launchPath);
  expect(registration.env.EXTRA_OPTION).toBe("preserved");
  expect(registration.env_vars).toContainEqual({ name: "EXTRA_ENV", source: "local" });
  expect(readFileSync(join(ctx.home, ".agents/skills/abc-coding-agent/SKILL.md"), "utf8")).toContain("abc_reflect");
});

it.each([undefined, "abc_"].flatMap(prefix => ["missing", "malformed"].map(problem => ({ prefix, problem }))))(
  "uninstalls owned default/custom registrations and skills with $problem operator config ($prefix)",
  ({ prefix, problem }) => {
    provision(prefix);
    const id = prefix?.slice(0, -1) ?? "hindsight";
    const harnesses = ["codex", "cursor-cli", "claude-code", "qwen-code"];
    expect(run(["install", ...harnesses], ctx)).toBe(0);
    const foreign = { command: "foreign", args: ["foreign-server.js"] };
    for (const [harness, relativePath] of [
      ["cursor-cli", ".cursor/mcp.json"], ["claude-code", ".claude.json"], ["qwen-code", ".qwen/settings.json"],
    ]) {
      const path = join(ctx.home, relativePath);
      const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      config.mcpServers = { ...config.mcpServers,
        [id]: { command: "node", args: [join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")], env: { HINDSIGHT_MCP_HARNESS: harness } },
        foreign,
      };
      put(path, JSON.stringify(config));
    }
    const tomlPath = join(ctx.home, ".codex/config.toml");
    const foreignToml = '[mcp_servers.foreign]\ncommand = "foreign"\nargs = ["foreign-server.js"]\n';
    put(tomlPath, readFileSync(tomlPath, "utf8") + "\n" + foreignToml);
    const skillBases = [".agents/skills", ".cursor/skills", ".claude/skills", ".qwen/skills"];
    for (const base of skillBases) put(join(ctx.home, base, "personal-coding-agent/SKILL.md"), "Foreign notes");
    const routerPath = join(root, "router.json");
    if (problem === "missing") rmSync(routerPath); else put(routerPath, "{malformed");
    cli.mockClear();
    expect(run(["uninstall", ...harnesses], ctx)).toBe(0);
    expect((parseToml(readFileSync(tomlPath, "utf8")).mcp_servers as Record<string, unknown>)).toEqual({ foreign });
    for (const path of [".cursor/mcp.json", ".claude.json", ".qwen/settings.json"]) {
      expect(JSON.parse(readFileSync(join(ctx.home, path), "utf8")).mcpServers).toEqual({ foreign });
    }
    for (const base of skillBases) {
      expect(existsSync(join(ctx.home, base, `${id}-coding-agent`))).toBe(false);
      expect(readFileSync(join(ctx.home, base, "personal-coding-agent/SKILL.md"), "utf8")).toBe("Foreign notes");
    }
    const cursorHooks = JSON.parse(readFileSync(join(ctx.home, ".cursor/hooks.json"), "utf8"));
    expect(JSON.stringify(cursorHooks)).not.toContain("cursor-hook.js");
    expect(cli.mock.calls.filter(([args]) => args[0] === "mcp" && args[1] === "remove")).toHaveLength(2);
    expect(cli.mock.calls.every(([args]) => args.includes(id) && !args.includes("foreign"))).toBe(true);
    expect(process.env.HINDSIGHT_ROUTER_CONFIG).toBe(routerPath);
  },
);
it.each(["missing", "malformed"])("keeps install/update strict and local stats available with %s operator config", problem => {
  provision("abc_");
  expect(run(["install", "cursor-cli"], ctx)).toBe(0);
  const hostPath = join(ctx.home, ".cursor/mcp.json");
  const before = readFileSync(hostPath, "utf8");
  const routerPath = join(root, "router.json");
  if (problem === "missing") rmSync(routerPath); else put(routerPath, "{malformed");
  expect(run(["install", "cursor-cli"], ctx)).toBe(1);
  expect(run(["update", "cursor-cli"], ctx)).toBe(1);
  const log = vi.fn();
  expect(run(["stats"], { ...ctx, log })).toBe(0);
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0][0]).toContain("Hindsight");
  expect(log.mock.calls[0][0]).not.toContain("abc");
  expect(readFileSync(hostPath, "utf8")).toBe(before);
});

it.each(["hindsight", "abc"])("uninstalls unmarked Grok owned registration %s without removing foreign tables", name => {
  provision("memory_");
  const path = join(ctx.home, ".grok/config.toml");
  const foreign = '[mcp_servers.foreign]\ncommand = "foreign"\nargs = ["other-server.js"]\n';
  const owned = `[mcp_servers.${name}]\ncommand = "node"\nargs = ${JSON.stringify([join(ctx.home, ".hindsight/coding-agents/dist/mcp-server.js")])}\nenv = { HINDSIGHT_MCP_HARNESS = "grok-build" }\n`;
  put(path, owned + "\n" + foreign);
  expect(run(["uninstall", "grok-build"], ctx)).toBe(0);
  const kept = readFileSync(path, "utf8");
  expect(kept).toContain(foreign);
  expect(Object.keys(parseToml(kept).mcp_servers as object)).toEqual(["foreign"]);
});

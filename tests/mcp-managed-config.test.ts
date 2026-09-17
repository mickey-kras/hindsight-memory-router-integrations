import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/shared/bank-access.js";
import { CredentialResolutionError, UnknownPrincipalError } from "../src/shared/principal-credential-resolver.js";
import { RouterUrlError } from "../src/shared/router-url.js";
import { loadMcpStack, MCP_DEFAULTS, scheduleQueueFlush, startupErrorMessage } from "../src/mcp/managed-config.js";

const TOKEN = `mr_agent-key_${"a".repeat(64)}`;
const logger = { warn: vi.fn(), error: vi.fn() };
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function configure(principal: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  dirs.push(dir);
  const path = join(dir, "router.json");
  writeFileSync(
    path,
    JSON.stringify({
      routerUrl: "https://router.example.test",
      principals: { agent: principal },
      ...config,
    }),
  );
  vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
  vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "agent");
  vi.stubEnv("TEST_AGENT_TOKEN", TOKEN);
  return { dir, path };
}

const validPrincipal = {
  tokenEnv: "TEST_AGENT_TOKEN",
  writeBank: "agent-bank",
  additionalReadBanks: ["shared-bank"],
};

describe("loadMcpStack", () => {
  it("loads the managed principal through tokenEnv indirection", () => {
    configure(validPrincipal);
    const stack = loadMcpStack(process.env, logger);
    expect(stack.principalId).toBe("agent");
    expect(stack.recallTimeoutMs).toBe(MCP_DEFAULTS.recallTimeoutMs);
    expect(stack.recallMaxTokens).toBe(MCP_DEFAULTS.recallMaxTokens);
    expect(stack.credentials.resolveReadBanks("agent")).toEqual(["agent-bank", "shared-bank"]);
  });

  it("never exposes the token on the resolved stack", () => {
    configure(validPrincipal);
    const stack = loadMcpStack(process.env, logger);
    expect(JSON.stringify(Object.keys(stack))).not.toContain("token");
  });

  it.each([
    ["missing config path", { HINDSIGHT_ROUTER_CONFIG: undefined, HINDSIGHT_ROUTER_PRINCIPAL: "agent" }],
    ["relative config path", { HINDSIGHT_ROUTER_CONFIG: "router.json", HINDSIGHT_ROUTER_PRINCIPAL: "agent" }],
    ["missing principal id", { HINDSIGHT_ROUTER_PRINCIPAL: undefined }],
    ["empty principal id", { HINDSIGHT_ROUTER_PRINCIPAL: "" }],
  ])("fails closed on %s", (_label, env) => {
    configure(validPrincipal);
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        vi.stubEnv(name, value);
      }
    }
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("fails closed when the config file is unreadable or not JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
    dirs.push(dir);
    const path = join(dir, "router.json");
    writeFileSync(path, "not json");
    vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
    vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "agent");
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
    vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", join(dir, "missing.json"));
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("fails closed on an unknown principal id", () => {
    configure(validPrincipal);
    vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "intruder");
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it.each(["token", "apiToken"])("rejects an inline %s in the principal entry", (key) => {
    configure({ ...validPrincipal, [key]: `mr_inline_${"b".repeat(64)}` });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it.each(["lowercase", "9STARTSWITHDIGIT", "HAS-DASH"])("rejects tokenEnv %s", (tokenEnv) => {
    configure({ ...validPrincipal, tokenEnv });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it.each([
    ["wildcard", "*"],
    ["dot-dot", ".."],
    ["dot", "."],
    ["empty", ""],
    ["too long", "b".repeat(129)],
  ])("rejects a %s write bank at config load", (_label, writeBank) => {
    configure({ ...validPrincipal, writeBank });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it.each([
    ["wildcard", ["*"]],
    ["dot-dot", [".."]],
    ["empty", [""]],
  ])("rejects %s additional read banks at config load", (_label, additionalReadBanks) => {
    configure({ ...validPrincipal, additionalReadBanks });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("rejects a non-array additionalReadBanks at startup", () => {
    configure({ ...validPrincipal, additionalReadBanks: "shared-bank" });
    expect(() => loadMcpStack(process.env, logger)).toThrow(CredentialResolutionError);
  });

  it("rejects a non-string write bank at startup", () => {
    configure({ ...validPrincipal, writeBank: 5 });
    expect(() => loadMcpStack(process.env, logger)).toThrow(CredentialResolutionError);
  });

  it("rejects a non-string tokenEnv", () => {
    configure({ ...validPrincipal, tokenEnv: 42 });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["non-string", 7],
  ])("rejects source %s", (_label, source) => {
    configure({ ...validPrincipal, source });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("carries a configured source for retain provenance", () => {
    configure({ ...validPrincipal, source: "my-product" });
    expect(loadMcpStack(process.env, logger).source).toBe("my-product");
  });

  it.each(["http://router.example.test", "https://user:pass@router.example.test", "not a url"])(
    "rejects routerUrl %s at startup",
    (routerUrl) => {
      configure(validPrincipal, {});
      const path = join(dirs[0], "router.json");
      writeFileSync(path, JSON.stringify({ routerUrl, principals: { agent: validPrincipal } }));
      expect(() => loadMcpStack(process.env, logger)).toThrow(RouterUrlError);
    },
  );

  it("rejects a missing token at startup", () => {
    configure(validPrincipal);
    delete process.env.TEST_AGENT_TOKEN;
    expect(() => loadMcpStack(process.env, logger)).toThrow(CredentialResolutionError);
  });

  it("rejects a malformed token at startup", () => {
    configure(validPrincipal);
    vi.stubEnv("TEST_AGENT_TOKEN", "not-a-router-token");
    expect(() => loadMcpStack(process.env, logger)).toThrow(CredentialResolutionError);
  });

  it.each([
    ["recallTimeoutMs", 0],
    ["recallTimeoutMs", 1.5],
    ["recallMaxTokens", -1],
    ["retainQueueFlushIntervalMs", 0],
  ])("rejects %s=%s at config load", (name, value) => {
    configure(validPrincipal, { [name]: value });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("applies configured recall budget and timeout", () => {
    configure(validPrincipal, { recallTimeoutMs: 4000, recallMaxTokens: 256 });
    const stack = loadMcpStack(process.env, logger);
    expect(stack.recallTimeoutMs).toBe(4000);
    expect(stack.recallMaxTokens).toBe(256);
  });

  it("rejects a relative queueDir", () => {
    configure(validPrincipal, { queueDir: "relative/queue" });
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("creates the configured queue directory", () => {
    const { dir } = configure(validPrincipal, {});
    const queueDir = join(dir, "queue", "nested");
    const path = join(dir, "router.json");
    writeFileSync(
      path,
      JSON.stringify({ routerUrl: "https://router.example.test", queueDir, principals: { agent: validPrincipal } }),
    );
    loadMcpStack(process.env, logger);
    expect(existsSync(queueDir)).toBe(true);
  });

  it("creates the default queue directory under the home directory", () => {
    const { dir } = configure(validPrincipal);
    vi.stubEnv("HOME", dir);
    loadMcpStack(process.env, logger);
    expect(existsSync(join(dir, ".hindsight-memory-router", "retain-queue"))).toBe(true);
  });

  it("loads a read-only principal without a write bank", () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", additionalReadBanks: ["shared-bank"] });
    const stack = loadMcpStack(process.env, logger);
    expect(stack.credentials.resolveOptionalWriteBank("agent")).toBeNull();
    expect(stack.credentials.resolveReadBanks("agent")).toEqual(["shared-bank"]);
  });

  it("rejects a principal with no route at all", () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN" });
    expect(() => loadMcpStack(process.env, logger)).toThrow(CredentialResolutionError);
  });

  it("rejects a principal id that violates the principal pattern", () => {
    configure(validPrincipal);
    vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "../agent");
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });
});

describe("startupErrorMessage", () => {
  it("keeps bounded router error messages", () => {
    expect(startupErrorMessage(new AccessDeniedError())).toBe("memory access denied");
    expect(startupErrorMessage(new UnknownPrincipalError("agent"))).toBe("no routing entry for agent");
    expect(startupErrorMessage(new CredentialResolutionError("missing-token"))).toBe(
      "credential resolution failed: missing-token",
    );
    expect(startupErrorMessage(new RouterUrlError("not-https"))).toBe("routerUrl rejected: not-https");
  });

  it("hides arbitrary internal errors behind a generic message", () => {
    expect(startupErrorMessage(new Error("token mr_agent-key leaked /etc/passwd"))).toBe("invalid configuration");
    expect(startupErrorMessage("string failure")).toBe("invalid configuration");
  });
});

describe("scheduleQueueFlush", () => {
  it("flushes immediately and on the configured interval until stopped", async () => {
    configure(validPrincipal, { retainQueueFlushIntervalMs: 1000 });
    const stack = loadMcpStack(process.env, logger);
    const flush = vi.spyOn(stack.retain, "flushQueues").mockResolvedValue(undefined);
    vi.useFakeTimers();
    const stop = scheduleQueueFlush(stack, process.env, logger);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(flush).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(flush).toHaveBeenCalledTimes(4);
  });

  it("logs a bounded message when a flush fails", async () => {
    configure(validPrincipal);
    const stack = loadMcpStack(process.env, logger);
    vi.spyOn(stack.retain, "flushQueues").mockRejectedValue(new Error("token mr_agent-key_secret"));
    vi.useFakeTimers();
    scheduleQueueFlush(stack, process.env, logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith("retain queue flush failed");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("mr_agent-key");
  });
});

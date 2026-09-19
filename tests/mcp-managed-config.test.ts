import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  vi.clearAllMocks();
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

  it("forwards structured audit records to the host logger as single-line JSON", () => {
    configure(validPrincipal);
    const stack = loadMcpStack(process.env, logger);
    stack.audit({ principal: "agent", op: "memory_router_recall", outcome: "success", bankId: "agent-bank" });
    const line = logger.warn.mock.calls.map(([message]) => message as string).find((m) => m.includes('"op"'));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(JSON.parse(line as string)).toMatchObject({
      principal: "agent",
      op: "memory_router_recall",
      outcome: "success",
      bankId: "agent-bank",
    });
  });

  it("prefers the info channel for audit records when the host logger provides one", () => {
    configure(validPrincipal);
    const infoLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const stack = loadMcpStack(process.env, infoLogger);
    infoLogger.warn.mockClear();
    stack.audit({ principal: "agent", op: "memory_router_retain", outcome: "success", bankId: "agent-bank" });
    expect(infoLogger.info).toHaveBeenCalledOnce();
    expect(infoLogger.warn).not.toHaveBeenCalled();
    expect(JSON.parse(infoLogger.info.mock.calls[0][0] as string)).toMatchObject({
      principal: "agent",
      op: "memory_router_retain",
      outcome: "success",
    });
  });

  it("never propagates a throwing audit sink", () => {
    configure(validPrincipal);
    const infoLogger = {
      info: vi.fn(() => {
        throw new Error("sink down");
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const stack = loadMcpStack(process.env, infoLogger);
    expect(() =>
      stack.audit({ principal: "agent", op: "memory_router_retain", outcome: "success" }),
    ).not.toThrow();
  });

  it.each([
    ["missing principal id", undefined],
    ["empty principal id", ""],
  ])("fails closed on %s from the environment", (_label, principalId) => {
    configure(validPrincipal);
    if (principalId === undefined) {
      delete process.env.HINDSIGHT_ROUTER_PRINCIPAL;
    } else {
      vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", principalId);
    }
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("rejects a principal id that violates the principal pattern", () => {
    configure(validPrincipal);
    vi.stubEnv("HINDSIGHT_ROUTER_PRINCIPAL", "../agent");
    expect(() => loadMcpStack(process.env, logger)).toThrow(AccessDeniedError);
  });

  it("rejects a non-string write bank at startup", () => {
    configure({ ...validPrincipal, writeBank: 5 });
    expect(() => loadMcpStack(process.env, logger)).toThrow(CredentialResolutionError);
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

  it("applies configured recall budget and timeout", () => {
    configure(validPrincipal, { recallTimeoutMs: 4000, recallMaxTokens: 256 });
    const stack = loadMcpStack(process.env, logger);
    expect(stack.recallTimeoutMs).toBe(4000);
    expect(stack.recallMaxTokens).toBe(256);
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

  it("warns about plaintext retention by default and stays quiet with a bounded queueMaxAgeMs", () => {
    const { dir } = configure(validPrincipal);
    vi.stubEnv("HOME", dir);
    loadMcpStack(process.env, logger);
    const warning = logger.warn.mock.calls.flat().join("\n");
    expect(warning).toContain("plaintext transcripts with no expiration");
    expect(warning).toContain("set queueMaxAgeMs to bound retention");
    vi.clearAllMocks();
    configure(validPrincipal, { queueMaxAgeMs: 604800000 });
    loadMcpStack(process.env, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("surfaces queue abandonment as a stderr notice through the wired logger", async () => {
    const { dir } = configure(validPrincipal);
    vi.stubEnv("HOME", dir);
    const stack = loadMcpStack(process.env, logger);
    const queueDir = join(dir, ".hindsight-memory-router", "retain-queue");
    const queueFile = join(queueDir, "hindsight-retain-queue.agent.jsonl");
    writeFileSync(
      queueFile,
      `${JSON.stringify({
        id: "poison-1",
        bankId: "agent-bank",
        content: "poison transcript",
        documentId: "conversation",
        metadata: {},
        createdAt: new Date().toISOString(),
        replayAttempts: 4,
      })}\n`,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    await stack.retain.flushQueues();
    expect(logger.error).toHaveBeenCalledWith(
      "retain replay abandoned after 5 attempts for bank agent-bank; transcript dropped from the queue without delivery",
    );
    expect(() => readFileSync(queueFile, "utf8")).toThrow();
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

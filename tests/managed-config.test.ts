import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "../src/shared/bank-access.js";
import { loadManagedConfig } from "../src/shared/managed-config.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function configure(principal: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "managed-config-test-"));
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
  return { dir, path };
}

const validPrincipal = {
  tokenEnv: "TEST_AGENT_TOKEN",
  writeBank: "agent-bank",
  additionalReadBanks: ["shared-bank"],
};

describe("loadManagedConfig", () => {
  it("loads the requested principal and config", () => {
    configure(validPrincipal);
    const { config, principalId, principal } = loadManagedConfig(process.env, "agent");
    expect(principalId).toBe("agent");
    expect(principal.tokenEnv).toBe("TEST_AGENT_TOKEN");
    expect(config.routerUrl).toBe("https://router.example.test");
  });

  it.each([
    ["missing config path", undefined],
    ["relative config path", "router.json"],
  ])("fails closed on %s", (_label, path) => {
    configure(validPrincipal);
    if (path === undefined) {
      delete process.env.HINDSIGHT_ROUTER_CONFIG;
    } else {
      vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
    }
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it.each([undefined, "", "unknown", "__proto__", "constructor"])("fails closed on principal id %s", (principalId) => {
    configure(validPrincipal);
    expect(() => loadManagedConfig(process.env, principalId)).toThrow(AccessDeniedError);
  });

  it("fails closed when the config file is unreadable or not JSON", () => {
    const { dir, path } = configure(validPrincipal);
    writeFileSync(path, "not json");
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
    vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", join(dir, "missing.json"));
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it("fails closed when the config file has no principals map", () => {
    const dir = mkdtempSync(join(tmpdir(), "managed-config-test-"));
    dirs.push(dir);
    const path = join(dir, "router.json");
    writeFileSync(path, JSON.stringify({ routerUrl: "https://router.example.test" }));
    vi.stubEnv("HINDSIGHT_ROUTER_CONFIG", path);
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it.each(["token", "apiToken"])("rejects an inline %s in the principal entry", (key) => {
    configure({ ...validPrincipal, [key]: `mr_inline_${"b".repeat(64)}` });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it.each(["lowercase", "9STARTSWITHDIGIT", "HAS-DASH", 42])("rejects tokenEnv %s", (tokenEnv) => {
    configure({ ...validPrincipal, tokenEnv });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["non-string", 7],
  ])("rejects source %s", (_label, source) => {
    configure({ ...validPrincipal, source });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it.each([
    ["wildcard", "*"],
    ["dot-dot", ".."],
    ["dot", "."],
    ["empty", ""],
    ["whitespace", "   "],
    ["too long", "b".repeat(129)],
  ])("rejects a %s write bank", (_label, writeBank) => {
    configure({ ...validPrincipal, writeBank });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it.each([
    ["wildcard", ["*"]],
    ["dot-dot", [".."]],
    ["empty", [""]],
  ])("rejects %s additional read banks", (_label, additionalReadBanks) => {
    configure({ ...validPrincipal, additionalReadBanks });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it("rejects a non-array additionalReadBanks", () => {
    configure({ ...validPrincipal, additionalReadBanks: "shared-bank" });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it("defaults a missing additionalReadBanks to an empty list", () => {
    configure({ tokenEnv: "TEST_AGENT_TOKEN", writeBank: "agent-bank" });
    expect(loadManagedConfig(process.env, "agent").principal.additionalReadBanks).toEqual([]);
  });

  it.each([
    ["recallTimeoutMs", 0],
    ["recallTimeoutMs", 1.5],
    ["recallMaxTokens", -1],
    ["retainQueueFlushIntervalMs", 0],
    ["queueMaxItems", 0],
    ["queueMaxItems", 1.5],
    ["queueMaxBytes", -1],
    ["queueMaxBytes", "1000"],
    ["queueMaxAgeMs", 0],
    ["queueMaxAgeMs", -2],
    ["queueMaxAgeMs", 1.5],
    ["queueMaxAgeMs", "604800000"],
  ])("rejects %s=%s", (name, value) => {
    configure(validPrincipal, { [name]: value });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it("rejects a relative queueDir", () => {
    configure(validPrincipal, { queueDir: "relative/queue" });
    expect(() => loadManagedConfig(process.env, "agent")).toThrow(AccessDeniedError);
  });

  it("accepts valid optional principal and tuning fields", () => {
    configure(
      { ...validPrincipal, source: "my-product", mapPathToBank: { "/srv/app": "agent-bank" } },
      {
        recallTimeoutMs: 4000,
        recallMaxTokens: 256,
        retainQueueFlushIntervalMs: 1000,
        queueMaxAgeMs: 604800000,
        queueDir: "/tmp/queue",
      },
    );
    const { config, principal } = loadManagedConfig(process.env, "agent");
    expect(principal.source).toBe("my-product");
    expect(principal.mapPathToBank).toEqual({ "/srv/app": "agent-bank" });
    expect(config.recallTimeoutMs).toBe(4000);
    expect(config.recallMaxTokens).toBe(256);
    expect(config.queueMaxAgeMs).toBe(604800000);
  });

  it("accepts queueMaxAgeMs -1 to keep queued retains without expiration", () => {
    configure(validPrincipal, { queueMaxAgeMs: -1 });
    expect(loadManagedConfig(process.env, "agent").config.queueMaxAgeMs).toBe(-1);
  });
});

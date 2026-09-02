import { describe, expect, it } from "vitest";

import {
  AgentCredentialResolver,
  CredentialResolutionError,
  UnknownAgentError,
  TOKEN_FORMAT_PATTERN,
} from "../src/router/agent-credential-resolver.js";

const TOKEN_A = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_B = `mr_backend-key_${"b".repeat(64)}`;

function resolver() {
  return new AgentCredentialResolver({
    routerUrl: "https://router.example.test",
    agents: {
      main: { token: TOKEN_A, writeBank: "main", recallBanks: ["main", "dev", "creative"] },
      backend: { token: TOKEN_B, writeBank: "dev", recallBanks: ["dev", "dev-best-practices"] },
    },
  });
}

describe("AgentCredentialResolver", () => {
  it("selects credentials by trusted agentId", () => {
    const r = resolver();
    expect(r.resolve("main")).toEqual({ agentId: "main", token: TOKEN_A });
    expect(r.resolve("backend")).toEqual({ agentId: "backend", token: TOKEN_B });
  });

  it("fails closed for unknown agents", () => {
    const r = resolver();
    expect(() => r.resolve("creative")).toThrow(UnknownAgentError);
    expect(() => r.resolve("main2")).toThrow(UnknownAgentError);
  });

  it("fails closed for missing agentId", () => {
    const r = resolver();
    expect(() => r.resolve(undefined)).toThrow(UnknownAgentError);
    expect(() => r.resolve("")).toThrow(UnknownAgentError);
  });

  it("has no global fallback token", () => {
    const r = new AgentCredentialResolver({ routerUrl: "https://router.example.test" });
    expect(() => r.resolve("main")).toThrow(UnknownAgentError);
    // A config-level fallback token field is not honored even if present.
    const withFallback = new AgentCredentialResolver({
      routerUrl: "https://router.example.test",
      agents: { main: { token: TOKEN_A, writeBank: "main" } },
      // @ts-expect-error deliberately smuggled legacy global token
      token: TOKEN_B,
    });
    expect(() => withFallback.resolve("backend")).toThrow(UnknownAgentError);
    expect(withFallback.resolve("main").token).toBe(TOKEN_A);
  });

  it("fails closed when a SecretRef arrives unresolved", () => {
    const r = new AgentCredentialResolver({
      agents: {
        main: {
          token: { source: "exec", provider: "op", id: "memory-router-main" },
          writeBank: "main",
        },
      },
    });
    expect(() => r.resolve("main")).toThrow(CredentialResolutionError);
    expect(() => r.resolve("main")).toThrow("unresolved-secret-ref");
  });

  it("rejects malformed token strings", () => {
    const r = new AgentCredentialResolver({
      agents: { main: { token: "not-a-router-token", writeBank: "main" } },
    });
    expect(() => r.resolve("main")).toThrow(CredentialResolutionError);
  });

  it("accepts the spec token format mr_<key-id>_<64-hex>", () => {
    expect(TOKEN_FORMAT_PATTERN.test(TOKEN_A)).toBe(true);
    expect(TOKEN_FORMAT_PATTERN.test(`mr_k_${"0".repeat(63)}`)).toBe(false);
    expect(TOKEN_FORMAT_PATTERN.test(`mr_k_${"a".repeat(64).toUpperCase()}`)).toBe(false);
  });

  it("resolves the configured write bank and recall banks", () => {
    const r = resolver();
    expect(r.resolveWriteBank("main")).toBe("main");
    expect(r.resolveWriteBank("backend")).toBe("dev");
    expect(r.resolveRecallBanks("main")).toEqual(["main", "dev", "creative"]);
    expect(r.resolveRecallBanks("backend")).toEqual(["dev", "dev-best-practices"]);
  });

  it("deduplicates recall banks and fails closed on malformed banks", () => {
    const r = new AgentCredentialResolver({
      agents: {
        main: { token: TOKEN_A, writeBank: "main", recallBanks: ["main", "main", "dev"] },
        broken: { token: TOKEN_B, writeBank: "../escape", recallBanks: [] },
      },
    });
    expect(r.resolveRecallBanks("main")).toEqual(["main", "dev"]);
    expect(() => r.resolveWriteBank("broken")).toThrow(CredentialResolutionError);
  });
});

import { describe, expect, it } from "vitest";

import {
  PrincipalCredentialResolver,
  CredentialResolutionError,
  UnknownPrincipalError,
  TOKEN_FORMAT_PATTERN,
} from "../src/shared/principal-credential-resolver.js";

const TOKEN_A = `mr_main-key_${"a".repeat(64)}`;
const TOKEN_B = `mr_backend-key_${"b".repeat(64)}`;

function resolver() {
  return new PrincipalCredentialResolver({
    routerUrl: "https://router.example.test",
    principals: {
      main: { token: TOKEN_A, writeBank: "main", additionalReadBanks: ["main", "dev", "creative"] },
      backend: { token: TOKEN_B, writeBank: "dev", additionalReadBanks: ["dev", "dev-best-practices"] },
    },
  });
}

describe("PrincipalCredentialResolver", () => {
  it("selects credentials by trusted agentId", () => {
    const r = resolver();
    expect(r.resolve("main")).toMatchObject({ principalId: "main", token: TOKEN_A });
    expect(r.resolve("backend")).toMatchObject({ principalId: "backend", token: TOKEN_B });
  });

  it("fails closed for unknown agents", () => {
    const r = resolver();
    expect(() => r.resolve("creative")).toThrow(UnknownPrincipalError);
    expect(() => r.resolve("main2")).toThrow(UnknownPrincipalError);
  });

  it("fails closed for missing agentId", () => {
    const r = resolver();
    expect(() => r.resolve(undefined)).toThrow(UnknownPrincipalError);
    expect(() => r.resolve("")).toThrow(UnknownPrincipalError);
  });

  it("has no global fallback token", () => {
    const r = new PrincipalCredentialResolver({ routerUrl: "https://router.example.test" });
    expect(() => r.resolve("main")).toThrow(UnknownPrincipalError);
    // A config-level fallback token field is not honored even if present.
    const withFallback = new PrincipalCredentialResolver({
      routerUrl: "https://router.example.test",
      principals: { main: { token: TOKEN_A, writeBank: "main" } },
      // @ts-expect-error deliberately smuggled legacy global token
      token: TOKEN_B,
    });
    expect(() => withFallback.resolve("backend")).toThrow(UnknownPrincipalError);
    expect(withFallback.resolve("main").token).toBe(TOKEN_A);
  });

  it("fails closed when a SecretRef arrives unresolved", () => {
    const r = new PrincipalCredentialResolver({
      principals: {
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
    const r = new PrincipalCredentialResolver({
      principals: { main: { token: "not-a-router-token", writeBank: "main" } },
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
    expect(r.resolveReadBanks("main")).toEqual(["main", "dev", "creative"]);
    expect(r.resolveReadBanks("backend")).toEqual(["dev", "dev-best-practices"]);
  });

  it("supports read-only agents without a write bank", () => {
    const r = new PrincipalCredentialResolver({
      principals: { reader: { token: TOKEN_A, additionalReadBanks: ["main"] } },
    });
    r.validateConfiguredPrincipals();
    expect(r.resolveOptionalWriteBank("reader")).toBeNull();
    expect(() => r.resolveWriteBank("reader")).toThrow("missing-write-bank");
  });

  it("deduplicates recall banks and fails closed on malformed banks", () => {
    const r = new PrincipalCredentialResolver({
      principals: {
        main: { token: TOKEN_A, writeBank: "main", additionalReadBanks: ["main", "main", "dev"] },
        broken: { token: TOKEN_B, writeBank: "../escape", additionalReadBanks: [] },
      },
    });
    expect(r.resolveReadBanks("main")).toEqual(["main", "dev"]);
    expect(() => r.resolveWriteBank("broken")).toThrow(CredentialResolutionError);
  });
});

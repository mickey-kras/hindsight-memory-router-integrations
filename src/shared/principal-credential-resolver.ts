import { visibleBanks, type BankAccess } from "./bank-access.js";
/** Maps trusted runtime agent IDs to tokens and routes. No fallback identity. */

export interface PrincipalConfig {
  /** Resolved bearer token string (SecretRef already resolved by runtime). */
  token?: unknown;
  /** The agent's single default write bank. */
  writeBank?: unknown;
  /** Additional read-only banks. */
  additionalReadBanks?: unknown;
}

export interface RouterPluginConfig {
  /** Memory Router base URL. Must be https, no userinfo. */
  routerUrl?: unknown;
  /** Per-agent routing entries keyed by agent ID. */
  principals?: Record<string, PrincipalConfig>;
  /** Shared recall timeout across all banks (ms). */
  recallTimeoutMs?: number;
  /** Shared recall context token budget across all banks. */
  recallMaxTokens?: number;
  /** Directory for per-agent retain queue files. */
  queueDir?: string;
}

export interface PrincipalCredentials {
  readonly principalId: string;
  readonly token: string;
  readonly access?: BankAccess;
}

export class UnknownPrincipalError extends Error {
  readonly principalId: string | undefined;
  constructor(principalId: string | undefined) {
    super(principalId ? "no routing entry for agent" : "missing trusted agent identity");
    this.name = "UnknownPrincipalError";
    this.principalId = principalId;
  }
}

export class CredentialResolutionError extends Error {
  constructor(
    reason:
      | "missing-token"
      | "unresolved-secret-ref"
      | "invalid-token"
      | "missing-write-bank"
      | "invalid-bank"
      | "missing-route"
  ) {
    super(`credential resolution failed: ${reason}`);
    this.name = "CredentialResolutionError";
  }
}

export const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const TOKEN_FORMAT_PATTERN = /^mr_[A-Za-z0-9._-]{1,64}_[0-9a-f]{64}$/;
export const BANK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A SecretRef that runtime did not resolve arrives as an object. Tokens must
 * be plain strings by the time they reach this layer; anything else fails
 * closed so a SecretRef descriptor is never mistaken for a credential.
 */
function isUnresolvedSecretRef(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export class PrincipalCredentialResolver {
  private readonly principals: Readonly<Record<string, PrincipalConfig>>;

  constructor(config: RouterPluginConfig) {
    this.principals = config.principals ?? {};
  }

  /** Validate configured routes at startup; unresolved secrets fail closed. */
  validateConfiguredPrincipals(): void {
    const principalIds = Object.keys(this.principals);
    if (principalIds.length === 0) {
      throw new UnknownPrincipalError(undefined);
    }
    for (const principalId of principalIds) {
      this.resolve(principalId);
      const writeBank = this.resolveOptionalWriteBank(principalId);
      const recallBanks = this.resolveReadBanks(principalId);
      if (writeBank === null && recallBanks.length === 0) {
        throw new CredentialResolutionError("missing-route");
      }
    }
  }

  /** Whether a routing entry exists for this agent ID. */
  has(principalId: string): boolean {
    return Object.hasOwn(this.principals, principalId);
  }

  /**
   * Resolve credentials for a trusted agent ID.
   * Throws UnknownPrincipalError / CredentialResolutionError; never returns null.
   */
  resolve(principalId: string | undefined): PrincipalCredentials {
    if (!principalId || !PRINCIPAL_ID_PATTERN.test(principalId) || principalId === "." || principalId === "..") {
      throw new UnknownPrincipalError(principalId);
    }
    const entry = this.principals[principalId];
    if (!Object.hasOwn(this.principals, principalId) || !entry) {
      throw new UnknownPrincipalError(principalId);
    }
    const token = entry.token;
    if (token === undefined || token === null || token === "") {
      throw new CredentialResolutionError("missing-token");
    }
    if (isUnresolvedSecretRef(token)) {
      throw new CredentialResolutionError("unresolved-secret-ref");
    }
    if (typeof token !== "string" || !TOKEN_FORMAT_PATTERN.test(token)) {
      throw new CredentialResolutionError("invalid-token");
    }
    const access = { writeBank: this.resolveOptionalWriteBank(principalId) ?? undefined, additionalReadBanks: this.resolveReadBanks(principalId) };
    visibleBanks(access);
    return Object.defineProperty({ principalId, access, token }, "token", { value: token, enumerable: false });
  }

  /** Resolve the agent's single default write bank. */
  resolveWriteBank(principalId: string): string {
    const bank = this.resolveOptionalWriteBank(principalId);
    if (bank === null) {
      throw new CredentialResolutionError("missing-write-bank");
    }
    return bank;
  }

  /** Resolve an optional write bank. Null is valid for read-only principals. */
  resolveOptionalWriteBank(principalId: string): string | null {
    const entry = this.requireEntry(principalId);
    const bank = entry.writeBank;
    if (bank === undefined || bank === null || bank === "") {
      return null;
    }
    if (typeof bank !== "string" || !BANK_ID_PATTERN.test(bank) || bank === "." || bank === "..") {
      throw new CredentialResolutionError("invalid-bank");
    }
    return bank;
  }

  /** Resolve the agent's recall banks (deduplicated, configured order). */
  resolveReadBanks(principalId: string): string[] {
    const entry = this.requireEntry(principalId);
    const raw = entry.additionalReadBanks;
    if (raw === undefined || raw === null) {
      const write = this.resolveOptionalWriteBank(principalId);
      return write ? [write] : [];
    }
    if (!Array.isArray(raw)) {
      throw new CredentialResolutionError("invalid-bank");
    }
    const write = this.resolveOptionalWriteBank(principalId);
    const banks: string[] = [];
    for (const value of raw) {
      if (typeof value !== "string" || !BANK_ID_PATTERN.test(value) || value === "." || value === "..") {
        throw new CredentialResolutionError("invalid-bank");
      }
      if (!banks.includes(value)) {
        banks.push(value);
      }
    }
    return visibleBanks({ writeBank: write ?? undefined, additionalReadBanks: banks });
  }

  private requireEntry(principalId: string): PrincipalConfig {
    if (!principalId || !PRINCIPAL_ID_PATTERN.test(principalId) || principalId === "." || principalId === "..") {
      throw new UnknownPrincipalError(principalId);
    }
    const entry = this.principals[principalId];
    if (!Object.hasOwn(this.principals, principalId) || !entry) {
      throw new UnknownPrincipalError(principalId);
    }
    return entry;
  }
}

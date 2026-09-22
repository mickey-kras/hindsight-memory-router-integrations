import { type BankAccess, visibleBanks } from "./bank-access.js";
import { BANK_ID_PATTERN, PRINCIPAL_ID_PATTERN, TOKEN_FORMAT_PATTERN } from "./patterns.js";

export interface PrincipalConfig {
  token?: unknown;
  writeBank?: unknown;
  additionalReadBanks?: unknown;
}

export interface RouterPluginConfig {
  routerUrl?: unknown;
  principals?: Record<string, PrincipalConfig>;
  recallTimeoutMs?: number;
  recallMaxTokens?: number;
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
      | "missing-route",
  ) {
    super(`credential resolution failed: ${reason}`);
    this.name = "CredentialResolutionError";
  }
}

export {
  BANK_ID_PATTERN,
  PRINCIPAL_ID_PATTERN,
  TOKEN_FORMAT_PATTERN,
} from "./patterns.js";

// Unresolved SecretRef objects must never be mistaken for credentials.
function isUnresolvedSecretRef(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export class PrincipalCredentialResolver {
  private readonly principals: Readonly<Record<string, PrincipalConfig>>;

  constructor(config: RouterPluginConfig) {
    this.principals = config.principals ?? {};
  }

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

  has(principalId: string): boolean {
    return Object.hasOwn(this.principals, principalId);
  }

  resolve(principalId: string | undefined): PrincipalCredentials {
    if (!principalId || !PRINCIPAL_ID_PATTERN.test(principalId) || principalId === "." || principalId === "..") {
      throw new UnknownPrincipalError(principalId);
    }
    if (!Object.hasOwn(this.principals, principalId)) {
      throw new UnknownPrincipalError(principalId);
    }
    const entry = this.principals[principalId];
    if (!entry) {
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
    const access = {
      writeBank: this.resolveOptionalWriteBank(principalId) ?? undefined,
      additionalReadBanks: this.resolveReadBanks(principalId),
    };
    visibleBanks(access);
    return Object.defineProperty({ principalId, access, token }, "token", {
      value: token,
      enumerable: false,
    });
  }

  resolveWriteBank(principalId: string): string {
    const bank = this.resolveOptionalWriteBank(principalId);
    if (bank === null) {
      throw new CredentialResolutionError("missing-write-bank");
    }
    return bank;
  }

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
    return visibleBanks({
      writeBank: write ?? undefined,
      additionalReadBanks: banks,
    });
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

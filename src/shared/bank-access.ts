import { BANK_ID_PATTERN } from "./principal-credential-resolver.js";

export interface BankAccess {
  readonly writeBank?: string;
  readonly additionalReadBanks: readonly string[];
}

export class AccessDeniedError extends Error {
  readonly statusCode = 403;
  constructor() {
    super("memory access denied");
    this.name = "AccessDeniedError";
  }
}

export function visibleBanks(access: BankAccess): string[] {
  const banks = [...new Set([...(access.writeBank ? [access.writeBank] : []), ...access.additionalReadBanks])];
  if (banks.some(bank => !BANK_ID_PATTERN.test(bank) || bank === "." || bank === "..")) {
    throw new AccessDeniedError();
  }
  return banks;
}

export function requireBank(access: BankAccess, bank: string, operation: "read" | "write"): void {
  if (!visibleBanks(access).includes(bank) || (operation === "write" && access.writeBank !== bank)) {
    throw new AccessDeniedError();
  }
}

/** Unknown operations are denied; POST does not by itself imply mutation. */
export function classifyOperation(method: string, suffix: string): "read" | "write" {
  if (method === "POST" && ["/memories/recall", "/reflect"].includes(suffix)) return "read";
  if (method === "GET" && /^\/(?:config|stats|tags|graph|documents|operations|memories|mental-models|knowledge-base)(?:\/[^/]+)*$/.test(suffix)) return "read";
  if (method === "GET" && suffix === "") return "read";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && /^(?:\/(?:config|import|memories|documents|mental-models|knowledge-base|consolidate|consolidation)(?:\/[^/]+)*)?$/.test(suffix)) return "write";
  throw new AccessDeniedError();
}

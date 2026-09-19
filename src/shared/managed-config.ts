import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { AccessDeniedError, type BankAccess, visibleBanks } from "./bank-access.js";

export interface ManagedPrincipal extends BankAccess {
  tokenEnv: string;
  source?: string;
  mapPathToBank?: Record<string, string>;
}

export interface ManagedRouterConfig {
  routerUrl: string;
  recallTimeoutMs?: number;
  recallMaxTokens?: number;
  retainQueueFlushIntervalMs?: number;
  queueDir?: string;
  principals: Record<string, ManagedPrincipal>;
}

const TOKEN_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function loadManagedConfig(
  env: NodeJS.ProcessEnv,
  principalId: string | undefined,
): {
  config: ManagedRouterConfig;
  principalId: string;
  principal: ManagedPrincipal;
} {
  try {
    const path = env.HINDSIGHT_ROUTER_CONFIG;
    if (!path || !isAbsolute(path) || !principalId) throw new AccessDeniedError();
    const config = JSON.parse(readFileSync(path, "utf8")) as ManagedRouterConfig;
    if (!Object.hasOwn(config.principals ?? {}, principalId)) throw new AccessDeniedError();
    const principal = config.principals[principalId];
    if (!TOKEN_ENV_PATTERN.test(principal.tokenEnv) || "token" in principal || "apiToken" in principal) {
      throw new AccessDeniedError();
    }
    if (principal.source !== undefined && (typeof principal.source !== "string" || principal.source.trim() === "")) {
      throw new AccessDeniedError();
    }
    if (typeof principal.writeBank === "string" && principal.writeBank.trim() === "") {
      throw new AccessDeniedError();
    }
    visibleBanks({ writeBank: principal.writeBank, additionalReadBanks: principal.additionalReadBanks ?? [] });
    for (const value of [config.recallTimeoutMs, config.recallMaxTokens, config.retainQueueFlushIntervalMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new AccessDeniedError();
    }
    if (config.queueDir !== undefined && (typeof config.queueDir !== "string" || !isAbsolute(config.queueDir))) {
      throw new AccessDeniedError();
    }
    return { config, principalId, principal };
  } catch {
    throw new AccessDeniedError();
  }
}

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
  queueMaxAgeMs?: number;
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
    const configured = config.principals[principalId];
    if (!TOKEN_ENV_PATTERN.test(configured.tokenEnv) || "token" in configured || "apiToken" in configured) {
      throw new AccessDeniedError();
    }
    if (configured.source !== undefined && (typeof configured.source !== "string" || configured.source.trim() === "")) {
      throw new AccessDeniedError();
    }
    if (typeof configured.writeBank === "string" && configured.writeBank.trim() === "") {
      throw new AccessDeniedError();
    }
    if (configured.additionalReadBanks !== undefined && !Array.isArray(configured.additionalReadBanks)) {
      throw new AccessDeniedError();
    }
    const principal: ManagedPrincipal = { ...configured, additionalReadBanks: configured.additionalReadBanks ?? [] };
    visibleBanks(principal);
    for (const value of [config.recallTimeoutMs, config.recallMaxTokens, config.retainQueueFlushIntervalMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new AccessDeniedError();
    }
    if (
      config.queueMaxAgeMs !== undefined &&
      (!Number.isSafeInteger(config.queueMaxAgeMs) || (config.queueMaxAgeMs !== -1 && config.queueMaxAgeMs <= 0))
    ) {
      throw new AccessDeniedError();
    }
    if (config.queueDir !== undefined && (typeof config.queueDir !== "string" || !isAbsolute(config.queueDir))) {
      throw new AccessDeniedError();
    }
    return { config, principalId, principal };
  } catch {
    throw new AccessDeniedError();
  }
}

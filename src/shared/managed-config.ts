import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { AccessDeniedError, type BankAccess, visibleBanks } from "./bank-access.js";
import { validatedToolPrefix } from "./tool-prefix.js";

export interface ManagedPrincipal extends BankAccess {
  tokenEnv?: string;
  human?: { credentialRef: string };
  source?: string;
  mapPathToBank?: Record<string, string>;
}

export interface ManagedRouterConfig {
  routerUrl: string;
  toolPrefix?: string;
  // Legacy compatibility inputs: validated but unused by coding-agent runtime.
  // Configure retrieval through normal coding-agent config; OpenClaw has its own schema.
  recallTimeoutMs?: number;
  recallMaxTokens?: number;
  retainQueueFlushIntervalMs?: number;
  queueMaxAgeMs?: number;
  queueMaxItems?: number;
  queueMaxBytes?: number;
  queueDir?: string;
  principals: Record<string, ManagedPrincipal>;
}

const TOKEN_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function validatedPrincipal(configured: ManagedPrincipal): ManagedPrincipal {
  const human = configured.human;
  if (
    (human === undefined
      ? typeof configured.tokenEnv !== "string" || !TOKEN_ENV_PATTERN.test(configured.tokenEnv)
      : typeof human !== "object" ||
        human === null ||
        Object.keys(human).length !== 1 ||
        typeof human.credentialRef !== "string" ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(human.credentialRef) ||
        Object.hasOwn(configured, "tokenEnv")) ||
    "token" in configured ||
    "apiToken" in configured
  ) {
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
  return principal;
}

function validatePositiveInteger(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new AccessDeniedError();
}

function validateQueueOptions(config: ManagedRouterConfig): void {
  for (const value of [
    config.recallTimeoutMs,
    config.recallMaxTokens,
    config.retainQueueFlushIntervalMs,
    config.queueMaxItems,
    config.queueMaxBytes,
  ]) {
    validatePositiveInteger(value);
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
}

export function loadValidatedManagedConfig(env: NodeJS.ProcessEnv): ManagedRouterConfig & { toolPrefix: string } {
  const path = env.HINDSIGHT_ROUTER_CONFIG;
  if (!path || !isAbsolute(path)) throw new AccessDeniedError();
  const config = JSON.parse(readFileSync(path, "utf8")) as ManagedRouterConfig;
  const toolPrefix = validatedToolPrefix(config.toolPrefix);
  validateQueueOptions(config);
  return { ...config, toolPrefix };
}

export function loadManagedConfig(
  env: NodeJS.ProcessEnv,
  principalId: string | undefined,
): {
  config: ManagedRouterConfig & { toolPrefix: string };
  principalId: string;
  principal: ManagedPrincipal;
} {
  try {
    if (!principalId) throw new AccessDeniedError();
    const config = loadValidatedManagedConfig(env);
    if (!Object.hasOwn(config.principals ?? {}, principalId)) throw new AccessDeniedError();
    const principal = validatedPrincipal(config.principals[principalId]);
    validateQueueOptions(config);
    return { config, principalId, principal };
  } catch {
    throw new AccessDeniedError();
  }
}

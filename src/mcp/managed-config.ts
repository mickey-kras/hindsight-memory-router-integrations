import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AuthenticatedClientFactory } from "../shared/authenticated-client-factory.js";
import { AccessDeniedError, type BankAccess, visibleBanks } from "../shared/bank-access.js";
import { PACKAGE_VERSION } from "../shared/package-version.js";
import {
  CredentialResolutionError,
  PrincipalCredentialResolver,
  UnknownPrincipalError,
} from "../shared/principal-credential-resolver.js";
import { RecallCoordinator } from "../shared/recall-coordinator.js";
import { type CoordinatorLogger, RetainCoordinator } from "../shared/retain-coordinator.js";
import { RouterUrlError } from "../shared/router-url.js";

interface ManagedPrincipal extends BankAccess {
  tokenEnv: string;
  source?: string;
}

interface ManagedConfig {
  routerUrl: string;
  recallTimeoutMs?: number;
  recallMaxTokens?: number;
  retainQueueFlushIntervalMs?: number;
  queueDir?: string;
  principals: Record<string, ManagedPrincipal>;
}

export interface McpStack {
  principalId: string;
  source?: string;
  recallTimeoutMs: number;
  recallMaxTokens: number;
  credentials: PrincipalCredentialResolver;
  clients: AuthenticatedClientFactory;
  recall: RecallCoordinator;
  retain: RetainCoordinator;
}

export const MCP_DEFAULTS = Object.freeze({
  recallTimeoutMs: 15000,
  recallMaxTokens: 4096,
  retainQueueFlushIntervalMs: 30000,
});

const TOKEN_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function managed(env: NodeJS.ProcessEnv): {
  config: ManagedConfig;
  principalId: string;
  principal: ManagedPrincipal;
} {
  try {
    const path = env.HINDSIGHT_ROUTER_CONFIG;
    const principalId = env.HINDSIGHT_ROUTER_PRINCIPAL;
    if (!path || !isAbsolute(path) || !principalId) throw new AccessDeniedError();
    const config = JSON.parse(readFileSync(path, "utf8")) as ManagedConfig;
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

export function loadMcpStack(env: NodeJS.ProcessEnv, logger: CoordinatorLogger): McpStack {
  const { config, principalId, principal } = managed(env);
  const credentials = new PrincipalCredentialResolver({
    routerUrl: config.routerUrl,
    principals: {
      [principalId]: {
        token: env[principal.tokenEnv],
        writeBank: principal.writeBank,
        additionalReadBanks: principal.additionalReadBanks,
      },
    },
  });
  credentials.validateConfiguredPrincipals();
  const clients = new AuthenticatedClientFactory({
    routerUrl: config.routerUrl,
    userAgent: `hindsight-memory-router-mcp/${PACKAGE_VERSION}`,
  });
  const queueDir = config.queueDir ?? join(homedir(), ".hindsight-memory-router", "retain-queue");
  mkdirSync(queueDir, { recursive: true, mode: 0o700 });
  return {
    principalId,
    source: principal.source,
    recallTimeoutMs: config.recallTimeoutMs ?? MCP_DEFAULTS.recallTimeoutMs,
    recallMaxTokens: config.recallMaxTokens ?? MCP_DEFAULTS.recallMaxTokens,
    credentials,
    clients,
    recall: new RecallCoordinator(),
    retain: new RetainCoordinator({ credentials, clients, queueDir, logger }),
  };
}

export function startupErrorMessage(error: unknown): string {
  if (
    error instanceof AccessDeniedError ||
    error instanceof UnknownPrincipalError ||
    error instanceof CredentialResolutionError ||
    error instanceof RouterUrlError
  ) {
    return (error as Error).message;
  }
  return "invalid configuration";
}

export function scheduleQueueFlush(stack: McpStack, env: NodeJS.ProcessEnv, logger: CoordinatorLogger): () => void {
  const { config } = managed(env);
  const interval = config.retainQueueFlushIntervalMs ?? MCP_DEFAULTS.retainQueueFlushIntervalMs;
  const flush = () =>
    void stack.retain.flushQueues().catch(() => {
      logger.error("retain queue flush failed");
    });
  const timer = setInterval(flush, interval);
  timer.unref?.();
  flush();
  return () => clearInterval(timer);
}

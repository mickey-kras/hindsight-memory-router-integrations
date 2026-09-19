import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthenticatedClientFactory } from "../shared/authenticated-client-factory.js";
import { AccessDeniedError } from "../shared/bank-access.js";
import { loadManagedConfig } from "../shared/managed-config.js";
import { PACKAGE_VERSION } from "../shared/package-version.js";
import {
  CredentialResolutionError,
  PrincipalCredentialResolver,
  UnknownPrincipalError,
} from "../shared/principal-credential-resolver.js";
import { RecallCoordinator } from "../shared/recall-coordinator.js";
import { type CoordinatorLogger, RetainCoordinator, retainAbandonNotice } from "../shared/retain-coordinator.js";
import { RouterUrlError } from "../shared/router-url.js";

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

export function loadMcpStack(env: NodeJS.ProcessEnv, logger: CoordinatorLogger): McpStack {
  const { config, principalId, principal } = loadManagedConfig(env, env.HINDSIGHT_ROUTER_PRINCIPAL);
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
    retain: new RetainCoordinator({
      credentials,
      clients,
      queueDir,
      logger,
      onAbandon: (item, attempts) => logger.error(retainAbandonNotice(item, attempts)),
    }),
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
  const { config } = loadManagedConfig(env, env.HINDSIGHT_ROUTER_PRINCIPAL);
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

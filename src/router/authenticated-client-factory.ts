/**
 * AuthenticatedClientFactory boundary.
 *
 * Builds one HindsightClient per agent, authenticated with that agent's own
 * Memory Router token and stamped with the `x-memory-router-agent` header.
 * Clients are cached per agent ID: isolation means no client ever carries
 * another agent's credentials, not that instances are never reused.
 *
 * Transport policy (enforced here, at the single construction point):
 * - routerUrl must be https: - no HTTP fallback, ever
 * - certificate verification is the undici default and is never disabled
 * - no credentials in the URL (userinfo rejected)
 * - redirects: the published client follows redirects; undici strips the
 *   Authorization header on cross-origin redirects (verified against Node 22),
 *   so a redirect can never leak a token to an unrelated origin
 */

import { HindsightClient } from "@vectorize-io/hindsight-client";

import type { AgentCredentials } from "./agent-credential-resolver.js";

export const AGENT_HEADER = "x-memory-router-agent";

export class RouterUrlError extends Error {
  constructor(reason: "missing" | "not-https" | "userinfo" | "invalid") {
    super(`routerUrl rejected: ${reason}`);
    this.name = "RouterUrlError";
  }
}

export function validateRouterUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RouterUrlError("missing");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RouterUrlError("invalid");
  }
  if (url.protocol !== "https:") {
    throw new RouterUrlError("not-https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RouterUrlError("userinfo");
  }
  return url.toString().replace(/\/$/, "");
}

/** The subset of HindsightClient the routing layer depends on. */
export interface RouterClient {
  retain(
    bankId: string,
    content: string,
    options?: {
      documentId?: string;
      context?: string;
      metadata?: Record<string, string>;
      tags?: string[];
      updateMode?: "replace" | "append";
      operationId?: string;
      async?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<unknown>;
  recall(
    bankId: string,
    query: string,
    options?: {
      maxTokens?: number;
      budget?: "low" | "mid" | "high";
      types?: string[];
      preferObservations?: boolean;
    }
  ): Promise<{ results?: unknown[] }>;
}

export type ClientConstructor = (options: {
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  headers: Record<string, string>;
}) => RouterClient;

export class AuthenticatedClientFactory {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly construct: ClientConstructor;
  private readonly cache = new Map<string, RouterClient>();

  constructor(options: {
    routerUrl: unknown;
    userAgent: string;
    /** Injection point for tests; production uses HindsightClient. */
    construct?: ClientConstructor;
  }) {
    this.baseUrl = validateRouterUrl(options.routerUrl);
    this.userAgent = options.userAgent;
    this.construct =
      options.construct ??
      ((clientOptions) => new HindsightClient(clientOptions) as unknown as RouterClient);
  }

  /** Client authenticated as this agent. Never shares credentials across agents. */
  forAgent(credentials: AgentCredentials): RouterClient {
    const existing = this.cache.get(credentials.agentId);
    if (existing) {
      return existing;
    }
    const client = this.construct({
      baseUrl: this.baseUrl,
      apiKey: credentials.token,
      userAgent: this.userAgent,
      headers: { [AGENT_HEADER]: credentials.agentId },
    });
    this.cache.set(credentials.agentId, client);
    return client;
  }
}

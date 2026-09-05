/** Creates one HTTPS Memory Router client per agent and active token. */

import { RouterTransport } from "./router-transport.js";
import { AccessDeniedError } from "./bank-access.js";

import type { PrincipalCredentials } from "./principal-credential-resolver.js";

export const AGENT_HEADER = "x-memory-router-agent";

export { RouterUrlError, validateRouterUrl } from "./router-url.js";
import { validateRouterUrl } from "./router-url.js";

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
      signal?: AbortSignal;
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
  private readonly construct?: ClientConstructor;
  private readonly cache = new Map<string, { token: string; client: RouterClient }>();

  constructor(options: {
    routerUrl: unknown;
    userAgent: string;
    /** Injection point for tests; production uses HindsightClient. */
    construct?: ClientConstructor;
  }) {
    this.baseUrl = validateRouterUrl(options.routerUrl);
    this.userAgent = options.userAgent;
    this.construct = options.construct;
  }

  /** Client authenticated as this agent. Never shares credentials across principals. */
  forAgent(credentials: PrincipalCredentials): RouterClient {
    const cached = this.cache.get(credentials.principalId);
    if (cached?.token === credentials.token) {
      return cached.client;
    }
    const client = this.construct ? this.construct({
      baseUrl: this.baseUrl,
      apiKey: credentials.token,
      userAgent: this.userAgent,
      headers: { [AGENT_HEADER]: credentials.principalId },
    }) : this.createClient(credentials);
    this.cache.set(credentials.principalId, { token: credentials.token, client });
    return client;
  }
  private createClient(credentials: PrincipalCredentials): RouterClient {
    if (!credentials.access) throw new AccessDeniedError();
    const transport = new RouterTransport({ routerUrl: this.baseUrl, access: credentials.access, principalId: credentials.principalId, token: () => credentials.token });
    return {
      async retain(bank, content, options) {
        const response = await transport.request(transport.bankUrl(bank, "/memories"), {
          method: "POST", signal: options?.signal,
          body: JSON.stringify({ items: [{ content, document_id: options?.documentId,
            context: options?.context, metadata: options?.metadata, tags: options?.tags,
            update_mode: options?.updateMode }], async: options?.async,
            operation_id: options?.operationId }),
        });
        if (!response.ok) throw new Error("memory retain unavailable");
        return response.json();
      },
      async recall(bank, query, options) {
        const response = await transport.request(transport.bankUrl(bank, "/memories/recall"), {
          method: "POST", signal: options?.signal,
          body: JSON.stringify({ query, max_tokens: options?.maxTokens, budget: options?.budget,
            types: options?.types, prefer_observations: options?.preferObservations }),
        });
        if (!response.ok) throw new Error("memory read unavailable");
        return response.json() as Promise<{ results?: unknown[] }>;
      },
    };
  }

}

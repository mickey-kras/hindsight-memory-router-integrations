/**
 * AgentCredentialResolver boundary.
 *
 * Maps a trusted OpenClaw `ctx.agentId` to that agent's Memory Router
 * credentials. This is the ONLY component allowed to turn an agent identity
 * into a token. Identity always comes from the OpenClaw runtime context;
 * never from prompts, model output, tool arguments, tags, or user content.
 *
 * Fail-closed rules:
 * - missing/unknown agentId -> UnknownAgentError
 * - missing token -> CredentialResolutionError
 * - token still an unresolved SecretRef object -> CredentialResolutionError
 * - no global fallback token exists anywhere in this layer
 */

export interface AgentConfig {
  /** Resolved bearer token string (SecretRef already resolved by OpenClaw). */
  token?: unknown;
  /** The agent's single default write bank. */
  writeBank?: unknown;
  /** Zero or more recall banks. */
  recallBanks?: unknown;
}

export interface RouterPluginConfig {
  /** Memory Router base URL. Must be https, no userinfo. */
  routerUrl?: unknown;
  /** Per-agent routing entries keyed by agent ID. */
  agents?: Record<string, AgentConfig>;
  /** Shared recall timeout across all banks (ms). */
  recallTimeoutMs?: number;
  /** Shared recall context token budget across all banks. */
  recallMaxTokens?: number;
  /** Directory for per-agent retain queue files. */
  queueDir?: string;
}

export interface AgentCredentials {
  readonly agentId: string;
  readonly token: string;
}

export class UnknownAgentError extends Error {
  readonly agentId: string | undefined;
  constructor(agentId: string | undefined) {
    super(agentId ? "no routing entry for agent" : "missing trusted agent identity");
    this.name = "UnknownAgentError";
    this.agentId = agentId;
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
  ) {
    super(`credential resolution failed: ${reason}`);
    this.name = "CredentialResolutionError";
  }
}

export const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const TOKEN_FORMAT_PATTERN = /^mr_[A-Za-z0-9._-]{1,64}_[0-9a-f]{64}$/;
export const BANK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * A SecretRef that OpenClaw did not resolve arrives as an object. Tokens must
 * be plain strings by the time they reach this layer; anything else fails
 * closed so a SecretRef descriptor is never mistaken for a credential.
 */
function isUnresolvedSecretRef(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export class AgentCredentialResolver {
  private readonly agents: Readonly<Record<string, AgentConfig>>;

  constructor(config: RouterPluginConfig) {
    this.agents = config.agents ?? {};
  }

  /** Whether a routing entry exists for this agent ID. */
  has(agentId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.agents, agentId);
  }

  /**
   * Resolve credentials for a trusted agent ID.
   * Throws UnknownAgentError / CredentialResolutionError; never returns null.
   */
  resolve(agentId: string | undefined): AgentCredentials {
    if (!agentId || !AGENT_ID_PATTERN.test(agentId) || agentId === "." || agentId === "..") {
      throw new UnknownAgentError(agentId);
    }
    const entry = this.agents[agentId];
    if (!entry) {
      throw new UnknownAgentError(agentId);
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
    return { agentId, token };
  }

  /** Resolve the agent's single default write bank. */
  resolveWriteBank(agentId: string): string {
    const entry = this.requireEntry(agentId);
    const bank = entry.writeBank;
    if (bank === undefined || bank === null || bank === "") {
      throw new CredentialResolutionError("missing-write-bank");
    }
    if (typeof bank !== "string" || !BANK_ID_PATTERN.test(bank) || bank === "." || bank === "..") {
      throw new CredentialResolutionError("invalid-bank");
    }
    return bank;
  }

  /** Resolve the agent's recall banks (deduplicated, configured order). */
  resolveRecallBanks(agentId: string): string[] {
    const entry = this.requireEntry(agentId);
    const raw = entry.recallBanks;
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw)) {
      throw new CredentialResolutionError("invalid-bank");
    }
    const banks: string[] = [];
    for (const value of raw) {
      if (typeof value !== "string" || !BANK_ID_PATTERN.test(value) || value === "." || value === "..") {
        throw new CredentialResolutionError("invalid-bank");
      }
      if (!banks.includes(value)) {
        banks.push(value);
      }
    }
    return banks;
  }

  private requireEntry(agentId: string): AgentConfig {
    if (!agentId || !AGENT_ID_PATTERN.test(agentId) || agentId === "." || agentId === "..") {
      throw new UnknownAgentError(agentId);
    }
    const entry = this.agents[agentId];
    if (!entry) {
      throw new UnknownAgentError(agentId);
    }
    return entry;
  }
}

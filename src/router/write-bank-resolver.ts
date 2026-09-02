/**
 * WriteBankResolver boundary.
 *
 * Decides the single default write bank for an agent, purely from
 * server-side-owned plugin configuration. There is no dynamic or
 * content-derived bank selection.
 */

import { AgentCredentialResolver } from "./agent-credential-resolver.js";

export class WriteBankResolver {
  private readonly credentials: AgentCredentialResolver;

  constructor(credentials: AgentCredentialResolver) {
    this.credentials = credentials;
  }

  /**
   * The agent's default write bank. Throws UnknownAgentError for unknown
   * agents and CredentialResolutionError when unconfigured (fail closed).
   */
  resolve(agentId: string): string {
    return this.credentials.resolveWriteBank(agentId);
  }
}

/**
 * RecallBankResolver boundary.
 *
 * Decides which banks an agent may recall from, purely from server-side-owned
 * plugin configuration. Recall banks are never derived from prompts, model
 * output, tool arguments, tags, or user content.
 */

import { AgentCredentialResolver } from "./agent-credential-resolver.js";

export class RecallBankResolver {
  private readonly credentials: AgentCredentialResolver;

  constructor(credentials: AgentCredentialResolver) {
    this.credentials = credentials;
  }

  /**
   * Configured recall banks for this agent, deduplicated, in configured order.
   * Empty list means the agent has no recall access and recall is skipped.
   * Throws UnknownAgentError for unknown agents (fail closed).
   */
  resolve(agentId: string): string[] {
    return this.credentials.resolveRecallBanks(agentId);
  }
}

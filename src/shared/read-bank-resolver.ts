/**
 * ReadBankResolver boundary.
 *
 * Decides which banks an agent may recall from, purely from server-side-owned
 * plugin configuration. Recall banks are never derived from prompts, model
 * output, tool arguments, tags, or user content.
 */

import { PrincipalCredentialResolver } from "./principal-credential-resolver.js";

export class ReadBankResolver {
  private readonly credentials: PrincipalCredentialResolver;

  constructor(credentials: PrincipalCredentialResolver) {
    this.credentials = credentials;
  }

  /**
   * Configured recall banks for this agent, deduplicated, in configured order.
   * Empty list means the agent has no recall access and recall is skipped.
   * Throws UnknownPrincipalError for unknown principals (fail closed).
   */
  resolve(principalId: string): string[] {
    return this.credentials.resolveReadBanks(principalId);
  }
}

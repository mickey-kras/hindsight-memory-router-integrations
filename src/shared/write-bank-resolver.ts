/**
 * WriteBankResolver boundary.
 *
 * Decides the single default write bank for an agent, purely from
 * server-side-owned plugin configuration. There is no dynamic or
 * content-derived bank selection.
 */

import { PrincipalCredentialResolver } from "./principal-credential-resolver.js";

export class WriteBankResolver {
  private readonly credentials: PrincipalCredentialResolver;

  constructor(credentials: PrincipalCredentialResolver) {
    this.credentials = credentials;
  }

  /**
   * The agent's default write bank. Throws UnknownPrincipalError for unknown
   * principals and CredentialResolutionError when unconfigured (fail closed).
   */
  resolve(principalId: string): string {
    return this.credentials.resolveWriteBank(principalId);
  }
}

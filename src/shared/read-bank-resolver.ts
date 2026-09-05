import { PrincipalCredentialResolver } from "./principal-credential-resolver.js";

export class ReadBankResolver {
  private readonly credentials: PrincipalCredentialResolver;

  constructor(credentials: PrincipalCredentialResolver) {
    this.credentials = credentials;
  }

  /** Effective readable banks; server grants remain authoritative. */
  resolve(principalId: string): string[] {
    return this.credentials.resolveReadBanks(principalId);
  }
}

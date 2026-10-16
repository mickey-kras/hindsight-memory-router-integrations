import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { AccessDeniedError, requireBank, visibleBanks } from "../shared/bank-access.js";
import { loadManagedConfig } from "../shared/managed-config.js";
import { RouterTransport } from "../shared/router-transport.js";
import { HUMAN_TOKEN_PATTERN, HumanLoginRequiredError, humanRouterUrl, readHumanSession } from "./human-session.js";

export function harnessTransport(harness: string | undefined): RouterTransport {
  return transportForConfig(harness, loadManagedConfig(process.env, harness));
}

function transportForConfig(
  harness: string | undefined,
  { config, principal }: ReturnType<typeof loadManagedConfig>,
): RouterTransport {
  if (principal.human) {
    const routerUrl = humanRouterUrl(config.routerUrl);
    const reference = principal.human.credentialRef;
    let session = readHumanSession(routerUrl, reference);
    return new RouterTransport({
      routerUrl,
      access: principal,
      principalId: () => session.principal_id,
      tokenPattern: HUMAN_TOKEN_PATTERN,
      unauthorizedError: () => new HumanLoginRequiredError(),
      token: () => {
        session = readHumanSession(routerUrl, reference);
        return session.token;
      },
    });
  }
  const tokenEnv = principal.tokenEnv;
  if (!tokenEnv) throw new AccessDeniedError();
  return new RouterTransport({
    routerUrl: config.routerUrl,
    access: principal,
    principalId: harness,
    token: () => process.env[tokenEnv],
  });
}

// Aggregated context may contain memory from any readable bank.
export function managedReadScope(harness: string | undefined, directory: string, sessionRoot?: string) {
  const snapshot = loadManagedConfig(process.env, harness);
  const transport = transportForConfig(harness, snapshot);
  const bankId = bankForPrincipal(snapshot.principal, directory);
  let workspace: string;
  let location: string;
  try {
    location = realpathSync(directory);
    workspace = sessionRoot ? realpathSync(sessionRoot) : location;
  } catch {
    throw new AccessDeniedError();
  }
  if (
    sessionRoot &&
    (!isWithinDirectory(location, workspace) || bankForPrincipal(snapshot.principal, sessionRoot) !== bankId)
  ) {
    throw new AccessDeniedError();
  }
  return {
    transport,
    endpoint: transport.baseUrl,
    workspace,
    bankId,
    identity: transport.authorizationIdentity(),
    banks: visibleBanks(transport.access).sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }),
  };
}

// The supplied harness is the entrypoint identity, never a normal-config override.
export function managedSettings(harness: string | undefined) {
  if (!harness) throw new AccessDeniedError();
  const snapshot = loadManagedConfig(process.env, harness);
  const transport = transportForConfig(harness, snapshot);
  const { config } = snapshot;
  const readOnlySettings = transport.access.writeBank
    ? {}
    : {
        retainSessions: false,
        autoSeed: false,
        codebaseSurvey: false,
        gitIngest: "none" as const,
      };
  return {
    harness,
    routerHarness: harness,
    toolPrefix: config.toolPrefix,
    apiUrl: transport.baseUrl,
    apiToken: undefined,
    serverMode: "self-hosted" as const,
    dynamicBankId: false,
    autoUpdate: false,
    optInOnly: true,
    manageBankConfig: false,
    ...readOnlySettings,
  };
}

export function managedBank(harness: string | undefined, directory: string): string {
  return bankForPrincipal(loadManagedConfig(process.env, harness).principal, directory);
}

function bankForPrincipal(principal: ReturnType<typeof loadManagedConfig>["principal"], directory: string): string {
  if (!directory) throw new AccessDeniedError();
  let location: string;
  try {
    location = realpathSync(directory);
  } catch {
    throw new AccessDeniedError();
  }
  const match = Object.entries(principal.mapPathToBank ?? {})
    .flatMap(([path, bank]) => {
      if (!isAbsolute(path)) return [];
      try {
        return [[realpathSync(resolve(path)), bank] as const];
      } catch {
        return [];
      }
    })
    .filter(([path]) => isWithinDirectory(location, path))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (!match) throw new AccessDeniedError();
  requireBank(principal, match[1], "read");
  return match[1];
}

function isWithinDirectory(location: string, directory: string): boolean {
  return location === directory || location.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

export function managedToolPrefix(harness: string): string {
  return loadManagedConfig(process.env, harness).config.toolPrefix;
}

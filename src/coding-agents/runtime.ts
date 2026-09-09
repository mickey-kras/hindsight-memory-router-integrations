import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
  AccessDeniedError,
  type BankAccess,
  requireBank,
  visibleBanks,
} from "../shared/bank-access.js";
import { RouterTransport } from "../shared/router-transport.js";

interface HarnessPrincipal extends BankAccess {
  tokenEnv: string;
  mapPathToBank?: Record<string, string>;
}
interface ManagedConfig {
  routerUrl: string;
  principals: Record<string, HarnessPrincipal>;
}

function managed(harness: string | undefined): {
  config: ManagedConfig;
  principal: HarnessPrincipal;
} {
  try {
    const path = process.env.HINDSIGHT_ROUTER_CONFIG;
    if (!path || !isAbsolute(path) || !harness) throw new AccessDeniedError();
    const config = JSON.parse(readFileSync(path, "utf8")) as ManagedConfig;
    if (!Object.hasOwn(config.principals, harness))
      throw new AccessDeniedError();
    const principal = config.principals[harness];
    if (
      !/^[A-Z_][A-Z0-9_]*$/.test(principal.tokenEnv) ||
      "token" in principal ||
      "apiToken" in principal
    )
      throw new AccessDeniedError();
    visibleBanks(principal);
    return { config, principal };
  } catch {
    throw new AccessDeniedError();
  }
}

export function harnessTransport(harness: string | undefined): RouterTransport {
  const { config, principal } = managed(harness);
  return new RouterTransport({
    routerUrl: config.routerUrl,
    access: principal,
    principalId: harness,
    token: () => process.env[principal.tokenEnv],
  });
}

/** The supplied harness is the entrypoint identity, never a normal-config override. */
export function managedSettings(harness: string | undefined) {
  if (!harness) throw new AccessDeniedError();
  const transport = harnessTransport(harness);
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

export function managedBank(
  harness: string | undefined,
  directory: string,
): string {
  const { principal } = managed(harness);
  harnessTransport(harness);
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
    .filter(([path]) => location === path || location.startsWith(path + sep))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (!match) throw new AccessDeniedError();
  requireBank(principal, match[1], "read");
  return match[1];
}

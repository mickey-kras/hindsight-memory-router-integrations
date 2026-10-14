import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { AccessDeniedError } from "../shared/bank-access.js";
import { PRINCIPAL_ID_PATTERN } from "../shared/patterns.js";
import { validateRouterUrl } from "../shared/router-url.js";

export const HUMAN_TOKEN_PATTERN = /^mrh_[0-9a-f]{32}_[0-9a-f]{64}$/;
export interface SecureEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deleteCredential(): boolean;
}
export interface HumanSession {
  token: string;
  principal_id: string;
  expires_at: number;
  routerUrl: string;
}

export class HumanLoginRequiredError extends AccessDeniedError {
  constructor() {
    super();
    this.message =
      "human session unavailable; unlock OS secure storage and run hindsight-coding-agents login; if native support is missing, reinstall from a verified package";
    this.name = "HumanLoginRequiredError";
  }
}

export function humanRouterUrl(value: string): string {
  const input = value.trim();
  if (
    Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new HumanLoginRequiredError();
  }
  const parts = input.match(/^https:\/\/([^/?#\\@]+)(\/[^?#]*)?$/i);
  if (!parts) throw new HumanLoginRequiredError();
  const rawPath = parts[2] ?? "";
  if (input.includes("\\") || /%|\/\.\.?(?:\/|$)|\/{2}$/.test(rawPath)) throw new HumanLoginRequiredError();
  const canonical = validateRouterUrl(input);
  const url = new URL(canonical);
  if (url.search || url.hash) throw new HumanLoginRequiredError();
  return canonical;
}

export function secureEntry(routerUrl: string, credentialRef: string): SecureEntry {
  try {
    if (!["darwin", "win32", "linux"].includes(process.platform) || !/^[A-Za-z0-9._-]{1,64}$/.test(credentialRef)) {
      throw new HumanLoginRequiredError();
    }
    const { Entry: NativeEntry } = createRequire(import.meta.url)("@napi-rs/keyring") as {
      Entry: new (service: string, account: string, options: { linux: { store: "secret-service" } }) => SecureEntry;
    };
    const service = `hindsight-memory-router:${createHash("sha256").update(humanRouterUrl(routerUrl)).digest("hex")}`;
    return new NativeEntry(service, credentialRef, { linux: { store: "secret-service" } });
  } catch {
    throw new HumanLoginRequiredError();
  }
}

export function validateHumanSession(value: unknown, routerUrl: string, allowExpired = false): HumanSession {
  if (typeof value !== "object" || value === null) throw new HumanLoginRequiredError();
  const session = value as Partial<HumanSession>;
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof session.token !== "string" ||
    !HUMAN_TOKEN_PATTERN.test(session.token) ||
    typeof session.principal_id !== "string" ||
    !PRINCIPAL_ID_PATTERN.test(session.principal_id) ||
    typeof session.expires_at !== "number" ||
    !Number.isSafeInteger(session.expires_at) ||
    (!allowExpired && session.expires_at <= now) ||
    session.expires_at > now + 3660 ||
    session.routerUrl !== humanRouterUrl(routerUrl)
  )
    throw new HumanLoginRequiredError();
  return {
    token: session.token,
    principal_id: session.principal_id,
    expires_at: session.expires_at,
    routerUrl: session.routerUrl,
  };
}

export function readHumanSession(routerUrl: string, credentialRef: string): HumanSession {
  try {
    const password = secureEntry(routerUrl, credentialRef).getPassword();
    if (!password || password.length > 4096) throw new HumanLoginRequiredError();
    return validateHumanSession(JSON.parse(password), routerUrl);
  } catch {
    throw new HumanLoginRequiredError();
  }
}

/** Compatibility lifecycle hooks. Deployment is owned by the Memory Router operator. */
import type { spawn } from "node:child_process";
import { AccessDeniedError } from "@memory-router/shared/bank-access";
import type { Config } from "./config";

export const DAEMON_WAIT_SESSION_START_MS = 12_000;
export const DAEMON_WAIT_RETAIN_MS = 40_000;

export interface LlmChoice { provider: string; apiKey?: string; source: string }
/** Legacy installer probes are inert: integrations cannot provision an upstream deployment. */
export function hasUvx(): boolean { return false; }
export function hasRustToolchain(): boolean { return false; }
export function detectLlm(_env: NodeJS.ProcessEnv = process.env): LlmChoice | undefined { return undefined; }

/** Existing harness lifecycles retain this call without starting or probing a local server. */
export async function ensureDaemon(
  cfg: Config,
  _harness: string,
  _opts: { waitMs?: number; spawnFn?: typeof spawn } = {}
): Promise<void> {
  if (cfg.serverMode !== "self-hosted") throw new AccessDeniedError();
}

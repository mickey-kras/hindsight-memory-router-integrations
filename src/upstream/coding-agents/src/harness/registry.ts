/**
 * Harness registry. Add a coding agent by implementing HarnessAdapter (one file in this dir) and
 * registering it here — the backfill's --harness flag resolves through getHarness().
 *
 * getHarness() never statically OR dynamically imports opencode.ts, even for "opencode": backfill
 * (its only real caller — see core/config.ts's note that the top-level `harness` key just selects
 * the backfill session formatter) only ever needs a harness's chatReader, and every harness's
 * chatReader — opencode included — is the same normalized-JSON reader (jsonChatReader below).
 * opencode.ts's plugin-specific createRuntime (the only part that needs @opencode-ai/plugin) is
 * wired up directly by src/index.ts, the opencode plugin entrypoint, bypassing this registry
 * entirely. That keeps this file, and everything bundled from it (in particular backfill.js), free
 * of the @opencode-ai/plugin dependency.
 */
import { readFileSync } from "node:fs";
import type { ChatSession, HarnessAdapter } from "../core/types";

/** Every harness ingests past sessions through the same normalized JSON interchange format. */
export const jsonChatReader = (harness: string) => ({
  describe:
    `${harness} sessions via a normalized JSON export ` +
    "(--conversations file: [{ id, turns:[{role,text,timestamp?}] }])",
  async read(opts: { conversations?: string }): Promise<ChatSession[]> {
    if (!opts.conversations) return [];
    return JSON.parse(readFileSync(opts.conversations, "utf8")) as ChatSession[];
  },
});

/**
 * A harness whose runtime this registry never constructs — either because it's a per-prompt HOOK
 * binary rather than a persistent plugin (core/hook.ts), or because (opencode) its runtime is built
 * directly by its own entrypoint, not via this registry.
 */
const noRuntimeAdapter = (name: string, hint: string): HarnessAdapter => ({
  name,
  chatReader: jsonChatReader(name),
  createRuntime() {
    throw new Error(hint);
  },
});

import { HARNESS_NAMES } from "./names";
export { HARNESS_NAMES } from "./names";

const HOOK_BINS: Record<string, string> = {
  "claude-code": "hindsight-claude-hook",
  "cursor-cli": "hindsight-cursor-hook",
  codex: "hindsight-codex-hook",
  dcode: "hindsight-dcode-hook",
  "antigravity-cli": "hindsight-antigravity-hook",
  "devin-cli": "hindsight-devin-hook",
  "copilot-cli": "hindsight-copilot-hook",
  "grok-build": "hindsight-grok-hook",
  "qwen-code": "hindsight-qwen-hook",
  "factory-droid": "hindsight-droid-hook",
  zcode: "hindsight-zcode-hook",
  traecode: "hindsight-traecode-hook",
  "kimi-code": "hindsight-kimi-hook",
  workbuddy: "hindsight-workbuddy-hook",
  codebuddy: "hindsight-codebuddy-hook",
  // more hook harnesses: add a HookSpec entry point (see src/cursor-hook.ts) + a registration here.
};

/** Where each persistent-plugin harness's runtime is actually built (see the branch below).
 *  Exported so a test can assert, over the whole family, that each of those files reports the
 *  harness mapped to it here — see registry.test.ts. */
export const PLUGIN_ENTRYPOINTS: Record<string, string> = {
  opencode: "src/index.ts",
  opencode2: "src/opencode2.ts",
  kilo: "src/kilo.ts",
  "cline-cli": "src/cline.ts",
  pi: "src/pi.ts",
  "prime-agent": "src/prime-agent.ts",
  dsh: "src/dsh.ts",
};

export async function getHarness(name: string): Promise<HarnessAdapter> {
  // The persistent-plugin harnesses: their runtime is built by their own plugin entrypoint (which
  // owns the @opencode-ai/plugin dependency this file must stay free of), never via this registry.
  // Backfill still resolves them here for the chatReader.
  const entry = PLUGIN_ENTRYPOINTS[name];
  if (entry) {
    return noRuntimeAdapter(
      name,
      `${name}'s runtime is built by ${entry} (the ${name} plugin entrypoint), not via the harness registry`
    );
  }
  const bin = HOOK_BINS[name];
  if (!bin) {
    throw new Error(`unknown harness '${name}'. available: ${HARNESS_NAMES.join(", ")}`);
  }
  return noRuntimeAdapter(
    name,
    `'${name}' has no persistent plugin runtime — install its hook binary (${bin}) instead`
  );
}

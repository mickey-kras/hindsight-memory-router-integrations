/**
 * Per-bank seed-consent state, for the auto-seed flow (Task 10).
 *
 * (Cold-repo detection itself lives in core/session-start.ts, which needs a tri-state result —
 * cold / warm / server-unreachable — that a plain boolean can't express.)
 *
 * Fail-safe throughout: state read/write never throws — a corrupt or unwritable state file must
 * not break the hook.
 */
import { toolBrand } from "@memory-router/shared/tool-prefix";
import { spawn as realSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SEED_LIMIT = 300;

type SeedSpawn = (...args: Parameters<typeof realSpawn>) => ReturnType<typeof realSpawn>;

/** Spawn a DETACHED background run of the deepen engine for `repoDir`. Idempotent server-side
 *  (per-bank lock + dedup by document id), so firing it every session start is safe — each run does
 *  only the missing work (cold seed, new conversations, the next diff-deepening batch). The child outlives this process.
 *  Await only OS launch confirmation, not extraction; true means launched, never seeded. Never rejects. */
export async function startBackgroundSeed(
  repoDir: string,
  opts: { limit?: number; harness?: string; enginePath?: string; spawn?: SeedSpawn } = {}
): Promise<boolean> {
  try {
    const spawnFn = opts.spawn ?? realSpawn;
    const enginePath =
      opts.enginePath ?? join(dirname(fileURLToPath(import.meta.url)), "deepen.js");
    const limit = opts.limit ?? DEFAULT_SEED_LIMIT;
    // The engine writes the leveled plugin.log itself (core/log.ts), so the child's stdio can be
    // fully detached — no fd redirect to manage.
    const child = spawnFn(
      "node",
      [
        enginePath,
        "--repo",
        repoDir,
        "--gitlog-limit",
        String(limit),
        ...(opts.harness ? ["--harness", opts.harness] : []),
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    return await new Promise<boolean>((resolve) => {
      child.once("error", () => {
        process.stderr.write("[memory-router] Background seed launch failed.\n");
        resolve(false);
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    process.stderr.write("[memory-router] Background seed launch failed.\n");
    return false;
  }
}

export interface SeedControlResult {
  ok: boolean;
  message: string;
}

/** Execute a seed-control command. Pure-ish: bank + connection are passed in; spawn + stateDir injectable. */
export async function seedControl(
  command: string,
  args: {
    repo: string;
    bankId: string;
    toolPrefix?: string;
    limit?: number;
    harness?: string;
    spawn?: SeedSpawn;
  }
): Promise<SeedControlResult> {
  if (command === "seed") {
    const launched = await startBackgroundSeed(args.repo, {
      limit: args.limit, spawn: args.spawn, harness: args.harness,
    });
    if (!launched) return { ok: false, message: "Background seed launch failed." };
    return {
      ok: true,
      message: `🧠 ${toolBrand(args.toolPrefix).displayName} background seed launched for memory bank “${args.bankId}”`,
    };
  }
  return { ok: false, message: "usage: hindsight-seed seed --repo <dir>" };
}

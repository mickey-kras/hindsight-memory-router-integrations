import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync, rmSync } from "node:fs";
import { readPrivateFile, sessionStateFile, writePrivateFileAtomic, withPrivateFile } from "./private-state";
import type { PageRef } from "./knowledge-injection";
import type { RetainCursor, RetainCursorStore } from "./retain-cursor";
import type { UsageCursorStore } from "./usage";

/** Process-shared state for hook harnesses. SessionStart and prompt hooks are separate Node
 * processes, so this temp-file handoff carries lifecycle decisions without writing user config or
 * bank state. */
export interface SessionCache {
  turns?: number;
  reflectAnswer?: string; // present (even "") = reflect already resolved this session
  /** How many times auto-inject has been ATTEMPTED this session — every source, not just reflect.
   *  A failure leaves `reflectAnswer` unset so a later turn can retry; this bounds that retry (see
   *  HOOK_INJECT_ATTEMPTS). Named for reflect like `reflectAnswer` above, whose name also predates
   *  the other two sources. */
  reflectAttempts?: number;
  /** SessionStart saw a new/empty bank; consume this on prompt one, then allow reflect. */
  deferInitialReflect?: boolean;
  pages?: { atTurn: number; list: PageRef[] };
}

export function sessionCacheFile(harness: string, sessionId: string): string {
  return sessionStateFile(harness, sessionId, ".json");
}

export function readSessionCache(cacheFile: string): SessionCache {
  try {
    const cached = JSON.parse(readPrivateFile(cacheFile)) as SessionCache;
    return { turns: cached.turns, reflectAttempts: cached.reflectAttempts, deferInitialReflect: cached.deferInitialReflect, reflectAnswer: cached.reflectAnswer === undefined ? undefined : "" };
  } catch {
    return {};
  }
}

export function writeSessionCache(cacheFile: string, cache: SessionCache): void {
  try {
    writePrivateFileAtomic(cacheFile, JSON.stringify({ turns: cache.turns, reflectAttempts: cache.reflectAttempts, deferInitialReflect: cache.deferInitialReflect, reflectAnswer: cache.reflectAnswer === undefined ? undefined : "" }));
  } catch {
    /* session state is best-effort */
  }
}

/** Context a prompt hook could not deliver itself, waiting for the session's next tool hook (see
 *  HookSpec.toolHook). Its own file: `buildHookOutput` rewrites the session cache every turn. */
/** Separate the handoff from every other endpoint, mapped bank and workspace. */
export function pendingContextKey(endpoint: string, bank: string, cwd: string, sessionId: string): string {
  return createHash("sha256").update(JSON.stringify([endpoint, bank, cwd, sessionId])).digest("hex");
}

function pendingContextFile(harness: string, sessionId: string): string {
  return sessionStateFile(harness, sessionId, ".pending");
}

/** Add a block to the session's pending context. A block already waiting is not added again, so a
 *  session that goes several turns without a tool call is not handed the same roster N times. */
export function stashPendingContext(harness: string, sessionId: string, context: string): void {
  const path = pendingContextFile(harness, sessionId);
  let existing = "";
  try {
    existing = readPrivateFile(path);
  } catch {
    /* nothing pending yet */
  }
  if (existing.includes(context)) return;
  try {
    writePrivateFileAtomic(path, existing ? `${existing}\n\n${context}` : context);
  } catch {
    /* best-effort, like the session cache */
  }
}

/** Claim and clear the session's pending context. The rename is the claim: tool hooks can run in
 *  parallel, and only the one whose rename succeeds delivers the block. */
export function takePendingContext(harness: string, sessionId: string): string | undefined {
  const path = pendingContextFile(harness, sessionId);
  const claimed = `${path}.${randomUUID()}.claim`;
  try {
    withPrivateFile(path, constants.O_RDONLY, () => renameSync(path, claimed));
    return readPrivateFile(claimed) || undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(claimed, { force: true });
  }
}

/** The session root's own file, deliberately NOT the shared session cache — see sessionRootDir. */
function sessionRootFile(harness: string, sessionId: string): string {
  return sessionStateFile(harness, sessionId, ".root");
}

/**
 * The directory this session STARTED in: recorded the first time any of its hooks runs — normally
 * SessionStart — and returned unchanged for the rest of the session.
 *
 * Bank resolution needs a directory that does not move. A hook event reports the agent's LIVE
 * working directory, and an agent `cd`s during ordinary work. Inside a git repo that is harmless
 * (every subdirectory resolves back to the repo root), but a plain directory tree has no root to
 * resolve to, so the bank id followed the agent and ONE conversation was retained into a bank per
 * directory it visited — the same document, its facts split across banks (#3563).
 *
 * Deliberately keyed on the session id rather than read from a harness-exported project-root
 * variable: every hook harness reports a session id, only Claude Code exports a root. Same reason
 * `nearestExistingDir` walks the tree instead of guessing at nine env var names.
 *
 * It lives in its OWN file, like the retain cursor and for the same reason: the prompt hook writes
 * a fresh session-cache object rather than merging, so a field there would be dropped on every user
 * prompt — and the very first prompt is where it would first be needed.
 *
 * Best-effort throughout. A temp file that cannot be read or written just yields `cwd`, which is
 * exactly the behaviour before this existed — never an error, never a lost retain.
 */
export function sessionRootDir(
  harness: string,
  sessionId: string | undefined,
  cwd: string
): string {
  if (!sessionId || !cwd) return cwd;
  const file = sessionRootFile(harness, sessionId);
  try {
    const recorded = readPrivateFile(file).trim();
    if (recorded) return recorded;
  } catch {
    /* not recorded yet — this hook is the session's first */
  }
  try {
    writePrivateFileAtomic(file, cwd);
  } catch {
    /* best-effort: an unrecorded root costs stability, never data */
  }
  return cwd;
}

/**
 * How many of a session's turns core/usage.ts has recorded. Its own file for the same reason as
 * the retain cursor below; losing it re-records the session's turns, which the report dedupes.
 */
export function fileUsageCursorStore(harness: string): UsageCursorStore {
  const file = (sessionId: string) =>
    sessionStateFile(harness, sessionId, ".usage.json");
  return {
    read: (sessionId) => {
      try {
        const turns = (JSON.parse(readPrivateFile(file(sessionId))) as { turns?: unknown })
          .turns;
        return typeof turns === "number" ? turns : undefined;
      } catch {
        return undefined;
      }
    },
    write: (sessionId, turns) => {
      try {
        writePrivateFileAtomic(file(sessionId), JSON.stringify({ turns }));
      } catch {
        /* best-effort */
      }
    },
  };
}

/** The cursor's own file, deliberately NOT the shared session cache — see fileCursorStore. */
function cursorFile(harness: string, sessionId: string): string {
  return sessionStateFile(harness, sessionId, ".retain.json");
}

/**
 * Retain cursor for the hook harnesses: Stop runs in a fresh process every time, so "what have I
 * already written" cannot live in memory.
 *
 * It lives in its OWN file rather than a field of the session cache. It shared that file until now,
 * and the prompt hook — which writes a fresh `{turns, reflectAnswer, pages}` object rather than
 * merging — dropped the cursor on EVERY user prompt. The next Stop then found none and rewrote the
 * whole document, so the incremental write-back never engaged past a session's first turn on any
 * hook harness. Separate files make that structural: the two writers have different lifecycles and
 * no longer share a record, so neither can clobber the other, and the concurrent read-modify-write
 * that #3136 measured has nothing left to lose here.
 *
 * Losing the file (temp cleanup, reboot) is still not a correctness problem — a missing cursor
 * means the next retain replaces the whole document, exactly as it did before appends existed.
 */
export function fileCursorStore(harness: string): RetainCursorStore {
  return {
    read: (sessionId) => {
      try {
        return JSON.parse(readPrivateFile(cursorFile(harness, sessionId))) as RetainCursor;
      } catch {
        return undefined;
      }
    },
    write: (sessionId, cursor) => {
      try {
        writePrivateFileAtomic(cursorFile(harness, sessionId), JSON.stringify(cursor));
      } catch {
        /* best-effort: a cursor that cannot be written costs a replace, never data */
      }
    },
  };
}

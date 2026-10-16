/**
 * Leveled plugin logging — ONE human-readable log file for debugging, next to (not replacing) the
 * structured diag JSONL contract (core/diag.ts, which benchmarks/harnesses parse).
 *
 *   file : ~/.hindsight/coding-agents-logs/plugin.log   (override: HINDSIGHT_LOG_FILE)
 *   level: "info" default — config `logLevel`, or HINDSIGHT_LOG_LEVEL for ad-hoc debugging
 *          without touching config ("debug" | "info" | "warn" | "error")
 *
 * Line format: `<iso> LEVEL [scope] message {extra-json}` — greppable, tail-able. At "debug",
 * every diag event is mirrored here too. Both files retain metadata only. Never throws: logging
 * must not break the agent.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Every log this plugin keeps (plugin.log, diag.jsonl, usage.jsonl) lives here.
 *
 * They used to be split between `/tmp/hindsight-plugin.log` and `$TMPDIR/hindsight-coding-agent/`:
 * the first is shared by every user on the machine, both are
 * wiped on reboot, which loses exactly the history usage stats are for, and neither was bounded. A
 * sibling of the staged runtime (`~/.hindsight/coding-agents`), not a child of it: `update`
 * replaces that directory wholesale. Scratch state (session cache, cursors, locks) stays in the OS
 * temp dir on purpose — losing it is harmless.
 */
export function logsDir(): string {
  return join(homedir(), ".hindsight", "coding-agents-logs");
}

/** Past this size a log is rotated to `<file>.1` (one generation kept), so each is capped at ~2x. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Append to a log file, rotating it first once it has reached LOG_MAX_BYTES. Throws — callers are
 * the fail-open wrappers. The directory is owner-only even though diagnostics omit content.
 *
 * Rotation is not coordinated across processes (every hook is its own process). Two that rotate at
 * once can push the just-restarted file over `.1`, losing one old generation — a bounded,
 * diagnostics-only loss that is cheaper than a lock on every log line.
 */
export function appendLogLine(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size >= LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    /* no file yet, or another process just rotated it */
  }
  appendFileSync(file, text, { mode: 0o600 });
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: LogLevel =
  (["debug", "info", "warn", "error"] as const).find(
    (l) => l === process.env.HINDSIGHT_LOG_LEVEL
  ) ?? "info";

/** Entry points call this after loadConfig; the HINDSIGHT_LOG_LEVEL env override still wins. */
export function setLogLevel(level: LogLevel): void {
  if (!process.env.HINDSIGHT_LOG_LEVEL) current = level;
}

export function logFilePath(): string {
  return process.env.HINDSIGHT_LOG_FILE || join(logsDir(), "plugin.log");
}

const NUMERIC_FIELDS = new Set([
  "ms", "chars", "count", "turns", "timeoutMs", "pages", "newChats", "failures",
  "hostCatalog", "hindsight", "commits", "limit",
]);
const BOOLEAN_FIELDS = new Set(["cold", "wired", "hasSession", "appendSupported", "retry", "settled"]);
const ERROR_CLASSES = ["timeout", "aborted", "connection_refused", "dns_failure", "operation_failed"] as const;
type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Classify failures without rendering messages, stacks, URLs or arbitrary cause values. */
function errorClass(value: unknown): ErrorClass {
  const seen = new Set<unknown>();
  let error: unknown = value;
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 8) {
    seen.add(error);
    const detail = error as { name?: unknown; code?: unknown; timedOut?: unknown; cause?: unknown };
    if (detail.timedOut === true || detail.name === "TimeoutError" || detail.code === "ETIMEDOUT") return "timeout";
    if (detail.name === "AbortError") return "aborted";
    if (detail.code === "ECONNREFUSED") return "connection_refused";
    if (detail.code === "ENOTFOUND" || detail.code === "EAI_AGAIN") return "dns_failure";
    error = detail.cause;
  }
  return "operation_failed";
}

/** Shared allowlist for both sinks. Unknown fields and all free-form text are discarded. */
export function logMetadata(extra: Record<string, unknown> = {}): Record<string, number | boolean | string> {
  const safe: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (NUMERIC_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value)) safe[key] = value;
    else if (key === "status" && typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) safe[key] = value;
    else if (BOOLEAN_FIELDS.has(key) && typeof value === "boolean") safe[key] = value;
    else if (key === "mode" && (value === "append" || value === "replace" || value === "skip")) safe[key] = value;
    else if (key === "error") safe.errorClass = errorClass(value);
    else if (key === "errorClass" && ERROR_CLASSES.some((known) => known === value)) safe.errorClass = String(value);
  }
  return safe;
}

function write(level: LogLevel, scope: string, msg: string, extra?: Record<string, unknown>): void {
  if (WEIGHT[level] < WEIGHT[current]) return;
  try {
    const metadata = logMetadata(extra);
    appendLogLine(
      logFilePath(),
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
        (Object.keys(metadata).length ? ` ${JSON.stringify(metadata)}` : "") +
        "\n"
    );
  } catch {
    /* logging must never break the agent */
  }
}

export const log = {
  debug: (scope: string, msg: string, extra?: Record<string, unknown>) =>
    write("debug", scope, msg, extra),
  info: (scope: string, msg: string, extra?: Record<string, unknown>) =>
    write("info", scope, msg, extra),
  warn: (scope: string, msg: string, extra?: Record<string, unknown>) =>
    write("warn", scope, msg, extra),
  error: (scope: string, msg: string, extra?: Record<string, unknown>) =>
    write("error", scope, msg, extra),
};

/**
 * Render a thrown value with its `cause` chain.
 *
 * Node's fetch reports EVERY transport failure as the bare string "fetch failed" and hides the real
 * reason (ECONNREFUSED, ENOTFOUND, a TLS error, a timeout) on `error.cause`. This is for foreground
 * error descriptions, never log messages. Durable diagnostics classify errors without their text.
 */
export function describeError(value: unknown, maxChars = 200): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  while (current && !seen.has(current)) {
    seen.add(current);
    const error = current as { message?: unknown; code?: unknown; cause?: unknown };
    const text = typeof error.message === "string" ? error.message : String(current);
    // A cause usually carries the code (ECONNREFUSED) the wrapper dropped; keep both, skip repeats.
    const withCode = error.code ? `${text} (${String(error.code)})` : text;
    if (withCode && parts.at(-1) !== withCode) parts.push(withCode);
    current = error.cause;
  }
  return (parts.join(": ") || String(value)).slice(0, maxChars);
}

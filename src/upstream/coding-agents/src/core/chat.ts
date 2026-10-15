import { AccessDeniedError } from "@memory-router/shared/bank-access";
import { createHash } from "node:crypto";
/**
 * Harness-agnostic chat memory: the JSON user/assistant transcript schema shared by BOTH the
 * backfill (ingest past sessions) and the live runtime write-back. A leading `system` turn carries
 * the REF-ID tracer; every turn gets an ABSOLUTE timestamp.
 */
import { diag } from "./diag";
import { RateLimitedError, type HindsightClient } from "./hindsight";
import {
  advancePaths,
  fingerprintTurns,
  MAX_CURSOR_OPS,
  MAX_CURSOR_PATHS,
  planRetain,
  type RetainCursor,
  type RetainCursorStore,
} from "./retain-cursor";
import type { RetainStamp } from "./retain-stamp";
import type { ChatSession } from "./types";
import { uuidV5 } from "./uuid";
import { pool, sleep } from "./util";

const MAX_ROLLOUT_TURNS = 100_000;
const MAX_ROLLOUT_CHARS = 32 * 1024 * 1024;
const MAX_ROLLOUT_PATH_CHARS = 32 * 1024;

function contentFingerprint(turns: TransportTurn[], count: number): string {
  const hash = createHash("sha1").update(String(count));
  for (let i = 0; i < count; i++) hash.update("\n" + JSON.stringify({ role: turns[i].role, content: turns[i].content }));
  return hash.digest("hex");
}

export interface TransportTurn {
  role: string;
  content: string;
  timestamp?: string;
}

/** Prepend the REF-ID system turn to a set of already-normalized turns. */
export function withRefId(refId: string, turns: TransportTurn[], baseTs: string): TransportTurn[] {
  return [{ role: "system", content: `REF-ID: ${refId}`, timestamp: baseTs }, ...turns];
}

/**
 * Render normalized turns as a JSONL transcript (ONE turn per line) — the same shape everywhere:
 * live write-back and backfilled chats alike. JSONL beats a JSON array on both ends: appending a
 * turn never rewrites the document, and the server's structured chunker treats each line as an
 * atomic unit (`retain_structured_chunk_size`), so a turn is never split mid-thought. The REF-ID
 * system turn leads; tool activity is already compacted into `role:"action"` turns.
 */
export function renderSessionJsonl(refId: string, turns: TransportTurn[], baseTs: string): string {
  return withRefId(refId, turns, baseTs)
    .map((t) => JSON.stringify(t))
    .join("\n");
}

/** Backfill: ingest past sessions RAW as JSON transcripts under the `conversation` strategy. */
export async function ingestChats(
  client: HindsightClient,
  sessions: ChatSession[],
  opts: {
    concurrency?: number;
    log?: (m: string) => void;
    stampFor?: (sessionId: string) => RetainStamp;
  } = {}
): Promise<number> {
  const log = opts.log ?? (() => {});
  if (!sessions.length) {
    log("[chat] no sessions; skipping");
    return 0;
  }
  log(`[chat] ingesting ${sessions.length} chats (RAW, JSONL transcript — one turn per line) …`);
  const NOW = Date.now(); // anchor synthesized times to a real, ABSOLUTE clock (not a fabricated epoch)
  let failures = 0;
  await pool(
    sessions,
    opts.concurrency ?? 8,
    async (s, i) => {
      const id = s.id || `s${i}`;
      const stamp = opts.stampFor?.(id);
      // List order is CHRONOLOGICAL (a later chat can amend an earlier one), so the LAST session is
      // the newest — the previous `NOW - i*1h` inverted recency and made an amendment rank older than
      // the decision it superseded. This synthetic stagger is therefore only a FALLBACK, for a
      // transcript that carries no clocks of its own.
      const sessBase = NOW - (sessions.length - 1 - i) * 3600000;
      // A backfilled session keeps the clock it actually happened on: when any turn carries a source
      // timestamp, the first one dates the document (verbatim, offset included) and anchors the
      // turns that have none. Dating it to the import made an old session surface as recent even
      // though every turn inside it was dated correctly.
      const sourceTs = (s.turns || [])
        .map((t) => t.timestamp)
        .find((v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)));
      const anchorMs = sourceTs ? Date.parse(sourceTs) : sessBase;
      const baseIso = sourceTs ?? new Date(sessBase).toISOString();
      const turns = withRefId(
        `chat:${id}`,
        (s.turns || []).map((t, j) => ({
          role: t.role,
          content: t.text,
          timestamp: t.timestamp || new Date(anchorMs + (j + 1) * 60000).toISOString(),
        })),
        baseIso
      );
      await client.retain(
        turns.map((x) => JSON.stringify(x)).join("\n"),
        "developer chat",
        `chat:${id}`,
        [...new Set([...(stamp?.tags ?? []), "source:chat"])],
        "conversation",
        {
          timestamp: baseIso,
          metadata: {
            ...stamp?.metadata,
            source: "chat",
            chat: id,
            ref_id: `chat:${id}`,
          },
        }
      );
    },
    (i, e) => {
      failures++;
      log(`  ! chat ${i} failed to enqueue: ${(e as Error).message?.slice(0, 120)}`);
    }
  );
  log(`[chat] done: ${sessions.length} chats ingested (JSONL) under strategy 'chat'`);
  return failures;
}

/** Capability probe for the append path. A failed server-version probe answers "no": appending
 *  without `operation_id` dedupe can double-write, so doubt falls back to a full replace. A failed
 *  bank-config probe answers "yes" (see HindsightClient.supportsAppendRetain): banks store document
 *  text by default, and only an explicit `store_document_text: false` rules append out (#4613). */
async function supportsAppend(client: HindsightClient): Promise<boolean> {
  try {
    return await client.supportsAppendRetain();
  } catch (error) {
    if (error instanceof AccessDeniedError) throw error;
    return false;
  }
}

/** Short: this runs on every write-back that follows an accepted one, inside a hook's budget. */
const OP_CHECK_TIMEOUT_MS = 5_000;
const LOST_OP_STATUSES = new Set(["failed", "cancelled", "error"]);

/**
 * Settle the cursor's accepted-but-unconfirmed operations (#5251). Returns the cursor to plan from —
 * marked `dirty` when one of them failed, so the plan replaces and re-sends the turns it carried —
 * and the ids still worth checking next time. Fail-open: an op whose status cannot be read stays
 * tracked, never counts as failed.
 */
async function settleOps(
  client: HindsightClient,
  cursor: RetainCursor
): Promise<{ cursor: RetainCursor; ops: string[] }> {
  const ops = cursor.ops ?? [];
  const statuses = await Promise.all(
    ops.map(async (id) => {
      try {
        const r = await client.req(
          "GET",
          client.bankUrl(`/operations/${encodeURIComponent(id)}`),
          undefined,
          [],
          OP_CHECK_TIMEOUT_MS
        );
        if (r.status === 404) return "not_found"; // pruned: nothing left to learn
        return String(((await r.json()) as { status?: unknown }).status ?? "").toLowerCase();
      } catch (error) {
        if (error instanceof AccessDeniedError) throw error;
        return "";
      }
    })
  );
  const lost = statuses.some((s) => LOST_OP_STATUSES.has(s));
  const open = ops.filter((_, i) => !["completed", "not_found"].includes(statuses[i]));
  return { cursor: lost ? { ...cursor, dirty: true } : cursor, ops: lost ? [] : open };
}

/** Retry window for a caller that did not supply one — a long-lived host with no external clock. */
const DEFAULT_RETRY_WINDOW_MS = 60_000;

/** Attempts a rate-limited write-back may make before giving up. */
const RETAIN_RETRY_ATTEMPTS = 2;

/** What a retry must still leave room for: `req` aborts a request at 15s. Waiting past the point
 *  where the retry itself could not finish buys nothing. */
const REQUEST_BUDGET_MS = 15_000;

/**
 * Submit a write-back, retrying while the API is rate-limiting us AND our write is still the
 * newest one for this session.
 *
 * Retrying is safe rather than duplicative because the payload carries a deterministic
 * `operation_id`: an identical resubmission is collapsed into the original operation server-side.
 *
 * The staleness check is the important half. If another write-back has claimed the cursor since
 * ours — a newer turn, another process — then ours is superseded, and the newer one carries
 * everything we were sending: it replays our buffered payload ahead of its own, or replaces the
 * document outright. Retrying then would spend a hook's remaining time re-sending content that is
 * already on its way.
 */
async function submitWithRetry(
  send: () => Promise<void>,
  isStillNewest: () => boolean,
  retryUntil: number
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      const limited = e instanceof RateLimitedError;
      if (!limited || attempt >= RETAIN_RETRY_ATTEMPTS || !isStillNewest()) throw e;
      // Either honour Retry-After in full or do not retry at all: waiting less than the server
      // asked would just earn another 429. Whether it fits is the CALLER's clock, not a constant —
      // a hook process is killed by its host at a known deadline, a long-lived runtime is not.
      const wait = e.retryAfterMs || 1000;
      if (Date.now() + wait + REQUEST_BUDGET_MS > retryUntil) throw e;
      await sleep(wait);
    }
  }
}

/**
 * One write-back at a time per session, keyed by the store the cursors live in.
 *
 * The persistent-plugin runtime fires retains without awaiting them (a turn-driven one and an
 * idle-driven one can overlap), and reading the cursor is not atomic with claiming it — there is an
 * await in between. Two overlapping calls therefore both planned an append from the SAME position
 * and submitted overlapping slices, duplicating turns inside the document; and even serialising the
 * claim alone would leave an append racing a replace on the wire, where the order they land in
 * decides whether the result is correct. Chaining the whole read-plan-send-confirm cycle is what
 * makes the cursor mean what it says: the second call sees the first call's CONFIRMED position.
 */
const writeBacks = new WeakMap<RetainCursorStore, Map<string, Promise<void>>>();

function serialize(
  cursors: RetainCursorStore,
  sessionId: string,
  write: () => Promise<void>
): Promise<void> {
  const perSession = writeBacks.get(cursors) ?? new Map<string, Promise<void>>();
  writeBacks.set(cursors, perSession);
  // Chain off the previous write-back whether it succeeded or failed — a failure leaves its payload
  // buffered on the cursor (or the cursor dirty), which the next call needs to see before it plans.
  const next = (perSession.get(sessionId) ?? Promise.resolve()).then(write, write);
  const tail = next.catch(() => {});
  perSession.set(sessionId, tail);
  // Drop the entry once it is settled AND still the tail, so a host that outlives many sessions
  // (opencode runs for days) doesn't accumulate one resolved promise per session id forever.
  void tail.then(() => {
    if (perSession.get(sessionId) === tail) perSession.delete(sessionId);
  });
  return next;
}

/**
 * The `context` of a session write-back when `retainContext` is unset. The second sentence keeps an
 * agent's own "fixed"/"passes" a claim: stored as fact, a later session applied it without checking
 * the code (#4791). It lives here rather than in the bank's retain mission because the mission is
 * seeded once and never reaches a bank that already has one; the context rides on every write.
 */
export const DEFAULT_RETAIN_CONTEXT =
  "conversation between the user and you (the coding agent): user turns are the user's words and " +
  "decisions, assistant turns are yours. When an assistant turn says something is fixed, passes or " +
  'works, record it as the agent\'s claim ("the agent reported X fixed"), not as an established fact.';

/**
 * Live write-back: upsert a running session under a stable document_id, sending only what is new.
 *
 * Given a cursor store, a session that has already been written APPENDS the turns added since the
 * last successful write; the server concatenates them onto the stored document (with "\n", which is
 * why the transcript is JSONL) and re-chunks. Without one — first write, a rewritten transcript, an
 * unconfirmed previous write, or a server too old to be idempotent — it falls back to REPLACING the
 * whole document, which is what this always used to do. See core/retain-cursor.ts for why every
 * uncertain case resolves that way.
 *
 * Uses the same `conversation` strategy as backfilled chats — one strategy for all developer
 * conversations; the mission scales extraction to the substance. The content is a JSON transcript
 * (renderSessionJsonl) whose tool activity is compacted into `role:"action"` turns
 * (see core/transcript*.ts).
 */
export async function retainLiveSession(
  client: HindsightClient,
  sessionId: string,
  turns: TransportTurn[],
  startTs: string,
  harness?: string,
  opts: {
    cursors?: RetainCursorStore;
    stamp?: RetainStamp;
    retryUntil?: number;
    /** The transcript file the turns came from, when there is one — see RetainCursor.paths. */
    transcriptPath?: string;
    readTranscript?: (path: string) => TransportTurn[];
    sourceTurnCount?: number;
  } = {}
): Promise<void> {
  const cursors = opts.cursors;
  if (!cursors)
    return writeSession(
      client,
      sessionId,
      turns,
      startTs,
      harness,
      opts.stamp,
      undefined,
      opts.retryUntil,
      opts.transcriptPath,
      opts.readTranscript,
      opts.sourceTurnCount
    );
  // Serialised so the plan is made against the previous write-back's CONFIRMED cursor (see above).
  return serialize(cursors, sessionId, () =>
    writeSession(
      client,
      sessionId,
      turns,
      startTs,
      harness,
      opts.stamp,
      cursors,
      opts.retryUntil,
      opts.transcriptPath,
      opts.readTranscript,
      opts.sourceTurnCount
    )
  );
}

async function writeSession(
  client: HindsightClient,
  sessionId: string,
  turns: TransportTurn[],
  startTs: string,
  harness?: string,
  stamp?: RetainStamp,
  cursors?: RetainCursorStore,
  /** Absolute time this write-back may keep retrying until; the caller owns its own clock. */
  retryUntil = Date.now() + DEFAULT_RETRY_WINDOW_MS,
  transcriptPath?: string,
  readTranscript?: (path: string) => TransportTurn[],
  sourceTurnCount?: number
): Promise<void> {
  if (!turns.length) return;
  const refId = `conversation:${sessionId}`;
  let cursor = cursors?.read(sessionId);
  // Capability and accepted operations belong to the former bank, not the newly mapped bank.
  if (cursor && cursor.bank !== client.bank) cursor = undefined;
  let rollouts: RetainCursor["rollouts"];
  if (transcriptPath && readTranscript) {
    if (transcriptPath.length > MAX_ROLLOUT_PATH_CHARS || (cursor?.rollouts && (!Array.isArray(cursor.rollouts) || cursor.rollouts.length > MAX_CURSOR_PATHS)))
      throw new Error("Invalid rollout retention state");
    const reconstructing = (cursor?.rollouts?.map(segment => segment.path) ?? cursor?.paths ?? []).some(path => path !== transcriptPath);
    const validateSource = (source: TransportTurn[]) => {
      if (!reconstructing) return;
      if (source.length > MAX_ROLLOUT_TURNS) throw new Error("Rollout reconstruction turn limit reached");
      let chars = 0;
      for (const turn of source) {
        chars += JSON.stringify(turn).length;
        if (chars > MAX_ROLLOUT_CHARS) throw new Error("Rollout reconstruction size limit reached");
      }
    };
    validateSource(turns);
    if (cursor && (!Number.isSafeInteger(cursor.turns) || cursor.turns < 0 || typeof cursor.fingerprint !== "string" || (cursor.rollouts && !cursor.rollouts.length)))
      throw new Error("Invalid rollout retention state");
    if (!cursor?.rollouts && (cursor?.paths?.length ?? 0) > 1)
      throw new Error("Cannot reconstruct legacy multi-rollout retention state");
    if (cursor && !cursor.rollouts && !cursor.paths?.length && (cursor.turns > turns.length || fingerprintTurns(turns, cursor.turns) !== cursor.fingerprint))
      throw new Error("Cannot reconstruct legacy rollout retention state");
    rollouts = cursor?.rollouts?.map(segment => ({ ...segment }))
      ?? (cursor?.paths?.length ? [{ path: cursor.paths[0], fromTurn: 0, turns: cursor.turns, fingerprint: cursor.fingerprint }] : []);
    if (rollouts.length > MAX_CURSOR_PATHS || new Set(rollouts.map(segment => segment.path)).size !== rollouts.length)
      throw new Error("Invalid rollout retention state");
    if (cursor?.rollouts && cursor.paths && (cursor.paths.length !== rollouts.length || cursor.paths.some((path, i) => path !== rollouts![i].path)))
      throw new Error("Invalid rollout retention state");
    const aggregate: TransportTurn[] = [];
    const sourceCounts = new Map<string, number>();
    let aggregateChars = 0;
    const include = (source: TransportTurn[], fromTurn: number) => {
      if (reconstructing && source.length > MAX_ROLLOUT_TURNS) throw new Error("Rollout reconstruction turn limit reached");
      for (let i = fromTurn; i < source.length; i++) {
        if (reconstructing) aggregateChars += JSON.stringify(source[i]).length;
        if (reconstructing && (aggregate.length >= MAX_ROLLOUT_TURNS || aggregateChars > MAX_ROLLOUT_CHARS))
          throw new Error("Rollout reconstruction size limit reached");
        aggregate.push(source[i]);
      }
    };
    for (const segment of rollouts) {
      if (typeof segment.path !== "string" || segment.path.length > MAX_ROLLOUT_PATH_CHARS || typeof segment.fingerprint !== "string" || !Number.isSafeInteger(segment.fromTurn) || segment.fromTurn < 0 || !Number.isSafeInteger(segment.turns) || segment.turns < segment.fromTurn)
        throw new Error("A contributed rollout cannot be reconstructed");
      if (segment.copiedFrom !== undefined && (typeof segment.copiedFrom !== "string" || !segment.copiedFrom.length))
        throw new Error("Invalid copied rollout reference");
      const parentTurns = segment.copiedFrom ? sourceCounts.get(segment.copiedFrom) : aggregate.length;
      if (parentTurns === undefined || (segment.copiedFrom && segment.fromTurn === 0))
        throw new Error("Invalid copied rollout reference");
      const source = segment.path === transcriptPath ? turns : readTranscript(segment.path);
      if (segment.path !== transcriptPath) validateSource(source);
      if (!source.length && segment.turns > 0) throw new Error("A contributed rollout is empty or unreadable");
      if (segment.unflushed) {
        const prefix = segment.unflushed;
        if (!Number.isSafeInteger(prefix.turns) || prefix.turns < 1 || prefix.turns > source.length || contentFingerprint(source, prefix.turns) !== prefix.fingerprint)
          throw new Error("A contributed reply has not been flushed to its rollout");
        if (segment.path !== transcriptPath || (sourceTurnCount !== undefined && sourceTurnCount >= prefix.turns)) delete segment.unflushed;
      }
      if (source.length < segment.fromTurn || (segment.fromTurn > 0 && fingerprintTurns(source, segment.fromTurn) !== segment.prefix))
        throw new Error("A copied rollout prefix changed");
      if (segment.fromTurn > 0 && parentTurns !== segment.fromTurn &&
        (source.length < segment.turns || fingerprintTurns(source, segment.turns) !== segment.fingerprint ||
          segment.turns === segment.fromTurn))
        throw new Error("A copied rollout boundary is ambiguous");
      segment.turns = source.length;
      segment.fingerprint = fingerprintTurns(source, source.length);
      include(source, segment.fromTurn);
      sourceCounts.set(segment.path, source.length);
    }
    if (!rollouts.some(segment => segment.path === transcriptPath)) {
      if (rollouts.length >= MAX_CURSOR_PATHS) throw new Error("Rollout retention path limit reached");
      let fromTurn = 0, prefix: string | undefined, copiedFrom: string | undefined;
      const candidates = rollouts.length && cursor ? [
        { turns: aggregate.length, fingerprint: fingerprintTurns(aggregate, aggregate.length), path: undefined },
        { turns: cursor.turns, fingerprint: cursor.fingerprint, path: undefined },
        ...rollouts, ...(cursor.rollouts ?? []),
      ] : [];
      const prefixHashes = new Map<number, string>();
      for (const candidate of candidates) {
        if (candidate.turns <= fromTurn || candidate.turns > turns.length) continue;
        const hash = prefixHashes.get(candidate.turns) ?? fingerprintTurns(turns, candidate.turns);
        prefixHashes.set(candidate.turns, hash);
        if (hash === candidate.fingerprint) { fromTurn = candidate.turns; prefix = hash; copiedFrom = candidate.path; }
      }
      rollouts.push({ path: transcriptPath, fromTurn, turns: turns.length, fingerprint: fingerprintTurns(turns, turns.length), ...(fromTurn ? { prefix, ...(copiedFrom ? { copiedFrom } : {}) } : {}) });
      include(turns, fromTurn);
    }
    const active = rollouts.find(segment => segment.path === transcriptPath)!;
    if (sourceTurnCount !== undefined && sourceTurnCount < turns.length)
      active.unflushed = { turns: turns.length, fingerprint: contentFingerprint(turns, turns.length) };
    turns = aggregate;
    startTs = turns[0]?.timestamp ?? startTs;
  } else if (cursor?.rollouts || (transcriptPath && cursor?.paths?.some(path => path !== transcriptPath))) {
    throw new Error("A transcript reader is required to preserve contributed rollouts");
  }
  // A "yes" is remembered on the cursor: hook harnesses run a fresh process per Stop, so without it
  // every turn re-asked, and one slow or failed probe turned that turn's append into a full replace
  // (#4560). A "no" is not remembered — the server can be upgraded mid-session.
  const probed = Boolean(cursors) && cursor?.appendSupported !== true;
  const appendSupported =
    Boolean(cursors) && (cursor?.appendSupported === true || (await supportsAppend(client)));
  // Only an append can build on a lost write; a replace already re-sends everything.
  let ops: string[] = [];
  if (appendSupported && cursor?.ops?.length && !cursor.dirty)
    ({ cursor, ops } = await settleOps(client, cursor));
  const plan = planRetain(turns, cursor, {
    appendSupported,
    bank: client.bank,
    path: rollouts ? undefined : transcriptPath,
  });
  // Recorded whenever the probe ran, so a deployment where append never activates shows up in the
  // diag trail instead of only as oversized retains (#5286). A cached "yes" is not re-logged.
  if (probed) diag(harness ?? "", "retain_mode", { mode: plan.mode, appendSupported });
  // Never forget a source that still contributes to the document.
  const paths = rollouts ? rollouts.map(segment => segment.path) :
    plan.mode === "replace"
      ? transcriptPath
        ? [transcriptPath]
        : undefined
      : advancePaths(cursor?.paths, transcriptPath);
  // Appends built but never confirmed. A replace rewrites the whole document from the same
  // transcript, so it SUBSUMES them; on every other path they go out first, oldest first, before
  // anything new — the document only ever grows in transcript order.
  const outbox = plan.mode === "replace" ? [] : (cursor?.pending ?? []);
  if (plan.mode === "skip" && !outbox.length) return;

  /** Identity of ONE payload: a resubmission of the same bytes is collapsed server-side into the
   *  original operation instead of extracting (or appending) twice. */
  const opId = (mode: string, content: string) =>
    uuidV5(`${client.bank}\n${refId}\n${mode}\n${content}`);
  const submit = (content: string, operationId: string, append: boolean) =>
    client.retain(
      content,
      // Configured context wins. Extraction reads this to decide whose claim a sentence is, so the
      // default names both speakers: the previous "coding agent session" said nothing about
      // authorship and let an assistant's proposal be recorded as the user's decision.
      stamp?.context ?? DEFAULT_RETAIN_CONTEXT,
      refId,
      // Configured tags first, built-ins last and deduped: `source:chat` and `harness:<id>` are what
      // the documents list filters and draws its agent logo from, so a template cannot displace them.
      [
        ...new Set([
          ...(stamp?.tags ?? []),
          "source:chat",
          ...(harness ? [`harness:${harness}`] : []),
        ]),
      ],
      "conversation",
      {
        timestamp: startTs,
        updateMode: append ? "append" : undefined,
        operationId,
        metadata: {
          ...stamp?.metadata, // configured first: the built-ins below win on any key collision
          source: "chat",
          session_id: sessionId,
          ref_id: refId,
          ...(harness ? { harness } : {}),
        },
      }
    );

  // The position the cursor reaches once everything below has been applied. On a "skip" this is
  // exactly where the cursor already is: skip means the transcript ends at cursor.turns.
  const next = {
    turns: turns.length,
    fingerprint: fingerprintTurns(turns, turns.length),
    bank: client.bank,
    ...(paths ? { paths } : {}),
    ...(rollouts ? { rollouts } : {}),
    ...(appendSupported ? { appendSupported: true } : {}),
  };
  /** `next` plus the ops to check on the next write-back, with `id` newly accepted. */
  const accepted = (id?: string) => {
    if (id) ops = [...ops, id].slice(-MAX_CURSOR_OPS);
    return ops.length ? { ...next, ops } : next;
  };
  // Still ours to retry only while the cursor holds the claim we write below.
  const stillOurs = () => {
    if (!cursors) return true;
    const now = cursors.read(sessionId);
    return now?.turns === next.turns && now?.fingerprint === next.fingerprint;
  };

  if (plan.mode === "replace") {
    const content = renderSessionJsonl(refId, turns, startTs);
    // Nothing to buffer: replace is idempotent by construction, so a later one re-establishes the
    // same truth from the same transcript. Claim the position unconfirmed so an outcome we never
    // learn resolves to another replace rather than an append onto an unknown state.
    cursors?.write(sessionId, { ...next, dirty: true });
    const operationId = opId("replace", content);
    await submitWithRetry(() => submit(content, operationId, false), stillOurs, retryUntil);
    ops = []; // the replace re-sends every turn, so nothing older can still lose any
    cursors?.write(sessionId, accepted(operationId));
    return;
  }

  const queue = [...outbox];
  if (plan.mode === "append") {
    const content = turns
      .slice(plan.fromTurn)
      .map((t) => JSON.stringify(t))
      .join("\n");
    queue.push({ content, operationId: opId("append", content), at: Date.now() });
  }

  // Claim the position BEFORE the request, WITH the bytes: a rejected retain — or a process the
  // host kills mid-write — leaves a replayable buffer rather than a cursor that can only be
  // recovered by re-sending (and re-extracting) the entire transcript, forever, for the rest of the
  // session (#3989). Replay is safe precisely because the bytes and the operation id are unchanged:
  // a write the server DID commit collapses into that same operation instead of appending twice,
  // which is the one thing appending onto an unknown state could otherwise get wrong.
  cursors?.write(sessionId, { ...accepted(), pending: queue });
  for (let i = 0; i < queue.length; i++) {
    // One request per entry, each able to burn the full 15s abort — where this used to send exactly
    // once. Never START one that cannot finish inside the caller's budget: a hook harness is killed
    // by its host at `retryUntil` (retain-hook's hostDeadline), and a flush that overruns it buys
    // nothing. The first entry always goes out, so a chronically short budget still makes progress;
    // whatever is left is already durable, so the next write-back sends it.
    if (i > 0 && Date.now() + REQUEST_BUDGET_MS > retryUntil) return;
    const entry = queue[i];
    await submitWithRetry(
      () => submit(entry.content, entry.operationId, true),
      stillOurs,
      retryUntil
    );
    // Confirmed: drop it immediately, so a failure on a LATER entry cannot resubmit it as part of
    // the next flush. Whatever is still queued when this throws is what the next flush replays.
    const remaining = queue.slice(i + 1);
    const done = accepted(entry.operationId);
    cursors?.write(sessionId, remaining.length ? { ...done, pending: remaining } : done);
  }
}

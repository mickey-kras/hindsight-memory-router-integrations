/**
 * A per-session conversation journal, for hook harnesses whose HOST keeps no durable transcript.
 *
 * Every other hook harness hands its Stop hook a file holding the whole conversation, which is what
 * the incremental write-back needs: `retainLiveSession` re-reads the FULL transcript each time and
 * lets the retain cursor (core/retain-cursor.ts) send only the turns added since the last write. A
 * host that exposes just the latest reply breaks that contract — the turn list would shrink and
 * reorder between Stops, so every write-back would fingerprint-mismatch and replace.
 *
 * ZCode and TraeCode are such hosts. ZCode's `Stop` payload carries the assistant reply
 * (`responseText`) plus an EPHEMERAL, assistant-only transcript that the agent deletes as soon as
 * the hook returns; TraeCode keeps sessions in an encrypted DB or the cloud and hands Stop only
 * `last_assistant_message`. Neither carries the user prompt. So the plugin keeps the conversation itself — the prompt hook
 * appends the user turn, the Stop hook appends the reply — and the Stop hook then reads this file
 * exactly as the other harnesses read the host's own transcript. Nothing downstream changes.
 *
 * It lives beside the session cache and the retain cursor in the temp dir, in its own file and for
 * the same reason (see core/session-cache.ts): two writers with different lifecycles must not share
 * a record. Losing it costs the un-retained tail of one session, never correctness — a shorter
 * journal simply replaces the document instead of appending to it.
 *
 * Fail-open throughout: a journal that cannot be written or read yields no turns, which is exactly
 * the behaviour of a harness whose transcript file is missing.
 */
import { appendFileSync, constants, fstatSync, readSync } from "node:fs";
import { readPrivateFile, sessionStateFile, withPrivateFile } from "./private-state";
import type { TransportTurn } from "./chat";
import { stripInjectedMemory } from "./transcript-util";

/**
 * Ceiling on one session's journal. Past it the journal stops GROWING rather than being trimmed
 * from the front: dropping the oldest turns would rewrite the prefix the retain cursor fingerprints,
 * turning every later write-back into a full replace of a conversation already too large to resend.
 */
export const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/** The journal file for one session. Same directory as the session cache and the retain cursor. */
export function journalPath(harness: string, sessionId: string | undefined): string {
  return sessionStateFile(harness, sessionId || "no-session", ".journal.jsonl");
}

/**
 * Append one turn, unless it is empty or repeats the turn already at the end of the journal.
 *
 * The dedupe is load-bearing rather than tidy: a host may deliver Stop more than once for the same
 * reply (ZCode fires it again after a cancelled continuation), and the same text appended twice
 * would be retained as two assistant turns that never happened.
 */
export function appendJournalTurn(path: string, turn: TransportTurn): void {
  const content = stripInjectedMemory(turn.content ?? "").trim();
  if (!content) return;
  try {
    withPrivateFile(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, (fd) => {
      const size = fstatSync(fd).size;
      if (size >= JOURNAL_MAX_BYTES) return;
      const { last, terminated } = readJournalTail(fd, size);
      if (last && last.role === turn.role && last.content === content) return;
      const record: string = (terminated ? "" : "\n") + JSON.stringify({
        role: turn.role,
        content,
        timestamp: turn.timestamp ?? new Date().toISOString(),
      }) + "\n";
      if (size + Buffer.byteLength(record, "utf8") > JOURNAL_MAX_BYTES) return;
      appendFileSync(fd, record);
    });
  } catch {
    /* best-effort: an unwritable journal costs the tail of one session, never an error */
  }
}

/** Read a journal back into normalized turns — the `TranscriptReader` shape retain-hook expects. */
export function readJournalTranscript(path: string): TransportTurn[] {
  let body: string;
  try {
    body = readPrivateFile(path);
  } catch {
    return [];
  }
  return parseJournalTranscript(body);
}

// Read backwards in fixed chunks; retain only the current candidate record.
// A long or malformed suffix may require more chunks, never a whole-file parse.
function readJournalTail(fd: number, size: number): { last?: TransportTurn; terminated: boolean } {
  let position = size;
  let fragments: Buffer[] = [];
  let terminated = size === 0;
  while (position > 0) {
    const length = Math.min(position, 64 * 1024);
    position -= length;
    const buffer = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const count = readSync(fd, buffer, received, length - received, position + received);
      if (count === 0) throw new Error("Journal changed during tail read");
      received += count;
    }
    if (position + length === size) terminated = buffer[length - 1] === 10;
    let end = length;
    for (let index = length - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      fragments.push(buffer.subarray(index + 1, end));
      const last = parseJournalTurn(Buffer.concat(fragments.reverse()).toString("utf8"));
      if (last) return { last, terminated };
      fragments = [];
      end = index;
    }
    fragments.push(buffer.subarray(0, end));
  }
  return { last: parseJournalTurn(Buffer.concat(fragments.reverse()).toString("utf8")), terminated };
}

function parseJournalTurn(line: string): TransportTurn | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { role, content, timestamp } = parsed as Record<string, unknown>;
  if (typeof role !== "string" || typeof content !== "string" || !content) return undefined;
  return { role, content, ...(typeof timestamp === "string" ? { timestamp } : {}) };
}

function parseJournalTranscript(body: string): TransportTurn[] {
  const turns: TransportTurn[] = [];
  for (const line of body.split("\n")) {
    const turn = parseJournalTurn(line);
    if (turn) turns.push(turn);
  }
  return turns;
}

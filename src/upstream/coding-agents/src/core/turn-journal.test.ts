import { mkdtempSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionCacheFile } from "./session-cache";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendJournalTurn, JOURNAL_MAX_BYTES, journalPath, readJournalTranscript } from "./turn-journal";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hs-journal-"));
  file = join(root, "session.journal.jsonl");
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("journalPath", () => {
  it("keeps each session in its own file, beside the session cache", () => {
    expect(journalPath("zcode", "sess-1")).toBe(
      join(dirname(sessionCacheFile("zcode", "sess-1")), "sess-1.journal.jsonl")
    );
    expect(journalPath("zcode", "sess-2")).not.toBe(journalPath("zcode", "sess-1"));
  });

  it("falls back to a fixed name when the host sent no session id", () => {
    expect(journalPath("zcode", undefined)).toBe(
      join(dirname(sessionCacheFile("zcode", "sess-1")), "no-session.journal.jsonl")
    );
  });
});

describe("appendJournalTurn", () => {
  it("builds the conversation in order across separate hook processes", () => {
    appendJournalTurn(file, { role: "user", content: "we use zod for validation" });
    appendJournalTurn(file, { role: "assistant", content: "noted" });
    appendJournalTurn(file, { role: "user", content: "and pytest-xdist" });

    expect(readJournalTranscript(file).map((t) => [t.role, t.content])).toEqual([
      ["user", "we use zod for validation"],
      ["assistant", "noted"],
      ["user", "and pytest-xdist"],
    ]);
  });

  it("stamps a timestamp when the caller supplies none, and keeps one that is supplied", () => {
    appendJournalTurn(file, { role: "user", content: "a", timestamp: "2026-01-01T00:00:00Z" });
    appendJournalTurn(file, { role: "assistant", content: "b" });
    const [first, second] = readJournalTranscript(file);
    expect(first.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(Date.parse(second.timestamp!)).not.toBeNaN();
  });

  /** A host can deliver Stop twice for one reply; the same text twice is two turns that never
   *  happened, and the retain cursor would then append the duplicate to the bank. */
  it("ignores a turn that repeats the one already at the end", () => {
    appendJournalTurn(file, { role: "assistant", content: "done" });
    appendJournalTurn(file, { role: "assistant", content: "done" });
    expect(readJournalTranscript(file)).toHaveLength(1);
  });

  it("still records the same text when the other speaker says it, or when it recurs later", () => {
    appendJournalTurn(file, { role: "user", content: "ship it" });
    appendJournalTurn(file, { role: "assistant", content: "ship it" });
    appendJournalTurn(file, { role: "user", content: "ship it" });
    expect(readJournalTranscript(file)).toHaveLength(3);
  });

  it("drops empty and whitespace-only turns rather than writing a blank line", () => {
    appendJournalTurn(file, { role: "assistant", content: "" });
    appendJournalTurn(file, { role: "assistant", content: "   \n " });
    expect(readJournalTranscript(file)).toEqual([]);
  });

  /** Without this the recall injected on turn N would be retained as the user's own words on turn
   *  N, and recalled again on turn N+1 — the feedback loop stripInjectedMemory exists to break. */
  it("strips injected memory before it can be written back", () => {
    appendJournalTurn(file, {
      role: "assistant",
      content: "done <hindsight_memories>recalled fact</hindsight_memories>",
    });
    expect(readJournalTranscript(file)).toEqual([
      expect.objectContaining({ role: "assistant", content: "done" }),
    ]);
  });

  it("creates the harness directory on the first turn of a session", () => {
    const nested = journalPath("zcode-test-harness", `sess-${Date.now()}`);
    try {
      appendJournalTurn(nested, { role: "user", content: "hello" });
      expect(readJournalTranscript(nested)).toHaveLength(1);
    } finally {
      rmSync(nested, { force: true });
    }
  });
});

describe("readJournalTranscript", () => {
  it("returns nothing for a journal that does not exist", () => {
    expect(readJournalTranscript(join(root, "absent.jsonl"))).toEqual([]);
  });

  /** A process killed mid-append leaves a torn final line. That costs its own turn, never the
   *  session — the whole conversation before it is still retainable. */
  it("keeps every complete turn before a torn final line", () => {
    writeFileSync(
      file,
      `${JSON.stringify({ role: "user", content: "first" })}\n{"role":"assistant","cont`
    );
    expect(readJournalTranscript(file)).toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
    ]);
  });

  it("skips lines that parse to something other than a turn", () => {
    writeFileSync(
      file,
      ["null", "42", '["user","hi"]', '{"role":"user"}', '{"content":"no role"}', ""].join("\n") +
        "\n" +
        JSON.stringify({ role: "user", content: "real" })
    );
    expect(readJournalTranscript(file)).toEqual([
      expect.objectContaining({ role: "user", content: "real" }),
    ]);
  });

  it("round-trips content with newlines and quotes", () => {
    const content = 'line one\nline "two"\ttabbed';
    appendJournalTurn(file, { role: "user", content });
    expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1);
    expect(readJournalTranscript(file)[0].content).toBe(content);
  });
});

describe("journal tail I/O", () => {
  it("reads one bounded chunk when appending to a multi-megabyte journal", () => {
    const line = JSON.stringify({ role: "user", content: "x".repeat(1024) }) + "\n";
    writeFileSync(file, line.repeat(6000));
    appendJournalTurn(file, { role: "assistant", content: "new tail" });
    expect(readSync).toHaveBeenCalledTimes(1);
    expect(readSync).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 64 * 1024, expect.any(Number));
    expect(readJournalTranscript(file).at(-1)?.content).toBe("new tail");
  });

  it.each(["", "\n", "\nnot-json\nnull\n{\"role\":\"user\"}\n  "])(
    "deduplicates a long Unicode turn across chunk boundaries and invalid suffix %j",
    (suffix) => {
      const content = "🙂漢é".repeat(30000);
      const body = JSON.stringify({ role: "assistant", content }) + suffix;
      writeFileSync(file, body);
      appendJournalTurn(file, { role: "assistant", content });
      expect(readFileSync(file, "utf8")).toBe(body);
      expect(readJournalTranscript(file)).toHaveLength(1);
    },
  );

  it("scans past an arbitrarily long torn record and preserves the next complete append", () => {
    const original = JSON.stringify({ role: "user", content: "valid" }) + "\n";
    const torn = '{"role":"assistant","content":"' + "x".repeat(200000);
    writeFileSync(file, original + torn);
    appendJournalTurn(file, { role: "user", content: "valid" });
    expect(readFileSync(file, "utf8")).toBe(original + torn);
    appendJournalTurn(file, { role: "assistant", content: "recovered" });
    expect(readJournalTranscript(file).map((turn) => turn.content)).toEqual(["valid", "recovered"]);
    expect(readFileSync(file, "utf8").startsWith(original + torn + "\n")).toBe(true);
  });

  it("separates a complete unterminated record from a different appended turn", () => {
    writeFileSync(file, JSON.stringify({ role: "user", content: "first" }));
    appendJournalTurn(file, { role: "assistant", content: "second" });
    expect(readJournalTranscript(file).map((turn) => turn.content)).toEqual(["first", "second"]);
  });

  it("keeps full transcript reads sensitive to edits before the tail", () => {
    const first = JSON.stringify({ role: "user", content: "original" }) + "\n";
    const tail = (JSON.stringify({ role: "assistant", content: "x".repeat(1024) }) + "\n").repeat(200);
    writeFileSync(file, first + tail);
    expect(readJournalTranscript(file)[0].content).toBe("original");
    writeFileSync(file, first.replace("original", "modified") + tail);
    expect(readJournalTranscript(file)[0].content).toBe("modified");
  });
});

describe("journal byte ceiling", () => {
  const turn = { role: "assistant", content: "🙂漢é\u0000\n\"\\", timestamp: "2026-01-01T00:00:00Z" };
  const record: string = JSON.stringify(turn) + "\n";

  function seedJournal(bytes: number, terminated: boolean): Buffer {
    const tail: string = JSON.stringify({ role: "user", content: "previous" }) + (terminated ? "\n" : "");
    const original: Buffer = Buffer.from("x".repeat(bytes - Buffer.byteLength(tail) - 1) + "\n" + tail);
    writeFileSync(file, original);
    return original;
  }

  it.each([true, false])("allows an exact UTF-8 byte fit with terminated=%s", (terminated) => {
    const append: string = (terminated ? "" : "\n") + record;
    const original: Buffer = seedJournal(JOURNAL_MAX_BYTES - Buffer.byteLength(append), terminated);
    appendJournalTurn(file, turn);
    expect(readFileSync(file).equals(Buffer.concat([original, Buffer.from(append)]))).toBe(true);
    expect(readFileSync(file).length).toBe(JOURNAL_MAX_BYTES);
    expect(readJournalTranscript(file).at(-1)).toEqual(turn);
  });

  it.each([true, false])("preserves every byte when the append overflows by one with terminated=%s", (terminated) => {
    const append: string = (terminated ? "" : "\n") + record;
    const original: Buffer = seedJournal(JOURNAL_MAX_BYTES - Buffer.byteLength(append) + 1, terminated);
    expect(() => appendJournalTurn(file, turn)).not.toThrow();
    expect(readFileSync(file).equals(original)).toBe(true);
  });

  it("rejects JSON escaping that makes a single turn larger than the ceiling", () => {
    appendJournalTurn(file, { role: "user", content: "previous" });
    const original: Buffer = readFileSync(file);
    expect(() => appendJournalTurn(file, { role: "assistant", content: "\u0000".repeat(2 * 1024 * 1024) })).not.toThrow();
    expect(readFileSync(file).equals(original)).toBe(true);
  });

  it.each([0, 1])("accounts for a torn-tail separator with %s bytes of overflow", (overflow) => {
    const torn: string = '{"role":"assistant","content":"';
    const original: Buffer = Buffer.from("x".repeat(JOURNAL_MAX_BYTES - Buffer.byteLength(record) - torn.length - 1 + overflow) + torn);
    writeFileSync(file, original);
    appendJournalTurn(file, turn);
    const expected: Buffer = overflow ? original : Buffer.concat([original, Buffer.from("\n" + record)]);
    expect(readFileSync(file).equals(expected)).toBe(true);
  });
});

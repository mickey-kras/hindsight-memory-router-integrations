import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPrivateFile, sessionStateFile, writePrivateFileAtomic } from "./private-state";
import { fileCursorStore, sessionCacheFile, writeSessionCache } from "./session-cache";
import { appendJournalTurn, journalPath, readJournalTranscript } from "./turn-journal";

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }));

const directories: string[] = [];
function harness(): string {
  const name = `private-state-test-${randomUUID()}`;
  directories.push(dirname(sessionCacheFile(name, "session")), join(tmpdir(), `hindsight-${name}`));
  return name;
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "private-state-test-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("private session state", () => {
  it("stores buffered transcript bytes and journals in an owner-only per-user directory", () => {
    const name = harness();
    const pending = [{ content: "private prompt", operationId: "op", at: 1 }];
    fileCursorStore(name).write("session", { bank: "A", turns: 1, fingerprint: "f", pending });
    const cursor = sessionStateFile(name, "session", ".retain.json");
    const journal = journalPath(name, "session");
    appendJournalTurn(journal, { role: "assistant", content: "private reply" });

    expect(dirname(cursor)).toContain(`hindsight-${process.geteuid?.()}-`);
    expect(fs.statSync(dirname(cursor)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cursor).mode & 0o777).toBe(0o600);
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
    expect(fileCursorStore(name).read("session")?.pending).toEqual(pending);
    expect(readJournalTranscript(journal)[0].content).toBe("private reply");
  });

  it("keeps atomic temporary files private before they become visible as cursors", () => {
    const file = join(temporaryDirectory(), "cursor.json");
    const rename = fs.renameSync;
    const atomicModes: number[] = [];
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      atomicModes.push(fs.statSync(from).mode & 0o777);
      rename(from, to);
    });
    writePrivateFileAtomic(file, "first");
    writePrivateFileAtomic(file, "second");
    expect(atomicModes).toEqual([0o600, 0o600]);
    expect(fs.readdirSync(dirname(file))).toEqual(["cursor.json"]);
    expect(readPrivateFile(file)).toBe("second");
  });

  it("migrates an owned permissive legacy directory without dropping the conversation", () => {
    const name = harness();
    const legacy = join(tmpdir(), `hindsight-${name}`);
    fs.mkdirSync(legacy, { mode: 0o755 });
    fs.writeFileSync(join(legacy, "session.journal.jsonl"), '{"role":"user","content":"before upgrade"}\n', { mode: 0o644 });
    fs.writeFileSync(join(legacy, "session.retain.json"), '{"bank":"A","turns":1,"fingerprint":"f"}', { mode: 0o644 });

    const journal = journalPath(name, "session");
    appendJournalTurn(journal, { role: "assistant", content: "after upgrade" });
    expect(readJournalTranscript(journal).map((turn) => turn.content)).toEqual(["before upgrade", "after upgrade"]);
    expect(fileCursorStore(name).read("session")?.turns).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.statSync(dirname(journal)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sessionStateFile(name, "session", ".retain.json")).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing destination directory and journal before appending", () => {
    const file = join(temporaryDirectory(), "journal.jsonl");
    fs.chmodSync(dirname(file), 0o777);
    fs.writeFileSync(file, '{"role":"user","content":"first"}\n', { mode: 0o666 });
    fs.chmodSync(file, 0o666);
    appendJournalTurn(file, { role: "assistant", content: "second" });
    expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readJournalTranscript(file)).toHaveLength(2);
  });

  it.each(["symbolic", "hard"])("does not read or modify a %s-linked transcript target", (kind) => {
    const root = temporaryDirectory();
    const target = join(root, "target");
    const file = join(root, "journal.jsonl");
    const body = '{"role":"user","content":"other file"}\n';
    fs.writeFileSync(target, body);
    if (kind === "symbolic") fs.symlinkSync(target, file);
    else fs.linkSync(target, file);
    appendJournalTurn(file, { role: "assistant", content: "must not write" });
    writeSessionCache(file, { turns: 9 });
    expect(readJournalTranscript(file)).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe(body);
  });

  it("rejects a symlinked session directory without changing its target", () => {
    const name = harness();
    const target = temporaryDirectory();
    const file = sessionCacheFile(name, "session");
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, dirname(file));
    fileCursorStore(name).write("session", { bank: "A", turns: 1, fingerprint: "f" });
    appendJournalTurn(journalPath(name, "session"), { role: "user", content: "must not write" });
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("ignores a symlinked legacy directory and creates private new state", () => {
    const name = harness();
    const target = temporaryDirectory();
    const legacy = join(tmpdir(), `hindsight-${name}`);
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, legacy);
    const journal = journalPath(name, "session");
    appendJournalTurn(journal, { role: "user", content: "private" });
    expect(readJournalTranscript(journal)[0].content).toBe("private");
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it("rejects a session directory owned by another user", () => {
    const file = join(temporaryDirectory(), "journal.jsonl");
    const currentUid = process.geteuid?.() ?? 0;
    vi.spyOn(process, "geteuid").mockReturnValue(currentUid + 1);
    appendJournalTurn(file, { role: "user", content: "must not write" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects foreign-owned files inside an otherwise owned directory", () => {
    const file = join(temporaryDirectory(), "journal.jsonl");
    const content = '{"role":"user","content":"foreign state"}\n';
    fs.writeFileSync(file, content, { mode: 0o644 });
    const fstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
      const stat = fstat(fd);
      if (stat.isFile()) stat.uid += 1;
      return stat;
    });
    appendJournalTurn(file, { role: "assistant", content: "must not write" });
    expect(readJournalTranscript(file)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it("keeps slash-bearing identities inside their directory and distinct from encoded identities", () => {
    const name = harness();
    const escaped = sessionCacheFile(name, "../../other-user");
    expect(dirname(escaped)).toBe(dirname(sessionCacheFile(name, "session")));
    expect(escaped).not.toBe(sessionCacheFile(name, "..%2F..%2Fother-user"));
  });
});

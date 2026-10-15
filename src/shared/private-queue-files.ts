import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

function assertPlatform(): void {
  if ((process.platform !== "linux" && process.platform !== "darwin") || !process.geteuid) {
    throw new Error("Private retain queues require Linux or macOS POSIX file permissions");
  }
}

function assertOwned(info: Stats): void {
  if (info.uid !== process.geteuid?.()) throw new Error("Retain queue path belongs to another user");
}

function assertTrustedAncestors(path: string): void {
  for (let parent = path; ; parent = dirname(parent)) {
    const entry = lstatSync(parent, { throwIfNoEntry: false });
    if (entry) {
      const owned = entry.uid === process.geteuid?.() || entry.uid === 0;
      if (!owned) throw new Error("Retain queue requires trusted parent directories");
      if (entry.isSymbolicLink()) {
        // Root-owned system aliases (for example macOS /var) are supported,
        // but their resolved ancestor permissions must also be trusted.
        assertTrustedAncestors(realpathSync(parent));
      } else if ((entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0) {
        throw new Error("Retain queue requires trusted parent directories");
      }
    }
    if (dirname(parent) === parent) break;
  }
}

/** Tighten legacy paths before opening any payload or lock inside them. */
export function privateQueueDirectory(path: string, create = false): void {
  assertPlatform();
  // Parent directories must not let a different user replace the private leaf.
  assertTrustedAncestors(dirname(path));
  if (create) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    assertTrustedAncestors(dirname(path));
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    assertOwned(info);
    if (!info.isDirectory()) throw new Error("Retain queue requires a directory");
    if ((info.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/** Caller owns the returned descriptor, including across awaited OS locks. */
export function openPrivateQueueFile(path: string, flags: number): number {
  privateQueueDirectory(dirname(path));
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = fstatSync(fd);
    assertOwned(info);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Retain queue requires a singly linked regular file");
    if ((info.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function isMissingQueueFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function removePrivateQueueFile(path: string): void {
  let fd: number;
  try {
    fd = openPrivateQueueFile(path, constants.O_RDONLY);
  } catch (error) {
    if (isMissingQueueFile(error)) return;
    throw error;
  }
  try {
    unlinkSync(path);
  } finally {
    closeSync(fd);
  }
}

export function writePrivateQueueFile(path: string, body: string): void {
  // Validate the destination even when replacing it. No destructive open flags.
  try {
    closeSync(openPrivateQueueFile(path, constants.O_RDONLY));
  } catch (error) {
    if (!isMissingQueueFile(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openPrivateQueueFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    writeFileSync(fd, body, "utf8");
    renameSync(temporary, path);
  } finally {
    closeSync(fd);
    removePrivateQueueFile(temporary);
  }
}

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

function assertOwned(stat: Stats): void {
  const uid = process.geteuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error("Session state belongs to another user");
}

function privateDirectory(path: string, create = true): void {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const directory = lstatSync(path);
  if (!directory.isDirectory()) throw new Error("Session state requires a directory");
  assertOwned(directory);
  if (process.platform === "win32") {
    chmodSync(path, 0o700);
    return;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assertOwned(stat);
    if (!stat.isDirectory()) throw new Error("Session state requires a directory");
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

export function sessionStateFile(harness: string, sessionId: string, suffix: string): string {
  const user = process.geteuid?.() ?? createHash("sha256").update(homedir()).digest("hex");
  const directory = join(tmpdir(), `hindsight-${user}-${encodeURIComponent(harness)}`);
  if (!/[\\/]/.test(harness)) {
    const legacy = join(tmpdir(), `hindsight-${harness}`);
    try {
      privateDirectory(legacy, false);
      if (!existsSync(directory)) renameSync(legacy, directory);
    } catch {
      // Unowned legacy paths are never followed or migrated.
    }
  }
  return join(directory, `${encodeURIComponent(sessionId)}${suffix}`);
}

function assertPrivateFile(stat: Stats): void {
  assertOwned(stat);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Session state requires a singly linked regular file");
}

export function withPrivateFile<T>(path: string, flags: number, action: (fd: number) => T): T {
  privateDirectory(dirname(path));
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Session file cannot be a symlink");
  }
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    assertPrivateFile(fstatSync(fd));
    fchmodSync(fd, 0o600);
    return action(fd);
  } finally {
    closeSync(fd);
  }
}

export function readPrivateFile(path: string): string {
  return withPrivateFile(path, constants.O_RDONLY, (fd) => readFileSync(fd, "utf8"));
}

export function writePrivateFileAtomic(path: string, body: string): void {
  privateDirectory(dirname(path));
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing) assertPrivateFile(existing);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      writeFileSync(fd, body);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    if (created) rmSync(temporary, { force: true });
  }
}

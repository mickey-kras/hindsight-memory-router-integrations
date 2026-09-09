import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function listFiles(root, ignoredDirectories = new Set()) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(name)) visit(path);
      } else if (entry.isFile()) {
        files.push(name);
      }
    }
  }
  visit(root);
  return files.sort();
}

export function assertExactFileSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((file) => !expectedSet.has(file));
  const missing = expected.filter((file) => !actualSet.has(file));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} file set drift` +
        `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""}` +
        `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`,
    );
  }
}

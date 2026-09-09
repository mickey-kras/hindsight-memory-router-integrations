import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { assertExactFileSet, listFiles } from "./verify-vendored-files.mjs";

const root = new URL("../integrations/coding-agents/", import.meta.url);
const upstream = JSON.parse(readFileSync(new URL("UPSTREAM.json", root), "utf8"));
const changes = JSON.parse(readFileSync(new URL("LOCAL_CHANGES.json", root), "utf8"));
const expectedFiles = {
  ...upstream.files,
  ...changes,
};
const sourceRoot = new URL("../../src/upstream/coding-agents/", root);
assertExactFileSet(
  listFiles(sourceRoot.pathname, new Set(["dist", "node_modules"])),
  Object.entries(expectedFiles)
    .filter(([, hash]) => hash !== null)
    .map(([file]) => file)
    .sort(),
  "coding-agents source",
);
for (const [file, expected] of Object.entries(expectedFiles)) {
  if (expected === null) {
    if (existsSync(new URL(file, sourceRoot))) throw new Error(`removed upstream file restored: ${file}`);
    continue;
  }
  const actual = createHash("sha256")
    .update(readFileSync(new URL(file, sourceRoot)))
    .digest("hex");
  if (actual !== expected) throw new Error(`coding-agents source drift: ${file}`);
}
console.log(`Verified upstream ${upstream.commit} with ${Object.keys(changes).length} adapted files`);

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { listFiles } from "./verify-vendored-files.mjs";

const root = new URL("../integrations/coding-agents/", import.meta.url);
const sourceRoot = new URL("../src/upstream/coding-agents/", import.meta.url);
const upstream = JSON.parse(readFileSync(new URL("UPSTREAM.json", root), "utf8"));
const onDisk = listFiles(sourceRoot.pathname, new Set(["dist", "node_modules"]));
const hash = (path) =>
  createHash("sha256")
    .update(readFileSync(new URL(path, sourceRoot)))
    .digest("hex");
const changes = {};
for (const file of onDisk) {
  const digest = hash(file);
  if (upstream.files[file] !== digest) changes[file] = digest;
}
for (const file of Object.keys(upstream.files)) {
  if (!onDisk.includes(file)) changes[file] = null;
}
const sorted = Object.fromEntries(Object.entries(changes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
writeFileSync(new URL("LOCAL_CHANGES.json", root), `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`Accepted ${onDisk.length} files, ${Object.keys(sorted).length} adapted`);

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExactFileSet, listFiles } from "./verify-vendored-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "integrations/openclaw/LOCAL_CHANGES.json"), "utf8"));
const pristine = Object.fromEntries(
  readFileSync(join(root, "src/upstream/SHA256SUMS"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, path] = line.split(/ {2}/);
      return [path.replace(/^\.\//, ""), hash];
    }),
);
const vendoredPristine = JSON.parse(
  readFileSync(join(root, "integrations/openclaw/VENDORED_PRISTINE_FILES.json"), "utf8"),
);
const expectedFiles = [...Object.keys(manifest), ...vendoredPristine].sort();
assertExactFileSet(
  listFiles(join(root, "src/upstream"), new Set(["coding-agents"])).filter((path) => path !== "SHA256SUMS"),
  expectedFiles,
  "OpenClaw source",
);
for (const path of vendoredPristine) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, "src/upstream", path)))
    .digest("hex");
  if (actual !== pristine[path]) throw new Error(`${path}: pristine OpenClaw file differs from SHA256SUMS`);
}
for (const [path, expected] of Object.entries(manifest)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, "src/upstream", path)))
    .digest("hex");
  if (actual !== expected) throw new Error(`${path}: adapted OpenClaw file differs from LOCAL_CHANGES.json`);
}

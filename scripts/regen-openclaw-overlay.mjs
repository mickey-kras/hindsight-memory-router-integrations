import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [
  "src/retain-queue.ts",
  "src/session-patterns.ts",
  "src/types.ts",
];
const manifest = Object.fromEntries(
  paths.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(root, "src/upstream", path)))
      .digest("hex"),
  ]),
);
writeFileSync(
  join(root, "integrations/openclaw/LOCAL_CHANGES.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

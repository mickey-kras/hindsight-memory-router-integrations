import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(root, "integrations/openclaw/LOCAL_CHANGES.json"), "utf8"),
);
for (const [path, expected] of Object.entries(manifest)) {
  const actual = createHash("sha256")
    .update(readFileSync(join(root, "src/upstream", path)))
    .digest("hex");
  if (actual !== expected)
    throw new Error(
      `${path}: adapted OpenClaw file differs from LOCAL_CHANGES.json`,
    );
}

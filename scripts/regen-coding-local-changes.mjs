import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const manifestUrl = new URL(
  "../integrations/coding-agents/LOCAL_CHANGES.json",
  import.meta.url,
);
const sourceRoot = new URL("../src/upstream/coding-agents/", import.meta.url);
const current = JSON.parse(readFileSync(manifestUrl, "utf8"));
const refreshed = Object.fromEntries(
  Object.entries(current).map(([path, expected]) => [
    path,
    expected === null
      ? null
      : createHash("sha256")
          .update(readFileSync(new URL(path, sourceRoot)))
          .digest("hex"),
  ]),
);
writeFileSync(manifestUrl, `${JSON.stringify(refreshed, null, 2)}\n`);

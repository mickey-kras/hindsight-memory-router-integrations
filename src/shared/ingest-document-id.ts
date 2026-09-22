import { createHash } from "node:crypto";

export function ingestDocumentId(title: string): string {
  return `ingest--${createHash("sha256").update(JSON.stringify(title)).digest("hex")}`;
}

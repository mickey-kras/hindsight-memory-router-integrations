import assert from "node:assert/strict";
import test from "node:test";
import { assertExactFileSet } from "./verify-vendored-files.mjs";

test("rejects unexpected and missing vendored files", () => {
  assert.throws(
    () => assertExactFileSet(["a", "injected"], ["a", "missing"], "fixture"),
    /fixture file set drift; unexpected: injected; missing: missing/,
  );
});

test("accepts the exact vendored file set regardless of order", () => {
  assert.doesNotThrow(() => assertExactFileSet(["b", "a"], ["a", "b"], "fixture"));
});

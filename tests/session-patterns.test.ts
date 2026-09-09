import { expect, it } from "vitest";
import { compileSessionPattern } from "../src/upstream/src/session-patterns.js";

it("distinguishes single and double wildcards and escapes regex metacharacters", () => {
  expect(compileSessionPattern("agent:*:task").test("agent:one:task")).toBe(true);
  expect(compileSessionPattern("agent:*:task").test("agent:one:two:task")).toBe(false);
  expect(compileSessionPattern("agent:**:task").test("agent:one:two:task")).toBe(true);
  expect(compileSessionPattern("agent:[a].(b)+").test("agent:[a].(b)+")).toBe(true);
  expect(compileSessionPattern("agent:[a].(b)+").test("agent:axb")).toBe(false);
});

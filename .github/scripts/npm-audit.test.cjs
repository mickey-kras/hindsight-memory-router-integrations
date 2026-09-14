const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findings } = require("./npm-audit.cjs");

test("returns every other moderate or higher vulnerability", () => {
  const hono = { severity: "high", fixAvailable: true, via: [] };
  assert.deepEqual(findings({ vulnerabilities: { hono } }), [["hono", hono]]);
});

test("returns inherited moderate vulnerabilities without exceptions", () => {
  const admZip = { severity: "moderate", isDirect: false, effects: ["aislop"] };
  assert.deepEqual(findings({ vulnerabilities: { "adm-zip": admZip } }), [["adm-zip", admZip]]);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate: evaluateReport } = require("./audit.cjs");
const lock = {
  packages: Object.fromEntries(
    Object.entries({ aislop: "0.16.1", micromatch: "4.0.8", braces: "3.0.3" }).map(([name, version]) => [
      `node_modules/${name}`,
      { version },
    ]),
  ),
};
const evaluate = (result, config) => evaluateReport(result, config, lock);
const config = require("./audit-ci.json");
const baseline = require("./audit-fixture.json");
const result = (report) => ({ status: 1, stdout: JSON.stringify(report) });

test("approved exact path passes while findings remain in the report", () => {
  assert.deepEqual(evaluate(result(baseline), config), baseline);
});
test("expired exception fails", () => {
  const expired = structuredClone(config);
  Object.values(expired.allowlist[0])[0].expiry = "2000-01-01T00:00:00Z";
  assert.throws(() => evaluate(result(baseline), expired));
});
test("invalid or incomplete process and audit evidence fails closed", () => {
  for (const item of [
    { status: 0, stdout: "{}" },
    { status: 1, stdout: "{}" },
    { status: 1, stdout: "invalid" },
    { ...result(baseline), status: 2 },
    { ...result(baseline), status: 0 },
    { ...result(baseline), signal: "SIGTERM" },
    { ...result(baseline), error: new Error("spawn failed") },
  ])
    assert.throws(() => evaluate(item, config));
  for (const mutate of [
    (report) => {
      report.error = { code: "ENOAUDIT" };
    },
    (report) => {
      delete report.metadata;
    },
    (report) => {
      report.metadata.vulnerabilities.high = 0;
    },
    (report) => {
      report.vulnerabilities.braces.via = [];
    },
    (report) => {
      report.vulnerabilities.braces.via[0].url += "-other";
    },
    (report) => {
      report.vulnerabilities.braces.nodes.push("node_modules/other/node_modules/braces");
    },
    (report) => {
      report.vulnerabilities.micromatch.effects.push("other");
    },
    (report) => {
      report.vulnerabilities.aislop.via.push("braces");
    },
    (report) => {
      report.vulnerabilities.braces.severity = "low";
      report.metadata.vulnerabilities.high--;
      report.metadata.vulnerabilities.low++;
    },
  ]) {
    const report = structuredClone(baseline);
    mutate(report);
    assert.throws(() => evaluate(result(report), config));
  }
});
test("an additional moderate vulnerability is blocked", () => {
  const report = structuredClone(baseline);
  report.vulnerabilities.other = {
    ...structuredClone(report.vulnerabilities.braces),
    name: "other",
    severity: "moderate",
  };
  report.vulnerabilities.other.via[0].severity = "moderate";
  report.metadata.vulnerabilities.moderate++;
  report.metadata.vulnerabilities.total++;
  assert.throws(() => evaluate(result(report), config));
});
test("a clean valid audit succeeds", () => {
  const report = structuredClone(baseline);
  report.vulnerabilities = {};
  for (const key of Object.keys(report.metadata.vulnerabilities)) report.metadata.vulnerabilities[key] = 0;
  assert.deepEqual(evaluate({ status: 0, stdout: JSON.stringify(report) }, config), report);
});

test("exception cannot transfer to another dependency version", () => {
  const updated = structuredClone(lock);
  updated.packages["node_modules/aislop"].version = "0.17.0";
  assert.throws(() => evaluateReport(result(baseline), config, updated));
  assert.throws(() => evaluateReport(result(baseline), config));
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { coverageIdentity, coverageDigest, verifyCoverage } = require("./coverage-artifact.cjs");

const env = { COVERAGE_SHA: "a".repeat(40), GITHUB_RUN_ID: "123" };
const report = "SF:src/plugin.ts\nDA:1,1\nend_of_record\n";
const manifest = { ...coverageIdentity(env), sha256: coverageDigest(report) };

test("coverage is reusable only for the successful source and workflow run", () => {
  verifyCoverage(manifest, report, env);
  for (const changed of [
    { ...env, COVERAGE_SHA: "b".repeat(40) },
    { ...env, GITHUB_RUN_ID: "124" },
    { ...env, GITHUB_RUN_ID: "" },
    { ...env, COVERAGE_SHA: "main" },
  ]) {
    assert.throws(() => verifyCoverage(manifest, report, changed));
  }
});

test("missing metadata, empty reports and changed coverage fail closed", () => {
  assert.throws(() => verifyCoverage({}, report, env));
  assert.throws(() => verifyCoverage(manifest, "", env));
  assert.throws(() => verifyCoverage(manifest, report.replace("DA:1,1", "DA:1,0"), env));
});
